"use strict";

// Pull dispatch table — maps typeId to a fetcher that returns abapGit-style
// files (filename + content) ready to write to disk.
//
// Each fetcher signature:
//   async fetch(client, node) -> { files: [{filename, content}] } | throws
//
// The pull command iterates over package nodes, calls
//   resolveStrategy(typeId, opts)
// and invokes the returned fetcher. The resolver also applies user filters:
//   - includeOnly: if set, only typeIds in this list are pulled
//   - skipTypes:   typeIds in this list are dropped
// Filters override the default-include map below.

const objLib = require("./objLib");
const adapter = require("./abaplintAdapter");
const ddicFetcher = require("./context/objectFetchers/ddicFetcher");
const cdsFetcher = require("./context/objectFetchers/cdsFetcher");
const fugrFetcher = require("./context/objectFetchers/functionGroupFetcher");
const msagFetcher = require("./context/objectFetchers/msagFetcher");
const tranFetcher = require("./context/objectFetchers/tranFetcher");
const tobjFetcher = require("./context/objectFetchers/tobjFetcher");
const sushFetcher = require("./context/objectFetchers/sushFetcher");

// Shared helper for plain code objects (CLAS, INTF, PROG, PROG/I). Wraps the
// MemoryFile output of objLib.fetchObjectAsMemoryFiles into the common shape.
// `opts` ignored — included for signature uniformity.
async function fetchCodeAsFiles(client, node, _opts) {
  const url =
    node.uri || objLib.inferUrlFromTypeAndName(node.typeId, node.name);
  const memFiles = await objLib.fetchObjectAsMemoryFiles(
    client,
    url,
    node.typeId,
    node.name,
    null
  );
  return {
    files: memFiles.map((f) => ({
      filename: f.getFilename(),
      content: f.getRaw(),
    })),
  };
}

// FUGR/F uses the rich function-group fetcher which enumerates FMs and
// includes; FUGR/FF and FUGR/I encountered as standalone nodes (rare) fall
// back to single-file fetch via objLib.
//
//IYH1HC add — opts.namespacePrefixes is forwarded to fugrFetcher so it can
// drop standard SAP includes (LSVIMTOP etc.) that SE54 generates inside
// table-maintenance function groups. Without this filter, the FUGR fetcher
// would loop through every standard include and stall on slow source GETs.
async function fetchFugrAsFiles(client, node, opts = {}) {
  if (node.typeId === "FUGR/F") {
    const result = await fugrFetcher.fetchFunctionGroup(client, node, opts);
    return {
      files: result.memoryFiles.map((f) => ({
        filename: f.getFilename(),
        content: f.getRaw(),
      })),
    };
  }
  return fetchCodeAsFiles(client, node, opts);
}

//IYH1HC comment - // Default-include set. Entries with `defaultInclude: false` are NOT pulled by
//IYH1HC comment - // default — user must opt in via `--include-only ...,MSAG/N` (or similar).
//IYH1HC comment - // Niche / runtime-only types (MSAG/N, TRAN/T, TOBJ/TOB, SUSH) are demoted
//IYH1HC comment - // because their ADT endpoints are release-dependent and have been observed
//IYH1HC comment - // to stall on T4X (msag in particular hung indefinitely before client.js
//IYH1HC comment - // gained a per-call timeout).
//IYH1HC add
// Pure dispatch table — typeId → { extension, fetch }.
// "Which typeIds to pull" is no longer decided here; it lives in pullConfig.js
// (built-in default + user/project pull-config.json + CLI flags). This module
// only answers: "Given typeId X, which fetcher do I call?".
const REGISTRY = {
  // -- Code -------------------------------------------------------------
  "CLAS/OC": { extension: "clas.abap", fetch: fetchCodeAsFiles },
  "INTF/OI": { extension: "intf.abap", fetch: fetchCodeAsFiles },
  "PROG/P": { extension: "prog.abap", fetch: fetchCodeAsFiles },
  "PROG/I": { extension: "prog.abap", fetch: fetchCodeAsFiles },
  // -- Function groups -------------------------------------------------
  "FUGR/F": { extension: "fugr.*.abap", fetch: fetchFugrAsFiles },
  "FUGR/FF": { extension: "fugr.*.abap", fetch: fetchFugrAsFiles },
  "FUGR/I": { extension: "fugr.*.abap", fetch: fetchFugrAsFiles },
  // -- DDIC --------------------------------------------------------------
  "TABL/DT": { extension: "tabl.xml", fetch: ddicFetcher.fetchAsAbapGitFile },
  "TABL/DS": { extension: "tabl.xml", fetch: ddicFetcher.fetchAsAbapGitFile },
  "STRU/DS": { extension: "stru.xml", fetch: ddicFetcher.fetchAsAbapGitFile },
  "DTEL/DE": { extension: "dtel.xml", fetch: ddicFetcher.fetchAsAbapGitFile },
  "DOMA/DD": { extension: "doma.xml", fetch: ddicFetcher.fetchAsAbapGitFile },
  "TTYP/DA": { extension: "ttyp.xml", fetch: ddicFetcher.fetchAsAbapGitFile },
  "VIEW/DV": { extension: "view.xml", fetch: ddicFetcher.fetchAsAbapGitFile },
  // -- CDS ---------------------------------------------------------------
  "DDLS/DF": { extension: "ddls.asddls", fetch: cdsFetcher.fetchAsAbapGitFile },
  "DDLS/DL": { extension: "ddls.asddls", fetch: cdsFetcher.fetchAsAbapGitFile },
  "DCLS/DL": { extension: "dcls.asdcls", fetch: cdsFetcher.fetchAsAbapGitFile },
  // -- Messaging / runtime config (opt-in via pull-config or CLI) -------
  "MSAG/N": { extension: "msag.xml", fetch: msagFetcher.fetchAsAbapGitFile },
  "TRAN/T": { extension: "tran.xml", fetch: tranFetcher.fetchAsAbapGitFile },
  "TOBJ/TOB": { extension: "tobj.xml", fetch: tobjFetcher.fetchAsAbapGitFile },
  SUSH: { extension: "sush.xml", fetch: sushFetcher.fetchAsAbapGitFile },
};

const KNOWN_TYPE_IDS = Object.freeze(Object.keys(REGISTRY));

function isKnownType(typeId) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, typeId);
}

//IYH1HC add — pure dispatch lookup. Filter decisions live in pullConfig.js.
function getStrategy(typeId) {
  return REGISTRY[typeId] || null;
}

//IYH1HC comment - resolveStrategy(typeId, opts) was a filter + dispatch combo.
//IYH1HC comment - Replaced by getStrategy(typeId) + pullConfig.loadEffectiveTypes().
//IYH1HC comment - explainExclusion(typeId, opts) was used to render skip reasons.
//IYH1HC comment - Replaced by pull.js inline reason building when classifying nodes.

function listKnownTypes() {
  return KNOWN_TYPE_IDS.slice();
}

module.exports = {
  //IYH1HC add
  getStrategy,
  isKnownType,
  listKnownTypes,
  KNOWN_TYPE_IDS,
};
