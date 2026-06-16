"use strict";

// Fetch CDS (DDLS) objects from SAP via ADT.
//
// CDS endpoint pattern:
//   - GET /sap/bc/adt/ddic/ddl/sources/<name>             -> metadata XML
//   - GET /sap/bc/adt/ddic/ddl/sources/<name>/source/main -> raw DDL text
//
// abaplint's CDS coverage is partial (issue tracker confirms only a subset
// of DDL syntax is parsed). We therefore treat DDLS as a plain-text artefact:
// we keep the raw .asddls source and run lightweight regex extraction for
// the `FROM <table>` clauses so the LLM can see CDS->TABL edges.
//
// Output:
//   {
//     name, typeId, description, sourceFilename, source, fromTables: []
//   }

const objLib = require("../../objLib");
const log = require("../../logger");

const CDS_TYPE_IDS = new Set(["DDLS/DF", "DDLS/DL", "DCLS/DL"]);

function isCdsTypeId(typeId) {
  return CDS_TYPE_IDS.has(typeId);
}

async function fetchCdsObject(client, node) {
  const name = String(node.name).toLowerCase();
  const baseUrl = node.uri || `/sap/bc/adt/ddic/ddl/sources/${encodeURIComponent(name)}`;

  let metadata = null;
  try {
    metadata = await objLib.structure(client, baseUrl);
  } catch (e) {
    log.debug(`cdsFetcher: metadata fetch failed for ${node.name}: ${e.message}`);
  }

  let source = null;
  try {
    const sourceUrl = baseUrl.endsWith("/source/main") ? baseUrl : `${baseUrl}/source/main`;
    const res = await client.send("GET", sourceUrl, { accept: "text/plain" });
    if (res && res.ok) source = res.text || "";
  } catch (e) {
    log.warn(`cdsFetcher: source fetch failed for ${node.name}: ${e.message}`);
  }

  const description =
    metadata && (metadata["@_adtcore:description"] || metadata["@_description"]) || node.description || null;

  return {
    name: String(node.name).toUpperCase(),
    typeId: node.typeId,
    description,
    sourceFilename: `${name}.ddls.asddls`,
    source,
    fromTables: _extractFromTables(source),
  };
}

// Lightweight CDS DDL parser: pull `FROM <table>` and `ASSOCIATION TO <target>`
// references. Skips comments. Heuristic — works for the common cases.
function _extractFromTables(source) {
  if (!source) return [];
  const cleaned = String(source).replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Set();
  const fromRegex = /\bFROM\s+([A-Za-z_][\w]*)/gi;
  const assocRegex = /\bASSOCIATION\s+TO(?:\s+ONE|\s+MANY)?\s+([A-Za-z_][\w]*)/gi;
  let m;
  while ((m = fromRegex.exec(cleaned)) !== null) out.add(m[1].toUpperCase());
  while ((m = assocRegex.exec(cleaned)) !== null) out.add(m[1].toUpperCase());
  return Array.from(out);
}

//IYH1HC add
// Phase A1: abapGit-style raw source fetch for `adt object pull`.
//
// CDS sources are pure DDL text. abapGit convention:
//   DDLS/DF, DDLS/DL  -> <name>.ddls.asddls
//   DCLS/DL           -> <name>.dcls.asdcls
//
// Returns { files: [{ filename, content }] }.
function _abapGitExtensionFor(typeId) {
  if (typeId.startsWith("DDLS")) return "ddls.asddls";
  if (typeId.startsWith("DCLS")) return "dcls.asdcls";
  return null;
}

//IYH1HC add
async function fetchAsAbapGitFile(client, node) {
  const name = String(node.name).toLowerCase();
  const baseUrl =
    node.uri || `/sap/bc/adt/ddic/ddl/sources/${encodeURIComponent(name)}`;
  const ext = _abapGitExtensionFor(node.typeId);
  if (!ext) {
    throw new Error(`cdsFetcher: unsupported CDS type ${node.typeId}`);
  }
  const sourceUrl = baseUrl.endsWith("/source/main")
    ? baseUrl
    : `${baseUrl}/source/main`;
  const res = await client.send("GET", sourceUrl, { accept: "text/plain" });
  if (!res || !res.ok) {
    throw new Error(
      `cdsFetcher: GET ${sourceUrl} -> HTTP ${res ? res.status : "no-response"}`
    );
  }
  const text = res.text != null ? String(res.text) : "";
  const filename = `${name}.${ext}`;
  return { files: [{ filename, content: text }] };
}

module.exports = {
  fetchCdsObject,
  isCdsTypeId,
  CDS_TYPE_IDS,
  //IYH1HC add
  fetchAsAbapGitFile,
};
