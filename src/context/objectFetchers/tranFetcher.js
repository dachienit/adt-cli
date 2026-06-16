"use strict";

// Fetch transaction codes (TRAN/T) from SAP via ADT.
//
// Endpoint is release-dependent — we probe two common shapes:
//   GET /sap/bc/adt/transactions/<tcode>
//   GET /sap/bc/adt/oo/transactions/<tcode>
//
// Both have been observed on different NetWeaver releases. If both 404, we
// throw a clear error and the caller decides whether to skip the object.
//
// Output:
//   { files: [{ filename: "<tcode>.tran.xml", content: <raw XML> }] }

const log = require("../../logger");

const CANDIDATE_PATHS = [
  (name) => `/sap/bc/adt/transactions/${encodeURIComponent(name)}`,
  (name) => `/sap/bc/adt/oo/transactions/${encodeURIComponent(name)}`,
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
        log.debug(`tranFetcher: ${lastErr.message}`);
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
        files: [{ filename: `${lower}.tran.xml`, content: xmlText }],
      };
    } catch (e) {
      lastErr = e;
      log.debug(`tranFetcher: ${url} threw: ${e.message}`);
    }
  }
  throw new Error(
    `tranFetcher: no working endpoint for TRAN ${node.name}: ${lastErr ? lastErr.message : "unknown"}`
  );
}

module.exports = { fetchAsAbapGitFile };
