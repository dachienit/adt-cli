"use strict";

// Shared low-level operations on existing ADT objects.
// Mirrors src/api/objectcontents.ts, activate.ts, delete.ts, objectstructure.ts
// at HTTP fidelity. Always uses the X-sap-adt-sessiontype: stateful header
// for the lock/unlock/PUT-source/DELETE sequence (lock + setSource + delete
// require the same stateful session per AdtHTTP.ts).

const log = require("./logger");
const xml = require("./xml");
const { ensureOk } = require("./output");
//IYH1HC add
const adapter = require("./abaplintAdapter");

// Convert a partial path or a full /sap/bc/adt URL into the URL the server expects.
// We accept three shapes:
//   - "/sap/bc/adt/programs/programs/zfoo"   (object URL)
//   - "programs/programs/zfoo"                (relative under /sap/bc/adt/)
//   - any URL produced by createables.objectUrl()
function normalizeObjectUrl(input) {
  if (!input) throw new Error("objectUrl is required");
  let s = String(input).trim();
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    return u.pathname + u.search;
  }
  if (!s.startsWith("/")) s = "/sap/bc/adt/" + s.replace(/^sap\/bc\/adt\//, "");
  return s;
}

// POST <objectUrl>?_action=LOCK&accessMode=MODIFY ; returns parsed lock record.
async function lock(client, objectUrl, accessMode = "MODIFY") {
  const url = normalizeObjectUrl(objectUrl);
  client.setStateful(true);
  const res = await client.send("POST", `${url}?_action=LOCK&accessMode=${encodeURIComponent(accessMode)}`, {
    accept:
      "application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result",
  });
  ensureOk(res, "lock");
  const data = walk(res.body, ["asx:abap", "asx:values", "DATA"]);
  if (!data || !data.LOCK_HANDLE) {
    throw new Error("Lock succeeded but no LOCK_HANDLE was returned. Body: " + truncate(res.text, 200));
  }
  log.ok(`Locked ${url}; handle = ${data.LOCK_HANDLE}`);
  return {
    LOCK_HANDLE: String(data.LOCK_HANDLE),
    CORRNR: data.CORRNR,
    CORRUSER: data.CORRUSER,
    CORRTEXT: data.CORRTEXT,
    IS_LOCAL: data.IS_LOCAL,
    IS_LINK_UP: data.IS_LINK_UP,
    MODIFICATION_SUPPORT: data.MODIFICATION_SUPPORT,
  };
}

// POST <objectUrl>?_action=UNLOCK&lockHandle=...
async function unLock(client, objectUrl, lockHandle) {
  if (!lockHandle) throw new Error("lockHandle is required for unLock");
  const url = normalizeObjectUrl(objectUrl);
  // The server is happy to UNLOCK in stateless mode too, but we keep the same
  // session as the lock to stay on the safe side.
  // Accept "*/*" matches the reference TS client (AdtHTTP.ts:313); some ADT
  // servers reject application/xml here with HTTP 406.
  const res = await client.send(
    "POST",
    `${url}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`,
    { accept: "*/*" }
  );
  ensureOk(res, "unlock");
  log.ok(`Unlocked ${url}`);
}

// PUT source. The default object URL is "${objectUrl}/source/main".
// Pass `include: "definitions" | "implementations" | "macros" | "testclasses"`
// for class includes.
async function putSource(client, objectUrl, source, opts = {}) {
  const url = normalizeObjectUrl(objectUrl);
  const include = opts.include || "main";
  const sourceUrl = url.endsWith("/source/" + include) ? url : `${url}/source/${encodeURIComponent(include)}`;
  // PowerShell's `Out-File -Encoding utf8` (and a handful of editors) prepend
  // a UTF-8 BOM. The ABAP parser rejects it with the misleading "REPORT not
  // expected, similar statement is REPORT" diagnostic at activation time.
  if (typeof source === "string") source = xml.stripBom(source);

  const lockResult = opts.lockHandle
    ? { LOCK_HANDLE: opts.lockHandle }
    : await lock(client, url);

  try {
    const ctype = /^<\?xml\s/i.test(source.trim()) ? "application/*" : "text/plain; charset=utf-8";
    const params = new URLSearchParams();
    params.set("lockHandle", lockResult.LOCK_HANDLE);
    if (opts.transport) params.set("corrNr", opts.transport);
    log.step(`PUT source -> ${sourceUrl} (${Buffer.byteLength(source, "utf8")} bytes)`);
    const res = await client.send("PUT", `${sourceUrl}?${params.toString()}`, {
      accept: "*/*",
      headers: { "Content-Type": ctype },
      body: source,
    });
    ensureOk(res, "put-source");
    log.ok(`Source updated.`);
    return { sourceUrl, lockHandle: lockResult.LOCK_HANDLE };
  } finally {
    if (!opts.keepLocked && !opts.lockHandle) {
      try {
        await unLock(client, url, lockResult.LOCK_HANDLE);
      } catch (e) {
        log.warn(`Unlock failed: ${e.message}`);
      }
    }
  }
}

