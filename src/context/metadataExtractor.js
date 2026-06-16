"use strict";

// Project per-object metadata out of the raw structure XML returned by
// `objLib.structure()`. The XML response is already parsed to a JS tree by
// fast-xml-parser inside src/client.js — here we just flatten the few
// `adtcore:*` and `adtcore:packageRef` attributes that an LLM cares about.
//
// All fields are best-effort: any missing attribute yields `null` rather than
// throwing, because the set of attributes varies per object type and per SAP
// release. Downstream writers should treat the projection as a hint, not a
// schema-strict record.
//
// Package-level metadata (software component, master language at the package
// scope) is fetched once per package in builder.js via the same flow; see
// `extractPackageMetadata` below.

const objLib = require("../objLib");
const log = require("../logger");

// Map ADT typeId to the human-readable short type used in manifest.json.
// Keep this in lockstep with the supported types in abaplintAdapter.js.
function shortType(typeId) {
  if (!typeId) return null;
  return String(typeId).split("/")[0];
}

// Pull "@_attr" entries out of a fast-xml-parser node. Same helper logic as
// in src/objLib.js, replicated locally so this module doesn't reach into
// objLib internals.
function attrs(node) {
  if (!node || typeof node !== "object") return {};
  const out = {};
  for (const k of Object.keys(node)) {
    if (k.startsWith("@_")) out[k.slice(2)] = node[k];
  }
  return out;
}

// Walk a chain of property names, tolerating missing branches.
function walk(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null) return null;
    cur = cur[key];
  }
  return cur;
}

// Pick the first non-empty value from a list of candidate paths.
function pick(node, ...paths) {
  for (const path of paths) {
    const v = walk(node, path);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

// adtcore attributes hang directly off the root element (e.g. <class:abapClass
// adtcore:name="..." adtcore:description="...">). Extract them whether the
// caller passed us the root element or already drilled in one level.
function projectAdtCoreAttrs(structureXml) {
  if (!structureXml || typeof structureXml !== "object") return {};
  // fast-xml-parser keeps @_-prefixed attributes on the node directly.
  const top = attrs(structureXml);
  if (Object.keys(top).length > 0) return top;
  // Fallback: drill into the first child element.
  for (const key of Object.keys(structureXml)) {
    if (key.startsWith("@_") || key.startsWith("?")) continue;
    const child = structureXml[key];
    if (child && typeof child === "object") {
      const childAttrs = attrs(child);
      if (Object.keys(childAttrs).length > 0) return childAttrs;
    }
  }
  return {};
}

// Project a flat metadata record for a single object given:
//   - node:        { typeId, name, uri, description } from listPackageContents
//   - structureXml: parsed body from objLib.structure() (optional, may be null)
function projectObjectMetadata(node, structureXml) {
  const attrsRoot = projectAdtCoreAttrs(structureXml);

  // Some servers spell adtcore attributes differently (with/without
  // namespace prefix in fast-xml-parser output). Normalize by stripping the
  // "adtcore:" prefix when present.
  const norm = {};
  for (const [k, v] of Object.entries(attrsRoot)) {
    const stripped = k.startsWith("adtcore:") ? k.slice("adtcore:".length) : k;
    norm[stripped] = v;
  }

  const packageRef = walk(structureXml || {}, ["adtcore:packageRef"])
    || walk(structureXml || {}, ["packageRef"]);
  const packageAttrs = attrs(packageRef);

  return {
    typeId: node.typeId,
    type: shortType(node.typeId),
    name: node.name,
    uri: node.uri || null,
    description: node.description || norm["description"] || null,
    package: packageAttrs["adtcore:name"] || packageAttrs["name"] || null,
    responsible: norm["responsible"] || null,
    createdBy: norm["createdBy"] || null,
    createdAt: norm["createdAt"] || null,
    changedBy: norm["changedBy"] || null,
    changedAt: norm["changedAt"] || null,
    masterLanguage: norm["masterLanguage"] || null,
    masterSystem: norm["masterSystem"] || null,
    abapLanguageVersion: norm["abapLanguageVersion"] || null,
    version: norm["version"] || null,
  };
}

// Fetch metadata for a single ABAP object. Returns null if the structure
// endpoint fails — the caller should still include the node in the manifest
// based on the listPackageContents row.
async function fetchObjectMetadata(client, node) {
  const url = node.uri || _inferUrl(node);
  if (!url) {
    return projectObjectMetadata(node, null);
  }
  try {
    const xml = await objLib.structure(client, url);
    return projectObjectMetadata(node, xml);
  } catch (e) {
    log.warn(`metadataExtractor: structure() failed for ${node.typeId} ${node.name}: ${e.message}`);
    return projectObjectMetadata(node, null);
  }
}

// Best-effort: reuse objLib.inferUrlFromTypeAndName for the supported types
// in Phase 1; return null otherwise (DDIC/FUGR/CDS come in later phases).
function _inferUrl(node) {
  try {
    return objLib.inferUrlFromTypeAndName(node.typeId, node.name);
  } catch (_) {
    return null;
  }
}

// Fetch + project package-level metadata via `GET /sap/bc/adt/packages/<pkg>`.
// The response carries pak:* and adtcore:* attributes describing the package
// itself (description, software component, master language, parent package).
async function extractPackageMetadata(client, packageName) {
  const url = `/sap/bc/adt/packages/${encodeURIComponent(String(packageName).toLowerCase())}`;
  try {
    const xml = await objLib.structure(client, url);
    const root = projectAdtCoreAttrs(xml);
    const norm = {};
    for (const [k, v] of Object.entries(root)) {
      const stripped = k.replace(/^adtcore:/, "").replace(/^pak:/, "");
      norm[stripped] = v;
    }
    return {
      name: norm["name"] || String(packageName).toUpperCase(),
      description: norm["description"] || null,
      softwareComponent:
        norm["softwareComponent"]
        || _nestedText(xml, "pak:softwareComponent", "@_pak:name")
        || null,
      applicationComponent: norm["applicationComponent"] || null,
      transportLayer: norm["transportLayer"] || null,
      packageType: norm["packageType"] || null,
      masterLanguage: norm["masterLanguage"] || null,
      responsible: norm["responsible"] || null,
      changedBy: norm["changedBy"] || null,
      changedAt: norm["changedAt"] || null,
    };
  } catch (e) {
    log.warn(`metadataExtractor: package metadata fetch failed for ${packageName}: ${e.message}`);
    return {
      name: String(packageName).toUpperCase(),
      description: null,
      softwareComponent: null,
      applicationComponent: null,
      transportLayer: null,
      packageType: null,
      masterLanguage: null,
      responsible: null,
      changedBy: null,
      changedAt: null,
    };
  }
}

function _nestedText(root, ...keys) {
  let cur = root;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[k];
  }
  return cur ?? null;
}

module.exports = {
  shortType,
  projectObjectMetadata,
  fetchObjectMetadata,
  extractPackageMetadata,
};
