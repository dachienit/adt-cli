"use strict";

// Write `metrics.json` — per-class cyclomatic complexity + method length.
// Reuses adapter.extractMetrics() which wraps abaplint's
// CyclomaticComplexityStats and MethodLengthStats.

const fs = require("fs");
const path = require("path");

function buildMetrics(metrics, opts = {}) {
  return {
    schemaVersion: 1,
    package: opts.package || null,
    classCount: metrics.length,
    godClassCount: metrics.filter((m) => m.isGodClass).length,
    classes: metrics,
  };
}

function writeMetrics(outDir, payload) {
  const filePath = path.join(outDir, "metrics.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return filePath;
}

module.exports = { buildMetrics, writeMetrics };
