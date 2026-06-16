"use strict";

// Serialize `structure.json` — the rich abaplint skeleton for one package.
//
// Phase 1 contents (CLAS / INTF / PROG only). FUGR + DDIC + CDS arrive in
// later phases via additional skeleton/* modules.

const fs = require("fs");
const path = require("path");

function buildStructure(skeleton, opts = {}) {
  return {
    schemaVersion: 1,
    package: opts.package || null,
    classCount: skeleton.classes.length,
    interfaceCount: skeleton.interfaces.length,
    programCount: skeleton.programs.length,
    functionGroupCount: skeleton.functionGroups.length,
    classes: skeleton.classes,
    interfaces: skeleton.interfaces,
    programs: skeleton.programs,
    functionGroups: skeleton.functionGroups,
  };
}

function writeStructure(outDir, payload) {
  const filePath = path.join(outDir, "structure.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return filePath;
}

module.exports = { buildStructure, writeStructure };