// DELETE <objectUrl>?lockHandle=...&corrNr=...
async function deleteObject(client, objectUrl, opts = {}) {
  const url = normalizeObjectUrl(objectUrl);
  const lockResult = opts.lockHandle
    ? { LOCK_HANDLE: opts.lockHandle }
    : await lock(client, url);
  const params = new URLSearchParams();
  params.set("lockHandle", lockResult.LOCK_HANDLE);
  if (opts.transport) params.set("corrNr", opts.transport);
  log.step(`DELETE ${url}`);
  const res = await client.send("DELETE", `${url}?${params.toString()}`, {
    accept: "*/*",
  });
  ensureOk(res, "delete");
  log.ok(`Deleted ${url}.`);
  return { deleted: true };
}

// POST /sap/bc/adt/activation?method=activate&preauditRequested=...
async function activate(client, name, objectUrl, opts = {}) {
  const url = normalizeObjectUrl(objectUrl);
  const ctx = opts.mainInclude ? `?context=${encodeURIComponent(opts.mainInclude)}` : "";
  const safeName = String(name)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const ref = `<adtcore:objectReference adtcore:uri="${url}${ctx}" adtcore:name="${safeName}"/>`;
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
    ref +
    `</adtcore:objectReferences>`;
  const params = new URLSearchParams();
  params.set("method", "activate");
  params.set("preauditRequested", String(opts.preauditRequested !== false));
  log.step(`Activating ${name} via /sap/bc/adt/activation`);
  const res = await client.send("POST", `/sap/bc/adt/activation?${params.toString()}`, {
    accept: "*/*",
    headers: { "Content-Type": "application/xml" },
    body,
  });
  ensureOk(res, "activate");
  return parseActivationResult(res);
}

function parseActivationResult(res) {
  const result = { success: true, messages: [], inactive: [], httpStatus: res.status };
  if (!res.text) return result;
  const root = res.body && typeof res.body === "object" ? res.body : null;
  if (!root) return result;
  const msgs = walk(root, ["chkl:messages", "msg"]) || [];
  const arr = Array.isArray(msgs) ? msgs : [msgs];
  for (const m of arr) {
    const attrs = nodeAttr(m);
    const shortText = (m.shortText && m.shortText.txt) || attrs["shortText"] || "";
    result.messages.push({ ...attrs, shortText });
    if (/[EAX]/.test(attrs.type || "")) result.success = false;
  }
  const inactive = walk(root, ["ioc:inactiveObjects", "ioc:entry"]);
  if (inactive) {
    const list = Array.isArray(inactive) ? inactive : [inactive];
    if (list.length > 0) result.success = false;
    result.inactive = list.map((e) => ({
      object: nodeAttr(walk(e, ["ioc:object", "ioc:ref"])),
      transport: nodeAttr(walk(e, ["ioc:transport", "ioc:ref"])),
    }));
  }
  return result;
}

async function inactiveObjects(client) {
  const res = await client.send("GET", "/sap/bc/adt/activation/inactiveobjects", {
    accept: "application/vnd.sap.adt.inactivectsobjects.v1+xml, application/xml;q=0.8",
  });
  ensureOk(res, "inactive-objects");
  return res.body;
}

async function structure(client, objectUrl, version) {
  const url = normalizeObjectUrl(objectUrl);
  const params = version ? `?version=${encodeURIComponent(version)}` : "";
  // Accept "*/*" matches the reference TS client; older ADT systems return
  // HTTP 406 when asked for application/xml on object structure GETs.
  const res = await client.send("GET", url + params, { accept: "*/*" });
  ensureOk(res, "structure");
  return res.body;
}

async function getSource(client, objectUrl, opts = {}) {
  const url = normalizeObjectUrl(objectUrl);
  const include = opts.include || "main";
  const sourceUrl = url.endsWith("/source/" + include)
    ? url
    : `${url}/source/${encodeURIComponent(include)}`;
  const params = opts.version ? `?version=${encodeURIComponent(opts.version)}` : "";
  const res = await client.send("GET", sourceUrl + params, { accept: "text/plain" });
  ensureOk(res, "get-source");
  return res.text;
}

