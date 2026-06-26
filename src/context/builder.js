"use strict";

// Orchestrate the build of ONE package bundle:
//   1. Filter the package's leaf nodes to types supported in this phase.
//   2. Fetch per-object adtcore metadata (objLib.structure).
//   3. Fetch source for CLAS/INTF/PROG via objLib.fetchObjectAsMemoryFiles
//      and parse them through @abaplint/core into a Registry.
//   4. Extract a rich skeleton (abaplintAdapter.extractSkeleton).
//   5. Compose manifest.json + structure.json + CONTEXT.md and write them
//      to <outDir>/<PACKAGE>/ respecting the chosen overwrite policy.
//
// Phase 1 deliberately ships without token budgeting, source bundling,
// dependency graph, FUGR/DDIC/CDS support, where-used, or docs. Those land
// in Phase 2-4 per the plan; the writer module surface is shaped to absorb
// those additions without re-shuffling this orchestrator.

const fs = require("fs");
const path = require("path");

const log = require("../logger");
const objLib = require("../objLib");
const adapter = require("../abaplintAdapter");
const { fetchObjectMetadata, extractPackageMetadata } = require("./metadataExtractor");
const { buildManifest, writeManifest } = require("./writers/manifestWriter");
const { buildStructure, writeStructure } = require("./writers/structureWriter");
const { buildContextMd, writeContextMd } = require("./writers/contextMdWriter");
const { buildMetrics, writeMetrics } = require("./writers/metricsWriter");
const { writeDependencies } = require("./writers/dependenciesWriter");
const { buildDependencyGraph } = require("./dependencyGraph");
const { fetchDdicObject, isDdicTypeId } = require("./objectFetchers/ddicFetcher");
const { fetchFunctionGroup } = require("./objectFetchers/functionGroupFetcher");
const { buildDdicEntry } = require("./skeleton/ddicSkeleton");
const { buildDdic, writeDdic } = require("./writers/ddicWriter");
const { buildFunctionGroupSkeleton } = require("./skeleton/functionGroupSkeleton");
const { writeSources } = require("./writers/sourcesWriter");
const { strip: stripSource, isLevel: isStripLevel, DEFAULT_LEVEL: DEFAULT_STRIP_LEVEL } = require("./sourceStripper");
const { estimate, estimateObject, softCapFor, degrade, tokenizerName } = require("./tokenBudget");
const { fetchCdsObject, isCdsTypeId } = require("./objectFetchers/cdsFetcher");
const { fetchPackageLongText, fetchObjectLongText } = require("./docsFetcher");
const { writeDocs } = require("./writers/docsWriter");
const { enrichWithWhereUsed } = require("./dependencyGraph");

