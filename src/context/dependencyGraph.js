"use strict";

// Build a cross-object dependency graph for one package.
//
// Phase 2 ships only OUTBOUND (parse-driven, free) edges. Inbound where-used
// edges via SAP's /usageReferences endpoint land in Phase 4 behind the
// `--with-where-used` flag.
//
// Edge kinds emitted in Phase 2:
//   - inheritsFrom   (class A → class B)        — from skeleton
//   - implements     (class A → interface I)    — from skeleton
//   - callFunction   (file → function module)   — from AST (CALL FUNCTION)
//   - instantiates   (file → class)             — from AST (CREATE OBJECT, NEW)
//   - readsTable     (file → DDIC table)        — from AST (SELECT)
//   - includes       (file → include)           — from AST (INCLUDE)
//
// Node id format: "<TYPE>:<NAME_UPPER>".
//   TYPE ∈ { CLAS, INTF, PROG, FUGR, INCL, FUNC, TABL, UNKN }.
// FUNC and TABL nodes typically point OUTSIDE the package — that's fine;
// the LLM should see what we lean on. Such nodes are added with
// `external: true` so the writer can distinguish.
//
// The module intentionally uses concatTokens()-based regex for name
// extraction rather than reaching into specific Expression AST classes. This
// is robust across abaplint releases (less coupling to internal AST shapes)
// and easily extended.

const log = require("../logger");

let abaplint;
try {
  abaplint = require("@abaplint/core");
} catch (e) {
  // Should never happen since other modules require it too. Guard so this
  // file loads in isolation for unit-test scenarios.
  log.warn(`dependencyGraph: @abaplint/core unavailable (${e.message})`);
}

