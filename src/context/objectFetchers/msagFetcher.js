"use strict";

// Fetch MSAG (message class) objects from SAP via ADT.
//
// Endpoint pattern:
//   GET /sap/bc/adt/messageclasses/<name>
// Returns an XML body listing message numbers, texts, and self-explanatory
// flags. We save the raw XML as <name>.msag.xml (abapGit convention).
//
// Output:
//   { files: [{ filename: "<name>.msag.xml", content: <raw XML> }] }
//
// Throws on HTTP non-2xx so the caller can log and (with --keep-going)
// continue with the rest of the package.

async function fetchAsAbapGitFile(client, node) {
  const lower = String(node.name).toLowerCase();
  const url =
    node.uri || `/sap/bc/adt/messageclasses/${encodeURIComponent(lower)}`;
  const res = await client.send("GET", url, { accept: "*/*" });
  if (!res || !res.ok) {
    throw new Error(
      `msagFetcher: GET ${url} -> HTTP ${res ? res.status : "no-response"}`
    );
  }
  const xmlText =
    res.text != null
      ? String(res.text)
      : Buffer.isBuffer(res.body)
        ? res.body.toString("utf8")
        : null;
  if (xmlText == null || xmlText.length === 0) {
    throw new Error(`msagFetcher: empty body for ${node.name}`);
  }
  return {
    files: [{ filename: `${lower}.msag.xml`, content: xmlText }],
  };
}

module.exports = { fetchAsAbapGitFile };