// Build a bundle for one package and write it to disk.
//
// pkgEntry: { name, parent, depth, subPackages, nodes } from packageWalker.
// opts: {
//   outRoot:        absolute path for the parent of all package folders
//   abaplintConfig: abaplint Config (loaded by caller)
//   writeMode:      "overwrite" | "clean" | "refuse"
//   targetModel:    string | null  (drives soft cap when --max-tokens not set)
//   maxTokens:      number | null  (override soft cap)
//   includeSource:  boolean | string  (true = all, string = glob)
//   stripLevel:     "light"|"medium"|"aggressive"|null  (strip pipeline)
//   keepGoing:      bool — on object-level failures, continue rather than throw
//   dryRun:         bool — log intended actions, do not fetch sources or write
//   namespacePrefixes: string[] | null — name-prefix filter forwarded to the
//                   FUGR fetcher. When set, children outside the prefixes
//                   (e.g. LSVIM*, RSVIM*) are dropped BEFORE their source GET,
//                   preventing the SE54-generated FUGR hang. `null` = no filter.
// }
//
// Returns: { packageDir, written, skipped, supported, unsupported, errors }
async function buildBundleForPackage(client, pkgEntry, opts) {
  const outRoot = opts.outRoot;
  const writeMode = opts.writeMode || "overwrite";
  const packageDir = path.join(outRoot, _safeFolder(pkgEntry.name));

  // --- Overwrite policy gate ---------------------------------------------
  const exists = fs.existsSync(packageDir);
  if (exists) {
    if (writeMode === "refuse") {
      log.warn(`Skipping ${pkgEntry.name}: folder exists and --no-overwrite is set (${packageDir}).`);
      return {
        packageDir,
        written: [],
        skipped: true,
        skipReason: "folder exists and --no-overwrite is set",
        supported: 0,
        unsupported: 0,
        errors: [],
      };
    }
    if (writeMode === "clean" && !opts.dryRun) {
      log.info(`Cleaning ${packageDir} before write (--clean).`);
      fs.rmSync(packageDir, { recursive: true, force: true });
    }
  }
  if (!opts.dryRun) {
    fs.mkdirSync(packageDir, { recursive: true });
  }

  // --- Classify nodes by type --------------------------------------------
  const abapNodes = []; // CLAS / INTF / PROG / INCL (abaplint-supported)
  const fugrNodes = []; // FUGR/F groups (specialized fetcher)
  const ddicNodes = []; // TABL / DTEL / DOMA / STRU / VIEW
  const cdsNodes = [];  // DDLS / DCLS (CDS views, access controls)
  const unsupported = [];
  for (const n of pkgEntry.nodes) {
    if (n.typeId.startsWith("FUGR/F")) {
      fugrNodes.push(n);
    } else if (adapter.isSupportedType(n.typeId)) {
      abapNodes.push(n);
    } else if (isDdicTypeId(n.typeId)) {
      ddicNodes.push(n);
    } else if (isCdsTypeId(n.typeId)) {
      cdsNodes.push(n);
    } else {
      unsupported.push(n);
    }
  }
  const supportedTotal = abapNodes.length + fugrNodes.length + ddicNodes.length + cdsNodes.length;
  log.info(
    `Package ${pkgEntry.name}: ${supportedTotal} supported (${abapNodes.length} ABAP-OO, ${fugrNodes.length} FUGR, ${ddicNodes.length} DDIC, ${cdsNodes.length} CDS), ${unsupported.length} unsupported.`
  );

  // --- Dry-run short-circuit ---------------------------------------------
  if (opts.dryRun) {
    log.info(
      `[dry-run] Would write to ${packageDir}: manifest.json, structure.json, dependencies.json, metrics.json` +
        (ddicNodes.length > 0 ? ", ddic.json" : "") +
        (opts.includeSource ? ", sources/" : "") +
        ", CONTEXT.md"
    );
    return {
      packageDir,
      written: [],
      skipped: false,
      supported: supportedTotal,
      unsupported: unsupported.length,
      errors: [],
      dryRun: true,
    };
  }

  // --- Package-level metadata --------------------------------------------
  const packageMeta = await extractPackageMetadata(client, pkgEntry.name);
  // packageWalker already gave us the parent; trust it over what the package
  // structure XML might say (which is often blank in abapGit-managed packages).
  packageMeta.parent = pkgEntry.parent;

  // --- Per-object metadata + source fetch --------------------------------
  const errors = [];
  const objectMetas = [];
  const memoryFiles = [];
  // Collect raw sources per filename for sources/ output,
  // plus DDIC and FUGR sub-skeletons.
  const rawSources = {}; // filename -> raw text
  const ddicEntries = [];
  const fugrSkeletons = [];

  // --- 1. ABAP-OO (CLAS / INTF / PROG / INCL) ---------------------------
  for (const node of abapNodes) {
    objectMetas.push(await _safeFetchMetadata(client, node, errors, opts));
    const objectUrl = node.uri || _safeInferUrl(node);
    if (!objectUrl) {
      errors.push({ object: node.name, stage: "url-inference", error: "no uri and no inferable URL" });
      continue;
    }
    try {
      const files = await objLib.fetchObjectAsMemoryFiles(client, objectUrl, node.typeId, node.name, null);
      for (const f of files) {
        memoryFiles.push(f);
        rawSources[f.getFilename()] = f.getRaw();
      }
    } catch (e) {
      errors.push({ object: node.name, stage: "source", error: e.message });
      if (!opts.keepGoing) throw e;
    }
  }

  // --- 2. FUGR (function groups) ----------------------------------------
  for (const node of fugrNodes) {
    objectMetas.push(await _safeFetchMetadata(client, node, errors, opts));
    try {
      const fetched = await fetchFunctionGroup(client, node, {
        namespacePrefixes: opts.namespacePrefixes || null,
      });
      for (const f of fetched.memoryFiles) {
        memoryFiles.push(f);
        rawSources[f.getFilename()] = f.getRaw();
      }
      fugrSkeletons.push(buildFunctionGroupSkeleton(fetched));
    } catch (e) {
      errors.push({ object: node.name, stage: "fugr", error: e.message });
      if (!opts.keepGoing) throw e;
    }
  }

  // --- 3. DDIC (TABL / DTEL / DOMA / STRU / VIEW) -----------------------
  for (const node of ddicNodes) {
    objectMetas.push(await _safeFetchMetadata(client, node, errors, opts));
    try {
      const fetched = await fetchDdicObject(client, node);
      const entry = buildDdicEntry(fetched);
      if (entry) ddicEntries.push(entry);
    } catch (e) {
      errors.push({ object: node.name, stage: "ddic", error: e.message });
      if (!opts.keepGoing) throw e;
    }
  }

  const cdsEntries = [];
  for (const node of cdsNodes) {
    objectMetas.push(await _safeFetchMetadata(client, node, errors, opts));
    try {
      const fetched = await fetchCdsObject(client, node);
      cdsEntries.push(fetched);
      if (fetched.source && fetched.sourceFilename) {
        rawSources[fetched.sourceFilename] = fetched.source;
      }
    } catch (e) {
      errors.push({ object: node.name, stage: "cds", error: e.message });
      if (!opts.keepGoing) throw e;
    }
  }

  // --- 4. Unsupported types — still surface in manifest -----------------
  for (const u of unsupported) {
    objectMetas.push({
      typeId: u.typeId,
      type: u.typeId.split("/")[0],
      name: u.name,
      uri: u.uri || null,
      description: u.description || null,
      unsupported: true,
    });
  }

  // --- Parse into abaplint Registry + extract rich skeleton --------------
  let skeleton = { classes: [], interfaces: [], programs: [], functionGroups: [] };
  let registry = null;
  let metricsList = [];
  let dependencyGraph = null;
  if (memoryFiles.length > 0) {
    try {
      const config = opts.abaplintConfig;
      registry = adapter.buildPackageRegistry(memoryFiles, config);
      skeleton = adapter.extractSkeleton(registry);
      try {
        metricsList = adapter.extractMetrics(registry);
      } catch (e) {
        log.warn(`extractMetrics threw for ${pkgEntry.name}: ${e.message}`);
        if (e && e.stack) log.debug(e.stack);
        errors.push({ object: pkgEntry.name, stage: "metrics", error: e.message });
      }
      try {
        dependencyGraph = buildDependencyGraph(registry, skeleton, { package: pkgEntry.name });
      } catch (e) {
        log.warn(`buildDependencyGraph threw for ${pkgEntry.name}: ${e.message}`);
        if (e && e.stack) log.debug(e.stack);
        errors.push({ object: pkgEntry.name, stage: "dependency-graph", error: e.message });
      }
    } catch (e) {
      log.warn(`abaplint-parse threw for ${pkgEntry.name}: ${e.message}`);
      if (e && e.stack) log.debug(e.stack);
      errors.push({ object: pkgEntry.name, stage: "abaplint-parse", error: e.message });
      if (!opts.keepGoing) throw e;
    }
  } else {
    log.info(`Package ${pkgEntry.name}: no source files fetched — skeleton will be empty.`);
  }

  if (fugrSkeletons.length > 0) {
    const existing = new Map(skeleton.functionGroups.map((fg) => [fg.name, fg]));
    for (const fg of fugrSkeletons) existing.set(fg.name, fg);
    skeleton.functionGroups = Array.from(existing.values());
  }

  if (cdsEntries.length > 0 && dependencyGraph) {
    for (const cds of cdsEntries) {
      const fromId = `DDLS:${cds.name}`;
      if (!dependencyGraph.nodes.find((n) => n.id === fromId)) {
        dependencyGraph.nodes.push({ id: fromId, type: "DDLS", name: cds.name, external: false });
      }
      for (const tbl of cds.fromTables || []) {
        const toId = `TABL:${tbl}`;
        if (!dependencyGraph.nodes.find((n) => n.id === toId)) {
          dependencyGraph.nodes.push({ id: toId, type: "TABL", name: tbl, external: true });
        }
        dependencyGraph.edges.push({ from: fromId, to: toId, kind: "readsTable", source: "cds-parse" });
      }
    }
    // Re-deduplicate + recount.
    dependencyGraph.nodes.sort((a, b) => a.id.localeCompare(b.id));
    const seen = new Set();
    dependencyGraph.edges = dependencyGraph.edges.filter((e) => {
      const k = `${e.from}|${e.to}|${e.kind}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    dependencyGraph.nodeCount = dependencyGraph.nodes.length;
    dependencyGraph.edgeCount = dependencyGraph.edges.length;
  }

  if (opts.withWhereUsed && dependencyGraph) {
    const internalForUsage = [...abapNodes, ...fugrNodes, ...ddicNodes, ...cdsNodes].filter((n) => n.uri);
    try {
      dependencyGraph = await enrichWithWhereUsed(client, dependencyGraph, internalForUsage);
    } catch (e) {
      errors.push({ object: pkgEntry.name, stage: "where-used", error: e.message });
    }
  }

  const docs = [];
  if (opts.withDocs) {
    try {
      const pkgDoc = await fetchPackageLongText(client, pkgEntry.name);
      if (pkgDoc) docs.push(pkgDoc);
    } catch (e) {
      errors.push({ object: pkgEntry.name, stage: "docs", error: e.message });
    }
    for (const node of [...abapNodes, ...fugrNodes, ...ddicNodes, ...cdsNodes]) {
      try {
        const objDoc = await fetchObjectLongText(client, node);
        if (objDoc) docs.push(objDoc);
      } catch (e) {
        errors.push({ object: node.name, stage: "docs", error: e.message });
      }
    }
    log.info(`docs fetched: ${docs.length}`);
  }

  let sourcesPayload = null;
  if (opts.includeSource) {
    sourcesPayload = _filterSourcesForInclude(rawSources, opts.includeSource);
    if (opts.stripLevel) {
      const level = isStripLevel(opts.stripLevel) ? opts.stripLevel : DEFAULT_STRIP_LEVEL;
      for (const [name, src] of Object.entries(sourcesPayload)) {
        sourcesPayload[name] = stripSource(src, level);
      }
    }
  }

  // --- Compose payloads --------------------------------------------------
  const softCap = softCapFor(opts.targetModel, opts.maxTokens);

  const structurePayload = buildStructure(skeleton, { package: pkgEntry.name });
  const metricsPayload = buildMetrics(metricsList, { package: pkgEntry.name });
  const dependenciesPayload =
    dependencyGraph || {
      schemaVersion: 1,
      package: pkgEntry.name,
      nodeCount: 0,
      edgeCount: 0,
      nodes: [],
      edges: [],
    };
  const ddicPayload = ddicEntries.length > 0 ? buildDdic(ddicEntries, { package: pkgEntry.name }) : null;

  // Initial manifest (token estimate filled in after degradation).
  let manifest = buildManifest({
    packageMeta,
    objects: objectMetas,
    subPackages: pkgEntry.subPackages,
    generatedAt: new Date().toISOString(),
    writeMode,
    targetModel: opts.targetModel || null,
    softCap,
    tokenEstimate: null,
  });

  const plan = {
    manifest,
    structure: structurePayload,
    dependencies: dependenciesPayload,
    metrics: metricsPayload,
    ddic: ddicPayload,
    sources: sourcesPayload,
    docs: docs.length > 0 ? docs : null,
  };
  const degradationResult = degrade(plan, softCap);
  const degradations = degradationResult.degradations;
  // Re-read possibly-mutated sections.
  manifest = plan.manifest;
  const finalSources = plan.sources || null;
  const finalDdic = plan.ddic || null;
  const finalMetrics = plan.metrics || metricsPayload;
  const finalDocs = plan.docs || null;

  // Compute per-section token estimates for manifest + CONTEXT.md.
  const perSection = {
    manifest: estimateObject(manifest),
    structure: estimateObject(structurePayload),
    dependencies: estimateObject(dependenciesPayload),
    metrics: estimateObject(finalMetrics),
    ddic: finalDdic ? estimateObject(finalDdic) : 0,
    sources: finalSources
      ? Object.values(finalSources).reduce((acc, t) => acc + estimate(t), 0)
      : 0,
    docs: finalDocs ? finalDocs.reduce((acc, d) => acc + estimate(d.content || ""), 0) : 0,
  };
  perSection.total = Object.values(perSection).reduce((a, b) => a + b, 0);
  manifest.tokenEstimate = perSection;
  manifest.degradations = degradations;
  manifest.tokenizer = tokenizerName();

  const files = [
    { name: "manifest.json", description: "object-level metadata + inventory", tokens: perSection.manifest },
    { name: "structure.json", description: "rich skeleton (classes, interfaces, programs, function groups)", tokens: perSection.structure },
    { name: "dependencies.json", description: "cross-object dependency graph (outbound edges)", tokens: perSection.dependencies },
    { name: "metrics.json", description: "per-class cyclomatic complexity + method length", tokens: perSection.metrics },
  ];
  if (finalDdic) {
    files.push({ name: "ddic.json", description: "DDIC descriptors (tables, data elements, domains)", tokens: perSection.ddic });
  }
  if (finalSources && Object.keys(finalSources).length > 0) {
    files.push({
      name: "sources/",
      description: `raw ABAP source for ${Object.keys(finalSources).length} object(s)${opts.stripLevel ? ` (--strip=${opts.stripLevel})` : ""}`,
      tokens: perSection.sources,
    });
  }
  if (finalDocs && finalDocs.length > 0) {
    files.push({
      name: "docs/",
      description: `long-text documentation (${finalDocs.length} entr${finalDocs.length === 1 ? "y" : "ies"})`,
      tokens: perSection.docs,
    });
  }

  const contextMd = buildContextMd({
    manifest,
    files,
    degradations,
    graph: dependencyGraph,
    metrics: metricsList,
  });

  // --- Write to disk -----------------------------------------------------
  const written = [];
  written.push(writeManifest(packageDir, manifest));
  written.push(writeStructure(packageDir, structurePayload));
  written.push(writeDependencies(packageDir, dependenciesPayload));
  written.push(writeMetrics(packageDir, finalMetrics));
  if (finalDdic) {
    written.push(writeDdic(packageDir, finalDdic));
  }
  if (finalSources && Object.keys(finalSources).length > 0) {
    written.push(...writeSources(packageDir, finalSources));
  }
  if (finalDocs && finalDocs.length > 0) {
    written.push(...writeDocs(packageDir, finalDocs));
  }
  written.push(writeContextMd(packageDir, contextMd));

  if (errors.length > 0) {
    log.warn(`Package ${pkgEntry.name}: ${errors.length} error(s) recorded during build.`);
  }
  if (degradations.length > 0) {
    log.warn(
      `Package ${pkgEntry.name}: ${degradations.length} degradation(s) applied to fit budget (${perSection.total}/${softCap} tokens).`
    );
  }
  log.ok(`Bundle written: ${packageDir} (~${perSection.total} tokens, cap ${softCap})`);
  return {
    packageDir,
    written,
    skipped: false,
    supported: supportedTotal,
    unsupported: unsupported.length,
    errors,
    tokenEstimate: perSection,
    softCap,
    degradations,
  };
}

// Filesystem-safe package folder name. SAP package names use `$` (local
// packages) and `/` (namespaces), both of which we want to preserve in a
// portable way — abapGit folder convention rewrites `/` → `#` and we adopt
// the same here.
function _safeFolder(name) {
  return String(name)
    .replace(/\//g, "#")
    .replace(/[\\:*?"<>|]/g, "_");
}

function _safeInferUrl(node) {
  try {
    return objLib.inferUrlFromTypeAndName(node.typeId, node.name);
  } catch (_) {
    return null;
  }
}

async function _safeFetchMetadata(client, node, errors, opts) {
  try {
    return await fetchObjectMetadata(client, node);
  } catch (e) {
    errors.push({ object: node.name, stage: "metadata", error: e.message });
    if (!opts.keepGoing) throw e;
    return { typeId: node.typeId, name: node.name, error: e.message };
  }
}

// Filter the raw source map by --include-source (boolean = all, string = glob).
// Glob is simple: `*` matches any chars, `?` matches single char, comma joins
// alternatives. Matched against UPPER-cased object name parsed from filename.
function _filterSourcesForInclude(rawSources, includeOpt) {
  if (!rawSources || Object.keys(rawSources).length === 0) return {};
  if (includeOpt === true || includeOpt === "" || includeOpt === "*") {
    return { ...rawSources };
  }
  const globs = String(includeOpt)
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)
    .map(_globToRegex);
  const out = {};
  for (const [filename, content] of Object.entries(rawSources)) {
    const objName = filename.split(".")[0].toUpperCase();
    if (globs.some((re) => re.test(objName))) {
      out[filename] = content;
    }
  }
  return out;
}

function _globToRegex(glob) {
  const escaped = String(glob)
    .toUpperCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

module.exports = { buildBundleForPackage };