//IYH1HC add
// List the direct contents of an ABAP package using the ADT nodestructure
// endpoint. Returns a flat array of { typeId, name, uri, description } entries.
// Used by `adt lint package <pkg>` to enumerate objects to lint.
async function listPackageContents(client, packageName) {
  if (!packageName) throw new Error("packageName is required");
  const pkg = String(packageName).toUpperCase();
  const params = new URLSearchParams();
  params.set("parent_name", pkg);
  params.set("parent_tech_name", pkg);
  params.set("parent_type", "DEVC/K");
  params.set("withShortDescriptions", "true");
  //IYH1HC add — removed "x-csrf-token": "fetch" from headers; client.js ensureCsrf()
  // already fetches and injects the token automatically for all mutating requests.
  // Passing "fetch" here overrides the real token (client.js line 190 skips injection
  // when the header is already present), causing SAP to reject with 403.
  const res = await client.send(
    "POST",
    `/sap/bc/adt/repository/nodestructure?${params.toString()}`,
    {
      accept:
        "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.RepositoryObjTreeContent",
    }
  );
  ensureOk(res, "list-package-contents");

  // Body shape (fast-xml-parser):
  //   asx:abap > asx:values > DATA > TREE_CONTENT > SEU_ADT_REPOSITORY_OBJ_NODE [*]
  // Each node carries OBJECT_TYPE, OBJECT_NAME, OBJECT_URI, DESCRIPTION, ...
  const data = walk(res.body, ["asx:abap", "asx:values", "DATA"]);
  if (!data) return [];
  const tree = data.TREE_CONTENT || {};
  let nodes = tree.SEU_ADT_REPOSITORY_OBJ_NODE || [];
  if (!Array.isArray(nodes)) nodes = [nodes];

  const out = [];
  for (const n of nodes) {
    const typeId = n.OBJECT_TYPE || n.object_type || n["@_OBJECT_TYPE"];
    const name = n.OBJECT_NAME || n.object_name || n["@_OBJECT_NAME"];
    const uri = n.OBJECT_URI || n.object_uri || n["@_OBJECT_URI"];
    const description =
      n.DESCRIPTION || n.description || n["@_DESCRIPTION"] || "";
    if (!typeId || !name) continue;
    out.push({
      typeId: String(typeId),
      name: String(name),
      uri: uri ? String(uri) : null,
      description: String(description),
    });
  }
  return out;
}

//IYH1HC add
// Build the fallback ADT URL for an object when listPackageContents returns no uri.
function inferUrlFromTypeAndName(typeId, name) {
  const lower = String(name).toLowerCase();
  switch (typeId) {
    case "CLAS/OC":
      return `oo/classes/${encodeURIComponent(lower)}`;
    case "INTF/OI":
      return `oo/interfaces/${encodeURIComponent(lower)}`;
    case "PROG/P":
      return `programs/programs/${encodeURIComponent(lower)}`;
    case "PROG/I":
      return `programs/includes/${encodeURIComponent(lower)}`;
    default:
      throw new Error(`Unsupported typeId "${typeId}" for URL inference`);
  }
}

//IYH1HC add
// Fetch all relevant includes for one ABAP object and return them as
// abaplint MemoryFile instances. 404 includes (e.g. missing testclasses) are
// silently skipped. Used by both `adt lint` and `adt object pull`.
//IYH1HC add — On legacy S/4HANA (e.g. T4X), the ADT endpoint
//IYH1HC add — /source/<include> returns the SAME body for all 5 CLAS
//IYH1HC add — sub-includes (main = definitions = implementations = macros =
//IYH1HC add — testclasses). Feeding 5 identical files to abaplint creates
//IYH1HC add — duplicate class definitions inside one Registry → the 3_structures
//IYH1HC add — pass fails to locate MethodImplementation nodes → metrics empty.
//IYH1HC add — Dedupe by raw content so abaplint sees exactly one .clas.abap.
async function fetchObjectAsMemoryFiles(client, objectUrl, typeId, name, includeOverride) {
  const includes = includeOverride
    ? [includeOverride]
    : adapter.relevantIncludesFor(typeId);

  const files = [];
  //IYH1HC add — content dedupe (only for CLAS, where SAP repeats the body).
  const seenBodies = typeId === "CLAS/OC" ? new Set() : null;

  for (const inc of includes) {
    try {
      const src = await getSource(client, objectUrl, { include: inc });
      //IYH1HC add
      if (seenBodies) {
        // Cheap content key: length + first 200 chars. Cheap to compute, very
        // strong signal for "same source", insensitive to trailing whitespace
        // differences SAP sometimes injects.
        const key = `${(src || "").length}:${(src || "").slice(0, 200)}`;
        if (seenBodies.has(key)) {
          log.debug(
            `Skipping CLAS include "${inc}" for ${name}: body identical to a previously fetched include (legacy ABAP single-file source).`
          );
          continue;
        }
        seenBodies.add(key);
      }
      files.push(adapter.buildMemoryFile(typeId, name, inc, src));
    } catch (e) {
      const status = e && e.response && e.response.status;
      if (status === 404) {
        log.info(`Skipping include "${inc}" (404 not found).`);
        continue;
      }
      throw e;
    }
  }
  return files;
}

// --- helpers ----------------------------------------------------------------

function walk(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null) return null;
    cur = cur[k];
  }
  return cur;
}

// Pull "@_attr" entries out of a fast-xml-parser node.
function nodeAttr(node) {
  if (!node || typeof node !== "object") return {};
  const out = {};
  for (const k of Object.keys(node)) {
    if (k.startsWith("@_")) out[k.slice(2)] = node[k];
  }
  return out;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length <= n ? s : s.slice(0, n) + "...";
}

module.exports = {
  normalizeObjectUrl,
  lock,
  unLock,
  putSource,
  deleteObject,
  activate,
  inactiveObjects,
  structure,
  getSource,
  //IYH1HC add
  listPackageContents,
  inferUrlFromTypeAndName,
  fetchObjectAsMemoryFiles,
};
