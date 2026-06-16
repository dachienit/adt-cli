"use strict";

// Fetch SUSH (authorization-check usage) artefacts from SAP via ADT.
//
// SUSH typically represents a function-module-level auth check declaration
// rather than a standalone object. Names observed in repositories include
// embedded spaces and trailing flag tokens (e.g., "ZFM_FOO              RF").
// Because there is no public ADT endpoint that returns SUSH metadata as a
// stable XML document, this fetcher probes the function-module structure URL
// associated with the SUSH name's first token and saves whatever XML is
// returned. If the probe fails, throw — the caller will mark the object as
// skipped in the manifest with a clear reason.

const log = require("../../logger");

async function fetchAsAbapGitFile(client, node) {
  // SUSH names commonly look like "ZFM_NAME    RF" — the leading word is the
  // associated function module and the trailing tokens are auth flags.
  const firstWord = String(node.name).trim().split(/\s+/)[0] || node.name;
  const lower = String(firstWord).toLowerCase();

  // No reliable ADT endpoint for SUSH. Attempt the FM structure as a fallback
  // so we at least record SOMETHING about the auth-checked function module.
  const url =
    node.uri ||
    `/sap/bc/adt/functions/groups/_/fmodules/${encodeURIComponent(lower)}`;

  try {
    const res = await client.send("GET", url, {
      accept: "*/*",
      silentStatuses: [404, 405, 501],
    });
    if (!res || !res.ok) {
      throw new Error(
        `HTTP ${res ? res.status : "no-response"} at ${url}`
      );
    }
    const xmlText =
      res.text != null
        ? String(res.text)
        : Buffer.isBuffer(res.body)
          ? res.body.toString("utf8")
          : null;
    if (xmlText == null || xmlText.length === 0) {
      throw new Error(`empty body at ${url}`);
    }
    return {
      files: [{ filename: `${lower}.sush.xml`, content: xmlText }],
    };
  } catch (e) {
    log.debug(`sushFetcher: ${url} threw: ${e.message}`);
    throw new Error(
      `sushFetcher: no working endpoint for SUSH ${node.name}: ${e.message}`
    );
  }
}

module.exports = { fetchAsAbapGitFile };
