"use strict";

// Write `ddic.json` — TABL / DTEL / DOMA / STRU / VIEW descriptors grouped
// by type so the LLM (or a human) can scan one section at a time.

const fs = require("fs");
const path = require("path");

function buildDdic(entries, opts = {}) {
  const buckets = { tables: [], structures: [], views: [], dataElements: [], domains: [], other: [] };
  for (const e of entries || []) {
    if (!e) continue;
    if (e.typeId?.startsWith("TABL/DT")) buckets.tables.push(e);
    else if (e.typeId?.startsWith("STRU") || e.typeId === "TABL/DS") buckets.structures.push(e);
    else if (e.typeId?.startsWith("VIEW")) buckets.views.push(e);
    else if (e.typeId?.startsWith("DTEL")) buckets.dataElements.push(e);
    else if (e.typeId?.startsWith("DOMA")) buckets.domains.push(e);
    else buckets.other.push(e);
  }
  return {
    schemaVersion: 1,
    package: opts.package || null,
    counts: {
      tables: buckets.tables.length,
      structures: buckets.structures.length,
      views: buckets.views.length,
      dataElements: buckets.dataElements.length,
      domains: buckets.domains.length,
      other: buckets.other.length,
    },
    ...buckets,
  };
}

function writeDdic(outDir, payload) {
  const filePath = path.join(outDir, "ddic.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return filePath;
}

module.exports = { buildDdic, writeDdic };
