"use strict";

// Fetch ABAP function groups (FUGR) — a two-step dance:
//
//  Step 1. GET /sap/bc/adt/functions/groups/<group>
//          Returns the group's root XML listing all child members:
//            - function modules (FUGR/FF)   under <fmodule:fmodule>...
//            - includes        (FUGR/I)     under <include:include>...
//
//  Step 2. For each child, fetch source via:
//            GET /sap/bc/adt/functions/groups/<group>/fmodules/<fm>/source/main
//            GET /sap/bc/adt/functions/groups/<group>/includes/<inc>/source/main
//
// We also try to discover children via a nodestructure call as a fallback
// because some SAP releases serve a sparse XML at the group root.
//
// The fetcher returns:
//   {
//     name:    <group name>,
//     description: <text or null>,
//     functionModules: [{ name, description?, sourceFilename?, source? }],
//     includes:        [{ name, description?, sourceFilename?, source? }],
//     memoryFiles:     MemoryFile[],   // ready for abaplint Registry
//   }

const objLib = require("../../objLib");
const adapter = require("../../abaplintAdapter");
const log = require("../../logger");
const { matchesNamespace } = require("../../namespaceUtil");

const FUGR_NODE_PARENT_TYPE = "FUGR/F";

async function fetchFunctionGroup(client, node, opts = {}) {
  const groupName = String(node.name).toUpperCase();
  const lower = groupName.toLowerCase();
  const groupUrl = node.uri || `/sap/bc/adt/functions/groups/${encodeURIComponent(lower)}`;
  const namespacePrefixes = Array.isArray(opts.namespacePrefixes)
    ? opts.namespacePrefixes
    : null;

  // --- Step 1: discover children -----------------------------------------
  let children = [];
  try {
    children = await _listChildrenViaNodeStructure(client, groupName);
  } catch (e) {
    log.debug(`functionGroupFetcher: nodestructure failed for ${groupName}: ${e.message}`);
  }

  // Fallback: probe the group XML for member references.
  if (children.length === 0) {
    try {
      children = await _listChildrenViaRootXml(client, groupUrl);
    } catch (e) {
      log.warn(`functionGroupFetcher: root XML probe failed for ${groupName}: ${e.message}`);
    }
  }

  if (namespacePrefixes !== null) {
    const before = children.length;
    const kept = children.filter((c) =>
      matchesNamespace(c.name, namespacePrefixes)
    );
    const dropped = before - kept.length;
    if (dropped > 0) {
      log.info(
        `functionGroupFetcher: ${groupName} — filtered ${dropped} standard child(ren) outside namespace [${namespacePrefixes.join(", ")}]`
      );
    }
    children = kept;
  }

  // --- Step 2: fetch source per child ------------------------------------
  const functionModules = [];
  const includes = [];
  const memoryFiles = [];

  for (const child of children) {
    const isFm = child.typeId === "FUGR/FF" || child.kind === "fmodule";
    const subPath = isFm ? "fmodules" : "includes";
    const childName = String(child.name).toLowerCase();
    const url = child.uri
      || `/sap/bc/adt/functions/groups/${encodeURIComponent(lower)}/${subPath}/${encodeURIComponent(childName)}`;

    let source = null;
    try {
      const sourceUrl = url.endsWith("/source/main") ? url : `${url}/source/main`;
      const res = await client.send("GET", sourceUrl, { accept: "text/plain" });
      if (res && res.ok) source = res.text || "";
    } catch (e) {
      log.debug(`functionGroupFetcher: source fetch failed for ${groupName}/${child.name}: ${e.message}`);
    }

    const filename = adapter.objectToFilename(
      isFm ? "FUGR/FF" : "FUGR/I",
      groupName,
      _safeMemberTag(child.name)
    );
    if (source != null && filename) {
      const { MemoryFile } = require("@abaplint/core");
      memoryFiles.push(new MemoryFile(filename, source));
    }

    const target = isFm ? functionModules : includes;
    target.push({
      name: String(child.name).toUpperCase(),
      description: child.description || null,
      sourceFilename: filename || null,
      source,
    });
  }

  return {
    name: groupName,
    description: node.description || null,
    functionModules,
    includes,
    memoryFiles,
  };
}

// Try nodestructure with parent_type=FUGR/F — returns the FM + include rows.
async function _listChildrenViaNodeStructure(client, groupName) {
  const params = new URLSearchParams();
  params.set("parent_name", groupName);
  params.set("parent_tech_name", groupName);
  params.set("parent_type", FUGR_NODE_PARENT_TYPE);
  params.set("withShortDescriptions", "true");

  const res = await client.send(
    "POST",
    `/sap/bc/adt/repository/nodestructure?${params.toString()}`,
    {
      accept:
        "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.RepositoryObjTreeContent",
    }
  );
  if (!res || !res.body) return [];

  const data = _walk(res.body, ["asx:abap", "asx:values", "DATA"]);
  if (!data) return [];
  const tree = data.TREE_CONTENT || {};
  let nodes = tree.SEU_ADT_REPOSITORY_OBJ_NODE || [];
  if (!Array.isArray(nodes)) nodes = [nodes];

  return nodes
    .map((n) => ({
      typeId: n.OBJECT_TYPE || n["@_OBJECT_TYPE"],
      name: n.OBJECT_NAME || n["@_OBJECT_NAME"],
      uri: n.OBJECT_URI || n["@_OBJECT_URI"] || null,
      description: n.DESCRIPTION || n["@_DESCRIPTION"] || null,
    }))
    .filter((n) => n.typeId && n.name);
}

// Fallback: parse the group's root XML for member refs. The exact tag names
// differ between ADT releases; we look for anything containing "objectReference"
// under known namespaces.
async function _listChildrenViaRootXml(client, groupUrl) {
  const res = await client.send("GET", groupUrl, { accept: "*/*" });
  if (!res || !res.body) return [];
  const refs = [];
  _collectObjectReferences(res.body, refs);
  return refs;
}

function _collectObjectReferences(node, out) {
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (/objectReference/i.test(k)) {
      const refs = Array.isArray(v) ? v : [v];
      for (const r of refs) {
        const a = _attrs(r);
        const typeId = a["adtcore:type"] || a["type"] || null;
        const name = a["adtcore:name"] || a["name"] || null;
        const uri = a["adtcore:uri"] || a["uri"] || null;
        if (!name || !typeId) continue;
        out.push({
          typeId,
          name,
          uri,
          description: a["adtcore:description"] || a["description"] || null,
          kind: typeId.startsWith("FUGR/FF") ? "fmodule" : "include",
        });
      }
    } else if (v && typeof v === "object") {
      _collectObjectReferences(v, out);
    }
  }
}

function _attrs(node) {
  if (!node || typeof node !== "object") return {};
  const out = {};
  for (const k of Object.keys(node)) {
    if (k.startsWith("@_")) out[k.slice(2)] = node[k];
  }
  return out;
}

function _walk(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null) return null;
    cur = cur[k];
  }
  return cur;
}

// abapGit puts FM bodies and includes under "<group>.fugr.<MEMBER>.abap".
// The MEMBER tag for the main include is conventionally the group name itself
// (saplx<group>); for sub-includes it's the L-prefixed include name. We just
// lowercase whatever we get and let abaplint parse it.
function _safeMemberTag(memberName) {
  return String(memberName).toLowerCase().replace(/[^\w]/g, "_");
}

module.exports = {
  fetchFunctionGroup,
};
