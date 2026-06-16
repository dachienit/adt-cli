"use strict";

// Fetch ABAP long-text documentation for packages and individual objects.
//
// ADT serves long text via:
//   GET <object-url>/longtexts               (preferred — recent releases)
//   GET <object-url>/longText                (legacy spelling)
//   GET /sap/bc/adt/packages/<pkg>/longtexts (or /longText)
//
// We probe the modern URL first and silently fall back to the legacy spelling
// on 404. Empty results are skipped — we don't write empty docs/ files.
//
// Returns an array of `{ id, title, source, content }` records. `id` is a
// filesystem-safe slug used as the docs/ filename stem.

const log = require("../logger");

async function fetchPackageLongText(client, packageName) {
  const lower = String(packageName).toLowerCase();
  for (const tail of ["longtexts", "longText"]) {
    const url = `/sap/bc/adt/packages/${encodeURIComponent(lower)}/${tail}`;
    const content = await _tryFetchText(client, url);
    if (content) {
      return {
        id: `PACKAGE_${String(packageName).toUpperCase()}`,
        title: `Package ${packageName} — long text`,
        source: url,
        content,
      };
    }
  }
  return null;
}

async function fetchObjectLongText(client, node) {
  const baseUrl = node.uri;
  if (!baseUrl) return null;

  for (const tail of ["longtexts", "longText"]) {
    const url = baseUrl.endsWith(`/${tail}`) ? baseUrl : `${baseUrl}/${tail}`;
    const content = await _tryFetchText(client, url);
    if (content) {
      const id = `${node.typeId.split("/")[0]}_${String(node.name).toUpperCase()}`;
      return {
        id,
        title: `${node.typeId} ${node.name} — long text`,
        source: url,
        content,
      };
    }
  }
  return null;
}

async function _tryFetchText(client, url) {
  try {
    const res = await client.send("GET", url, {
      accept: "text/html, text/plain, */*",
      //IYH1HC add - long text is optional; 404/405/501 are expected for objects
      // without any long text. Silence the ERR log spam from client.send.
      silentStatuses: [404, 405, 501],
    });
    if (!res || !res.ok) return null;
    const text = (res.text || "").trim();
    return text || null;
  } catch (e) {
    //IYH1HC comment - dead branch: client.send does NOT throw on non-2xx,
    //IYH1HC comment - but keep for genuine network errors.
    const status = e && e.response && e.response.status;
    if (status === 404 || status === 405 || status === 501) return null;
    log.debug(`docsFetcher: ${url} -> ${e.message}`);
    return null;
  }
}

module.exports = { fetchPackageLongText, fetchObjectLongText };
