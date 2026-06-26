"use strict";

// Fetch DDIC objects (TABL, DTEL, DOMA, STRU, VIEW) from SAP via ADT.
//
// Unlike CLAS/INTF/PROG which have ABAP source, DDIC objects are pure XML
// metadata. We fetch the structure XML via `objLib.structure()` and hand it
// to `ddicSkeleton.js` which projects it to a JSON descriptor.
//
// Optional richer field-level details for TABL come from the existing
// `/sap/bc/adt/datapreview/ddic/<entity>/metadata` endpoint that
// `commands/data.js` already uses — we reuse that URL pattern here.

const objLib = require("../../objLib");
const log = require("../../logger");

const SUPPORTED_DDIC_TYPE_IDS = new Set([
  "TABL/DT", // database tables
  "TABL/DS", // structures (same family in ADT terms)
  "DTEL/DE", // data elements
  "DOMA/DD", // domains
  "STRU/DS", // structures (alt id)
  "VIEW/DV", // views
]);

function isDdicTypeId(typeId) {
  return SUPPORTED_DDIC_TYPE_IDS.has(typeId);
}

async function fetchDdicObject(client, node) {
  const url = node.uri || _inferUrl(node);
  if (!url) {
    return { typeId: node.typeId, name: node.name, error: "no uri" };
  }
  try {
    const structureXml = await objLib.structure(client, url);
    // For TABL / STRU / VIEW we additionally try to enrich with the
    // datapreview ddic-meta endpoint to get field-level info, since the
    // plain structure XML often omits the field list.
    let fieldsMeta = null;
    if (node.typeId.startsWith("TABL") || node.typeId.startsWith("STRU") || node.typeId.startsWith("VIEW")) {
      fieldsMeta = await _fetchFieldsMeta(client, node.name).catch((e) => {
        log.debug(`ddicFetcher: ddic-meta failed for ${node.name}: ${e.message}`);
        return null;
      });
    }
    return {
      typeId: node.typeId,
      name: node.name,
      description: node.description || null,
      uri: url,
      structureXml,
      fieldsMeta,
    };
  } catch (e) {
    log.warn(`ddicFetcher: structure fetch failed for ${node.typeId} ${node.name}: ${e.message}`);
    return { typeId: node.typeId, name: node.name, error: e.message };
  }
}

// `/sap/bc/adt/datapreview/ddic/<entity>/metadata` — same path commands/data.js uses.
async function _fetchFieldsMeta(client, name) {
  const url = `/sap/bc/adt/datapreview/ddic/${encodeURIComponent(String(name).toUpperCase())}/metadata`;
  const res = await client.send("GET", url, {
    accept: "application/vnd.sap.adt.datapreview.table.v1+xml, application/xml;q=0.8",
  });
  if (!res || !res.ok || !res.body) return null;
  return res.body;
}

function _inferUrl(node) {
  const name = String(node.name).toLowerCase();
  if (node.typeId.startsWith("TABL")) return `/sap/bc/adt/ddic/tables/${encodeURIComponent(name)}`;
  if (node.typeId.startsWith("DTEL")) return `/sap/bc/adt/ddic/dataelements/${encodeURIComponent(name)}`;
  if (node.typeId.startsWith("DOMA")) return `/sap/bc/adt/ddic/domains/${encodeURIComponent(name)}`;
  if (node.typeId.startsWith("STRU")) return `/sap/bc/adt/ddic/structures/${encodeURIComponent(name)}`;
  if (node.typeId.startsWith("VIEW")) return `/sap/bc/adt/ddic/views/${encodeURIComponent(name)}`;
  return null;
}

// Returns { files: [{ filename, content }] } so the pull command can write
// the file as-is. The XML body is the raw ADT response (Accept: */*) — we do
// NOT re-serialize or normalize, the on-disk file is what SAP gave us.
//
// Filename mapping by typeId family:
//   TABL/DT, TABL/DS  -> <name>.tabl.xml
//   STRU/DS           -> <name>.stru.xml
//   DTEL/DE           -> <name>.dtel.xml
//   DOMA/DD           -> <name>.doma.xml
//   TTYP/DA           -> <name>.ttyp.xml
//   VIEW/DV           -> <name>.view.xml
function _abapGitExtensionFor(typeId) {
  if (typeId.startsWith("TABL")) return "tabl.xml";
  if (typeId.startsWith("STRU")) return "stru.xml";
  if (typeId.startsWith("DTEL")) return "dtel.xml";
  if (typeId.startsWith("DOMA")) return "doma.xml";
  if (typeId.startsWith("TTYP")) return "ttyp.xml";
  if (typeId.startsWith("VIEW")) return "view.xml";
  return null;
}

async function fetchAsAbapGitFile(client, node) {
  const url = node.uri || _inferUrl(node);
  if (!url) {
    throw new Error(`ddicFetcher: cannot infer URL for ${node.typeId} ${node.name}`);
  }
  const ext = _abapGitExtensionFor(node.typeId);
  if (!ext) {
    throw new Error(`ddicFetcher: unsupported DDIC type ${node.typeId}`);
  }
  const res = await client.send("GET", url, { accept: "*/*" });
  if (!res || !res.ok) {
    throw new Error(
      `ddicFetcher: GET ${url} -> HTTP ${res ? res.status : "no-response"}`
    );
  }
  const xmlText =
    res.text != null
      ? String(res.text)
      : Buffer.isBuffer(res.body)
        ? res.body.toString("utf8")
        : null;
  if (xmlText == null || xmlText.length === 0) {
    throw new Error(`ddicFetcher: empty body for ${node.typeId} ${node.name}`);
  }
  const filename = `${String(node.name).toLowerCase()}.${ext}`;
  return { files: [{ filename, content: xmlText }] };
}

module.exports = {
  fetchDdicObject,
  isDdicTypeId,
  SUPPORTED_DDIC_TYPE_IDS,
  fetchAsAbapGitFile,
};
