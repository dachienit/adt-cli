"use strict";

// Serialize a bundle's `manifest.json`.
//
// Goal: be self-describing enough that a downstream LLM (or human reviewer)
// can answer "what does this package contain?" without opening any other
// file. Keep the schema additive — never rely on field order, never drop
// fields silently between phases. New fields go at the end.

const fs = require("fs");
const path = require("path");

function buildManifest(input) {
  const { packageMeta, objects, subPackages, generatedAt, writeMode, targetModel, softCap, tokenEstimate } = input;
  return {
    schemaVersion: 1,
    package: packageMeta.name,
    parent: packageMeta.parent || null,
    description: packageMeta.description || null,
    softwareComponent: packageMeta.softwareComponent || null,
    applicationComponent: packageMeta.applicationComponent || null,
    transportLayer: packageMeta.transportLayer || null,
    packageType: packageMeta.packageType || null,
    masterLanguage: packageMeta.masterLanguage || null,
    responsible: packageMeta.responsible || null,
    changedBy: packageMeta.changedBy || null,
    changedAt: packageMeta.changedAt || null,
    subPackages: subPackages || [],
    objectCount: objects.length,
    objectsByType: _countByType(objects),
    objects,
    targetModel: targetModel || null,
    softCap: softCap || null,
    tokenEstimate: tokenEstimate || null,
    writeMode: writeMode || "overwrite",
    generatedAt: generatedAt || new Date().toISOString(),
    degradations: [],
  };
}

function _countByType(objects) {
  const out = {};
  for (const o of objects) {
    const t = o.type || "UNKNOWN";
    out[t] = (out[t] || 0) + 1;
  }
  return out;
}

function writeManifest(outDir, manifest) {
  const filePath = path.join(outDir, "manifest.json");
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return filePath;
}

module.exports = { buildManifest, writeManifest };
