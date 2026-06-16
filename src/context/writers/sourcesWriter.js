"use strict";

// Write ABAP source files under <packageDir>/sources/. Each entry is one
// abapGit-style filename (e.g. "zcl_foo.clas.abap", "zif_bar.intf.abap")
// pointing to a UTF-8 text payload (already stripped if --strip was on).
//
// We intentionally write raw .abap files (NOT JSON-wrapped) so an LLM
// reading them does not pay the JSON-escape overhead.

const fs = require("fs");
const path = require("path");

function writeSources(packageDir, sources) {
  if (!sources || typeof sources !== "object") return [];
  const dir = path.join(packageDir, "sources");
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [filename, content] of Object.entries(sources)) {
    if (!filename || !content) continue;
    const safe = _safeFilename(filename);
    const filePath = path.join(dir, safe);
    fs.writeFileSync(filePath, String(content), "utf8");
    written.push(filePath);
  }
  return written;
}

function _safeFilename(name) {
  // abapGit-convention filenames contain '#' for namespaces, '/' is never
  // expected; still, defensively strip path traversal.
  return String(name).replace(/[\\/]/g, "_").replace(/\.{2,}/g, ".");
}

module.exports = { writeSources };
