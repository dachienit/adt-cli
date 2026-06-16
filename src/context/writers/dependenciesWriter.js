"use strict";

// Write `dependencies.json` — cross-object dependency graph.

const fs = require("fs");
const path = require("path");

function writeDependencies(outDir, payload) {
  const filePath = path.join(outDir, "dependencies.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return filePath;
}

module.exports = { writeDependencies };
