"use strict";

// Walk an ABAP package tree via the ADT nodestructure endpoint and group
// objects by their owning package.
//
// Phase 1: --depth 0 (root only) is the only path exercised. The walker
// already understands DEVC/K (sub-package) nodes and recurses when depth > 0
// so Phase 2 can wire `--depth N` without changing this module.
//
// Output shape:
//   Map<string, {
//     name: string,            // upper-cased package name (key of map)
//     parent: string | null,   // upper-cased parent package, or null for root
//     depth: number,           // 0 = root, 1 = direct sub-package, ...
//     subPackages: string[],   // upper-cased names of direct children
//     nodes: NodeEntry[],      // leaf objects in this package (NOT sub-packages)
//   }>
//
// NodeEntry mirrors what objLib.listPackageContents() returns, untouched:
//   { typeId, name, uri, description }
//
// Cycle protection: visited Set keyed by upper-case package name. SAP normally
// returns acyclic package hierarchies but a misconfigured PARENTCL can produce
// loops; we abort enqueueing a package the second time we see it.

const objLib = require("../objLib");
const log = require("../logger");

const SUB_PACKAGE_TYPE_ID = "DEVC/K";

async function walkPackage(client, rootPackage, opts = {}) {
  if (!rootPackage) throw new Error("packageName is required");
  const depthLimit = Number.isFinite(opts.depth) ? Math.max(0, opts.depth) : Infinity;

  const result = new Map();
  const visited = new Set();
  const queue = [{ name: String(rootPackage).toUpperCase(), parent: null, depth: 0 }];

  while (queue.length > 0) {
    const { name, parent, depth } = queue.shift();
    if (visited.has(name)) {
      log.debug(`packageWalker: skipping already-visited package ${name}`);
      continue;
    }
    visited.add(name);

    log.step(`Walking package ${name} (depth ${depth})`);
    let children;
    try {
      children = await objLib.listPackageContents(client, name);
    } catch (e) {
      log.warn(`packageWalker: listPackageContents failed for ${name}: ${e.message}`);
      result.set(name, { name, parent, depth, subPackages: [], nodes: [] });
      continue;
    }

    const subPackages = [];
    const nodes = [];
    for (const child of children) {
      if (child.typeId === SUB_PACKAGE_TYPE_ID) {
        const childName = String(child.name).toUpperCase();
        subPackages.push(childName);
        if (depth + 1 <= depthLimit && !visited.has(childName)) {
          queue.push({ name: childName, parent: name, depth: depth + 1 });
        }
      } else {
        nodes.push(child);
      }
    }

    result.set(name, { name, parent, depth, subPackages, nodes });
    log.info(
      `Package ${name}: ${nodes.length} object(s), ${subPackages.length} sub-package(s).`
    );
  }

  return result;
}

module.exports = {
  walkPackage,
  SUB_PACKAGE_TYPE_ID,
};
