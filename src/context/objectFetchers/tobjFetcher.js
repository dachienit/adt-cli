"use strict";

// Fetch table-maintenance authorization objects (TOBJ/TOB) from SAP via ADT.
//
// Endpoint is rarely documented. We probe two candidates:
//   GET /sap/bc/adt/ddic/tables/<name>/tobj          (maintenance metadata)
//   GET /sap/bc/adt/ddic/authobjects/<name>          (legacy hint)
//
// If both fail, throw — caller can mark the object as skipped in the manifest.

const log = require("../../logger");

const CANDIDATE_PATHS = [
  (name) => `/sap/bc/adt/ddic/tables/${encodeURIComponent(name)}/tobj`,
  (name) => `/sap/bc/adt/ddic/authobjects/${encodeURIComponent(name)}`,
];

async function fetchAsAbapGitFile(client, node) {
  const lower = String(node.name).toLowerCase();
  const tries = node.uri ? [node.uri] : CANDIDATE_PATHS.map((fn) => fn(lower));

  let lastErr = null;
  for (const url of tries) {
    try {
      const res = await client.send("GET", url, {
        accept: "*/*",
        silentStatuses: [404, 405, 501],
      });
      if (!res) {
        lastErr = new Error("no response");
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} at ${url}`);
        log.debug(`tobjFetcher: ${lastErr.message}`);
        continue;
      }
      const xmlText =
        res.text != null
          ? String(res.text)
          : Buffer.isBuffer(res.body)
            ? res.body.toString("utf8")
            : null;
      if (xmlText == null || xmlText.length === 0) {
        lastErr = new Error(`empty body at ${url}`);
        continue;
      }
      return {
        files: [{ filename: `${lower}.tobj.xml`, content: xmlText }],
      };
    } catch (e) {
      lastErr = e;
      log.debug(`tobjFetcher: ${url} threw: ${e.message}`);
    }
  }
  throw new Error(
    `tobjFetcher: no working endpoint for TOBJ ${node.name}: ${lastErr ? lastErr.message : "unknown"}`
  );
}

module.exports = { fetchAsAbapGitFile };