// Extract the (typeId, name) pair from an abapGit-style filename.
// Returns null if the filename does not match a known pattern.
function _identifyFile(filename) {
  if (!filename) return null;
  const lower = String(filename).toLowerCase();
  // class includes: zcl_foo.clas.abap, zcl_foo.clas.locals_def.abap, ...
  let m = lower.match(/^([\w#$/]+)\.clas\b/);
  if (m) return { type: "CLAS", name: m[1].toUpperCase() };
  m = lower.match(/^([\w#$/]+)\.intf\b/);
  if (m) return { type: "INTF", name: m[1].toUpperCase() };
  m = lower.match(/^([\w#$/]+)\.prog\b/);
  if (m) return { type: "PROG", name: m[1].toUpperCase() };
  // FUGR sub-includes will appear as "<group>.fugr.<member>.abap" in Phase 3.
  m = lower.match(/^([\w#$/]+)\.fugr\b/);
  if (m) return { type: "FUGR", name: m[1].toUpperCase() };
  return null;
}

function _nodeId(type, name) {
  return `${type}:${String(name).toUpperCase()}`;
}

// Build the graph from a parsed Registry + the package skeleton already
// produced for the same registry. Returns:
//   { package, nodes: [{id, type, name, external?}], edges: [{from, to, kind, source}] }
function buildDependencyGraph(registry, skeleton, opts = {}) {
  const packageName = opts.package || null;
  const internalNodes = new Map(); // id -> { id, type, name, external: false }
  const externalNodes = new Map(); // id -> { id, type, name, external: true }
  const edges = [];

  if (!registry) {
    return { package: packageName, nodes: [], edges: [] };
  }

  // -------------------------------------------------------------------------
  // 1. Seed internal nodes from the skeleton — every CLAS/INTF/PROG in the
  //    package is a node, even if it has no outbound edges.
  // -------------------------------------------------------------------------
  for (const c of skeleton.classes || []) {
    const id = _nodeId("CLAS", c.name);
    internalNodes.set(id, { id, type: "CLAS", name: c.name, external: false });
  }
  for (const i of skeleton.interfaces || []) {
    const id = _nodeId("INTF", i.name);
    internalNodes.set(id, { id, type: "INTF", name: i.name, external: false });
  }
  for (const p of skeleton.programs || []) {
    const id = _nodeId("PROG", p.name);
    internalNodes.set(id, { id, type: "PROG", name: p.name, external: false });
  }
  for (const fg of skeleton.functionGroups || []) {
    const id = _nodeId("FUGR", fg.name);
    internalNodes.set(id, { id, type: "FUGR", name: fg.name, external: false });
  }

  // Helper to either get or create an external node.
  const refExternal = (type, name) => {
    const id = _nodeId(type, name);
    if (internalNodes.has(id)) return id;
    if (!externalNodes.has(id)) {
      externalNodes.set(id, { id, type, name: String(name).toUpperCase(), external: true });
    }
    return id;
  };

  // -------------------------------------------------------------------------
  // 2. inheritsFrom + implements edges — read off the skeleton.
  // -------------------------------------------------------------------------
  for (const c of skeleton.classes || []) {
    const fromId = _nodeId("CLAS", c.name);
    if (c.superClass) {
      const toId = refExternal("CLAS", c.superClass);
      edges.push({ from: fromId, to: toId, kind: "inheritsFrom", source: "skeleton" });
    }
    for (const intfName of c.interfaces || []) {
      // Strip the "(PARTIALLY IMPLEMENTED)" suffix added by _extractImplementing.
      const cleanName = String(intfName).split(/\s+/)[0];
      const toId = refExternal("INTF", cleanName);
      edges.push({ from: fromId, to: toId, kind: "implements", source: "skeleton" });
    }
  }
  for (const i of skeleton.interfaces || []) {
    const fromId = _nodeId("INTF", i.name);
    for (const intfName of i.extendsInterfaces || []) {
      const cleanName = String(intfName).split(/\s+/)[0];
      const toId = refExternal("INTF", cleanName);
      edges.push({ from: fromId, to: toId, kind: "extendsInterface", source: "skeleton" });
    }
  }

  // -------------------------------------------------------------------------
  // 3. AST-driven edges per ABAP file.
  // -------------------------------------------------------------------------
  if (!abaplint) {
    return _finalize(packageName, internalNodes, externalNodes, edges);
  }
  const Statements = abaplint.Statements || {};

  for (const obj of registry.getObjects()) {
    const files = typeof obj.getABAPFiles === "function" ? obj.getABAPFiles() : [];
    for (const file of files) {
      const ident = _identifyFile(file.getFilename());
      if (!ident) continue;
      const fromId = _nodeId(ident.type, ident.name);

      // Owner node must exist; if not in skeleton (e.g. an INCL discovered
      // via abaplint that wasn't part of listPackageContents) — add now.
      if (!internalNodes.has(fromId)) {
        internalNodes.set(fromId, {
          id: fromId,
          type: ident.type,
          name: ident.name,
          external: false,
        });
      }

      let root;
      try {
        root = file.getStructure();
      } catch (e) {
        log.debug(`dependencyGraph: getStructure failed for ${file.getFilename()}: ${e.message}`);
        continue;
      }
      if (!root) continue;

      _walkForEdges(root, fromId, edges, refExternal, Statements);
    }
  }

  return _finalize(packageName, internalNodes, externalNodes, edges);
}

function _finalize(packageName, internalNodes, externalNodes, edges) {
  const nodes = [
    ...Array.from(internalNodes.values()).sort((a, b) => a.id.localeCompare(b.id)),
    ...Array.from(externalNodes.values()).sort((a, b) => a.id.localeCompare(b.id)),
  ];
  // Deduplicate edges by (from, to, kind) — concatTokens-based name extraction
  // can produce duplicates if the same call appears twice.
  const seen = new Set();
  const unique = [];
  for (const e of edges) {
    const key = `${e.from}|${e.to}|${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }
  return {
    schemaVersion: 1,
    package: packageName,
    nodeCount: nodes.length,
    edgeCount: unique.length,
    nodes,
    edges: unique,
  };
}

// Walk the structure node and emit edges for every relevant statement.
function _walkForEdges(root, fromId, edges, refExternal, Statements) {
  // CALL FUNCTION 'ZFM_DO_X'
  for (const stmt of _findAll(root, Statements.CallFunction)) {
    const target = _extractCallFunctionTarget(stmt);
    if (target) {
      edges.push({
        from: fromId,
        to: refExternal("FUNC", target),
        kind: "callFunction",
        source: "parse",
      });
    }
  }

  // CREATE OBJECT lo TYPE zcl_foo  -- and similar
  for (const stmt of _findAll(root, Statements.CreateObject)) {
    const target = _extractCreateObjectTarget(stmt);
    if (target) {
      edges.push({
        from: fromId,
        to: refExternal("CLAS", target),
        kind: "instantiates",
        source: "parse",
      });
    }
  }

  // SELECT ... FROM <table>     /    SELECT ... FROM <table> ... ENDSELECT
  for (const stmt of [..._findAll(root, Statements.Select), ..._findAll(root, Statements.SelectLoop)]) {
    const target = _extractSelectFrom(stmt);
    if (target) {
      edges.push({
        from: fromId,
        to: refExternal("TABL", target),
        kind: "readsTable",
        source: "parse",
      });
    }
  }

  // INCLUDE <name>
  for (const stmt of _findAll(root, Statements.Include)) {
    const target = _extractIncludeTarget(stmt);
    if (target) {
      edges.push({
        from: fromId,
        to: refExternal("INCL", target),
        kind: "includes",
        source: "parse",
      });
    }
  }

  // NEW zcl_foo( ... ) — instance constructor expression
  const text = _safeConcatTokens(root);
  if (text) {
    const newRegex = /\bNEW\s+([A-Za-z_][\w\/#]*)\s*\(/g;
    let m;
    while ((m = newRegex.exec(text)) !== null) {
      const target = m[1];
      // Skip data-typed `NEW` like `NEW string( ... )` — only emit when the
      // identifier looks like a class (heuristic: contains underscore or
      // matches naming convention). False positives are cheap and easily
      // pruned downstream.
      if (!/^[A-Za-z_][\w\/#]*$/.test(target)) continue;
      if (target.toUpperCase() === "STRING" || target.toUpperCase() === "TABLE") continue;
      edges.push({
        from: fromId,
        to: refExternal("CLAS", target),
        kind: "instantiates",
        source: "parse",
      });
    }
  }
}

function _findAll(root, statementClass) {
  if (!statementClass || !root || typeof root.findAllStatements !== "function") return [];
  try {
    return root.findAllStatements(statementClass) || [];
  } catch (_) {
    return [];
  }
}

function _safeConcatTokens(node) {
  try {
    return typeof node.concatTokens === "function" ? node.concatTokens() : "";
  } catch (_) {
    return "";
  }
}

function _extractCallFunctionTarget(stmt) {
  const text = _safeConcatTokens(stmt);
  // CALL FUNCTION 'NAME' [DESTINATION 'X' ...]    OR    CALL FUNCTION lv_name
  const m = text.match(/^\s*CALL\s+FUNCTION\s+(?:'([^']+)'|"([^"]+)"|`([^`]+)`)/i);
  if (m) return (m[1] || m[2] || m[3]).toUpperCase();
  // Dynamic call — skip, we can't statically resolve.
  return null;
}

function _extractCreateObjectTarget(stmt) {
  const text = _safeConcatTokens(stmt);
  // CREATE OBJECT lo_x [TYPE zcl_foo] [EXPORTING ...]
  // Old syntax `CREATE OBJECT lo_x` without TYPE infers from the variable type;
  // we can't resolve that statically, skip.
  const m = text.match(/^\s*CREATE\s+OBJECT\s+\S+\s+TYPE\s+([A-Za-z_][\w\/#]*)/i);
  if (m) return m[1].toUpperCase();
  return null;
}

function _extractSelectFrom(stmt) {
  const text = _safeConcatTokens(stmt);
  // SELECT ... FROM <table>  — sub-selects are rare in MVP; capture the first.
  // Skip "FROM (lv_dynamic)" — dynamic table names.
  const m = text.match(/\bFROM\s+([A-Za-z_][\w\/#]*)/i);
  if (m) return m[1].toUpperCase();
  return null;
}

function _extractIncludeTarget(stmt) {
  const text = _safeConcatTokens(stmt);
  // INCLUDE <name> [IF FOUND].   The keyword "INCLUDE TYPE" is a structure
  // declaration, NOT a code include — guard against it.
  if (/^\s*INCLUDE\s+TYPE\b/i.test(text)) return null;
  const m = text.match(/^\s*INCLUDE\s+([A-Za-z_][\w\/#]*)/i);
  if (m) return m[1].toUpperCase();
  return null;
}

//IYH1HC add — Phase 4: fetch inbound where-used edges from SAP.
//
// ADT endpoint:
//   POST /sap/bc/adt/repository/informationsystem/usageReferences?uri=<uri>
//   body (some releases require it):
//     <?xml version="1.0"?>
//     <usageReferenceRequest xmlns="...">
//       <adtcore:objectIdentifier adtcore:uri="..."/>
//     </usageReferenceRequest>
//
// The response shape is XML with <usageReferences:referencedObject> rows
// carrying adtcore:uri / adtcore:type / adtcore:name. We tolerate both the
// "no body" and "with body" variants — start with the no-body call and fall
// back to body if the server rejects.
//
// Costs one HTTP per object — opt-in behind `--with-where-used`.
async function enrichWithWhereUsed(client, graph, internalObjects) {
  if (!client || !graph || !Array.isArray(internalObjects)) return graph;
  const out = { ...graph, edges: [...(graph.edges || [])], nodes: [...(graph.nodes || [])] };

  const externalById = new Map();
  for (const n of out.nodes) if (n.external) externalById.set(n.id, n);

  for (const obj of internalObjects) {
    if (!obj.uri) continue;
    let rows;
    try {
      rows = await _fetchUsageReferences(client, obj.uri);
    } catch (e) {
      // already logged inside helper
      continue;
    }
    if (!rows || rows.length === 0) continue;

    const fromId = _nodeId(obj.typeId.split("/")[0], obj.name);
    for (const row of rows) {
      const callerType = String(row.type || "").split("/")[0] || "UNKN";
      const callerName = String(row.name || "").toUpperCase();
      if (!callerName) continue;
      const callerId = _nodeId(callerType, callerName);

      // Only add external if not already an internal node.
      if (!out.nodes.find((n) => n.id === callerId)) {
        if (!externalById.has(callerId)) {
          const node = { id: callerId, type: callerType, name: callerName, external: true };
          externalById.set(callerId, node);
          out.nodes.push(node);
        }
      }
      out.edges.push({
        from: callerId,
        to: fromId,
        kind: "usedBy",
        source: "whereused",
      });
    }
  }

  // De-duplicate edges again after enrichment.
  const seen = new Set();
  out.edges = out.edges.filter((e) => {
    const k = `${e.from}|${e.to}|${e.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  out.nodes.sort((a, b) => a.id.localeCompare(b.id));
  out.nodeCount = out.nodes.length;
  out.edgeCount = out.edges.length;
  return out;
}

async function _fetchUsageReferences(client, objectUri) {
  const url = `/sap/bc/adt/repository/informationsystem/usageReferences?uri=${encodeURIComponent(objectUri)}`;
  //IYH1HC comment - // Try body-less first (works on BTP Steampunk and recent on-prem).
  //IYH1HC comment - for (const body of [undefined, _whereUsedBody(objectUri)]) {
  //IYH1HC comment -   try { ... if (!res || !res.body) continue; ... }
  //IYH1HC comment -   catch (e) { if (status === 400 || status === 415) continue; ... }
  //IYH1HC comment - }
  //IYH1HC add - Server requires BOTH the request body AND the specific Content-Type
  // application/vnd.sap.adt.repository.usagereferences.request.v1+xml.
  // The previous body-less probe always returns 415 on this release, and
  // client.send does NOT throw on non-2xx, so the old fallback loop never
  // retried with body. Send the correct payload directly.
  try {
    const res = await client.send("POST", url, {
      accept: "application/vnd.sap.adt.repository.usagereferences.result.v1+xml, application/xml;q=0.8",
      headers: { "Content-Type": "application/vnd.sap.adt.repository.usagereferences.request.v1+xml" },
      body: _whereUsedBody(objectUri),
    });
    if (!res || !res.ok || !res.body) return [];
    return _parseUsageReferences(res.body);
  } catch (e) {
    log.debug(`whereUsed: POST ${url} -> ${e.message}`);
    return [];
  }
}

//IYH1HC comment - function _whereUsedBody(objectUri) {
//IYH1HC comment -   return (
//IYH1HC comment -     '<?xml version="1.0" encoding="UTF-8"?>\n' +
//IYH1HC comment -     '<usageReferenceRequest xmlns:adtcore="http://www.sap.com/adt/core">\n' +
//IYH1HC comment -     `  <adtcore:objectIdentifier adtcore:uri="${objectUri}"/>\n` +
//IYH1HC comment -     "</usageReferenceRequest>"
//IYH1HC comment -   );
//IYH1HC comment - }
//IYH1HC add - Format verified against `abap-adt-api` library
// (mcp-server/node_modules/abap-adt-api/build/api/syntax.js:145-148).
// The root element MUST be namespaced with the "usagereferences" prefix
// (lowercase) and contain an empty <affectedObjects/> child. The target
// URI is conveyed via the ?uri= query string, not the body.
function _whereUsedBody(_objectUri) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">\n' +
    "  <usagereferences:affectedObjects/>\n" +
    "</usagereferences:usageReferenceRequest>"
  );
}

function _parseUsageReferences(body) {
  const rows = [];
  _collectUsageRows(body, rows);
  return rows;
}

function _collectUsageRows(node, out) {
  if (!node || typeof node !== "object") return;
  // A "row" is any object whose attribute set contains an adtcore:uri or
  // adtcore:name (the only reliable signal across ADT release variants).
  // Containers ("usageReferences", "referencedObjects") wrap row arrays —
  // we recurse into them and let the row detection above fire on the leaves.
  const a = {};
  for (const key of Object.keys(node)) {
    if (key.startsWith("@_")) a[key.slice(2)] = node[key];
  }
  const type = a["adtcore:type"] || a["type"];
  const name = a["adtcore:name"] || a["name"];
  const uri = a["adtcore:uri"] || a["uri"];
  if (name || (type && uri)) {
    out.push({ type: type || null, name: name || null, uri: uri || null });
  }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) for (const item of v) _collectUsageRows(item, out);
    else if (v && typeof v === "object") _collectUsageRows(v, out);
  }
}

//IYH1HC add
// Phase A1: bulk-fetch raw where-used edges for `adt object pull`.
//
// Unlike enrichWithWhereUsed (which enriches an already-built abaplint
// dependency graph for `adt context build`), this helper has NO Registry
// dependency — it only needs the list of pulled nodes (with their ADT URIs)
// and emits a flat edges[] array suitable for writing to .dependencies.json.
//
// For each input node, calls the same /usageReferences endpoint and records
// every referencing object as an inbound `usedBy` edge:
//   { from: "<caller>", to: "<node.name>", kind: "usedBy", external: true|false }
//
// The "external" flag is true when the caller is outside the internalNameSet
// passed in (i.e., outside the pulled package). For external callers that
// happen to be in another pulled sub-package, the caller marks external=false.
async function fetchDependenciesForPull(client, internalObjects, opts = {}) {
  if (!Array.isArray(internalObjects) || internalObjects.length === 0) {
    return { edges: [] };
  }
  const internalNameSet = new Set(
    internalObjects.map((o) => String(o.name).toUpperCase())
  );
  const edges = [];
  const total = internalObjects.length;
  let processed = 0;

  for (const obj of internalObjects) {
    processed++;
    if (!obj.uri) {
      log.debug(`fetchDependenciesForPull: no uri for ${obj.typeId} ${obj.name}, skipping`);
      continue;
    }
    let rows;
    try {
      rows = await _fetchUsageReferences(client, obj.uri);
    } catch (e) {
      if (opts.keepGoing !== false) {
        log.debug(
          `fetchDependenciesForPull: usageReferences failed for ${obj.name}: ${e.message}`
        );
        continue;
      }
      throw e;
    }
    if (!rows || rows.length === 0) continue;

    const toName = String(obj.name).toUpperCase();
    for (const row of rows) {
      const callerName = String(row.name || "").toUpperCase();
      if (!callerName) continue;
      edges.push({
        from: callerName,
        to: toName,
        kind: "usedBy",
        external: !internalNameSet.has(callerName),
      });
    }

    if (processed % 10 === 0 || processed === total) {
      log.info(`  where-used: ${processed}/${total} objects probed`);
    }
  }

  // De-duplicate edges by (from, to, kind).
  const seen = new Set();
  const unique = [];
  for (const e of edges) {
    const key = `${e.from}|${e.to}|${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }
  return { edges: unique };
}

module.exports = {
  buildDependencyGraph,
  enrichWithWhereUsed,
  //IYH1HC add
  fetchDependenciesForPull,
  // Exported for unit tests in later phases.
  _identifyFile,
  _nodeId,
};
