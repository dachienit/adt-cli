"use strict";

// Thin adapter between adt-cli and @abaplint/core.
//
// Responsibilities:
//   - Map ADT (typeId, name, include) -> abapGit-style filename that abaplint expects.
//   - Load an abaplint Config from a path / inline JSON / fallback to defaults.
//   - Run abaplint on a set of MemoryFile instances and return normalized issues.
//
// The module is CLI-agnostic: it does not read process.argv, it does not log to
// stderr, it just transforms inputs to outputs. That keeps it unit-testable and
// reusable from other entry points.

const fs = require("fs");
const path = require("path");

const abaplint = require("@abaplint/core");
const log = require("./logger");

// ---------------------------------------------------------------------------
// abapGit filename mapping
// ---------------------------------------------------------------------------
//
// abaplint parses files based on their filename suffix. The conventions below
// match how abapGit serializes ABAP objects to the filesystem (see
// https://docs.abapgit.org/ref-objtable.html).
//
// MVP supports the four most common ABAP object types. Unsupported types
// return an empty array; callers should skip them.

function objectToFilename(typeId, name, include) {
  if (!name) throw new Error("object name is required");
  const lower = String(name).toLowerCase();
  const inc = (include || "main").toLowerCase();

  switch (typeId) {
    case "CLAS/OC": {
      // Class includes -> distinct abapGit suffixes.
      const suffix =
        {
          main: "clas.abap",
          definitions: "clas.locals_def.abap",
          implementations: "clas.locals_imp.abap",
          macros: "clas.macros.abap",
          testclasses: "clas.testclasses.abap",
        }[inc] || null;
      if (!suffix) return null;
      return `${lower}.${suffix}`;
    }
    case "INTF/OI":
      // Interfaces only have a single source.
      return `${lower}.intf.abap`;
    case "PROG/P":
      return `${lower}.prog.abap`;
    case "PROG/I":
      // For lint purposes treat a standalone include as a program.
      return `${lower}.prog.abap`;
    case "FUGR/F":
    case "FUGR/FF":
    case "FUGR/I":
      return `${lower}.fugr.${inc}.abap`;
    default:
      return null;
  }
}

// All object types currently supported by the lint adapter.
const SUPPORTED_TYPE_IDS = new Set([
  "CLAS/OC",
  "INTF/OI",
  "PROG/P",
  "PROG/I",
  "FUGR/F",
  "FUGR/FF",
  "FUGR/I",
]);

function isSupportedType(typeId) {
  return SUPPORTED_TYPE_IDS.has(typeId);
}

// For a given (typeId), return the set of ADT include names that should be
// pulled and linted together. For classes we lint all four standard includes
// so abaplint can resolve cross-include references inside the same class.
function relevantIncludesFor(typeId) {
  if (typeId === "CLAS/OC") {
    return ["main", "definitions", "implementations", "macros", "testclasses"];
  }
  // FUGR families are fetched by the function-group fetcher,
  // which discovers includes/FMs dynamically (we cannot know names ahead of
  // time). The fetcher uses adapter.objectToFilename(typeId, name, member)
  // directly; this helper is left as a default fall-through.
  return ["main"];
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------
//
// Resolution order (first match wins):
//   1. explicit configPath argument (the CLI's --config flag)
//   2. profile.abaplintConfig (path stored on the active ADT profile)
//   3. abaplint built-in default config
//
// We never silently merge configs; the user picks one source. This keeps the
// behavior predictable when troubleshooting "why is rule X firing/not firing".

function loadConfig({ configPath, profile } = {}) {
  const chosenPath = configPath || (profile && profile.abaplintConfig) || null;

  if (chosenPath) {
    const abs = path.resolve(chosenPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`abaplint config not found: ${abs}`);
    }
    const raw = fs.readFileSync(abs, "utf8");
    log.info(`Using abaplint config: ${abs}`);
    try {
      return new abaplint.Config(raw);
    } catch (e) {
      throw new Error(`Invalid abaplint config at ${abs}: ${e.message}`);
    }
  }

  log.info("Using abaplint default config (no profile/CLI config set).");
  return abaplint.Config.getDefault();
}

// ---------------------------------------------------------------------------
// MemoryFile construction
// ---------------------------------------------------------------------------

function buildMemoryFile(typeId, name, include, sourceText) {
  const filename = objectToFilename(typeId, name, include);
  if (!filename) {
    throw new Error(
      `Unsupported (typeId, include) combination: ${typeId} / ${include}`
    );
  }
  return new abaplint.MemoryFile(filename, sourceText || "");
}

// ---------------------------------------------------------------------------
// Lint execution
// ---------------------------------------------------------------------------

function lintFiles(memoryFiles, config) {
  const registry = new abaplint.Registry(config);
  for (const f of memoryFiles) registry.addFile(f);
  registry.parse();
  return registry.findIssues();
}

// Build and parse a Registry from an array of MemoryFile instances.
// Returns the Registry so callers can do more than findIssues (skeleton, metrics, LSP, format, fix).
function buildPackageRegistry(memoryFiles, config) {
  const registry = new abaplint.Registry(config || abaplint.Config.getDefault());
  registry.addFiles(memoryFiles);
  registry.parse();
  return registry;
}

// Extract a lightweight JSON skeleton from a parsed Registry.
// Covers classes (methods, superclass, interfaces), interfaces, programs.
// Produces ~5-10x less token cost than raw ABAP source — suitable for LLM context.
function extractSkeleton(registry) {
  const skeleton = { classes: [], interfaces: [], programs: [], functionGroups: [] };

  for (const obj of registry.getObjects()) {
    const type = obj.getType();
    if (type === "CLAS") skeleton.classes.push(_buildClassSkeleton(obj));
    else if (type === "INTF") skeleton.interfaces.push(_buildInterfaceSkeleton(obj));
    else if (type === "PROG") skeleton.programs.push({ name: obj.getName() });
    else if (type === "FUGR") skeleton.functionGroups.push({ name: obj.getName() });
  }

  return skeleton;
}

// Rich class skeleton: methods with full parameter signatures + raises,
// attributes, constants, events, type definitions. Covers what an LLM needs
// to reason about the public contract without seeing implementation bodies.
//
// Bug fixes vs. previous shallow extractor:
//   1. Must call obj.getDefinition() — that's the rich ClassDefinition
//      populated by 5_syntax/find_global_definitions during Registry.parse().
//      The old code called obj.getClassDefinition() which returns the LIGHTER
//      4_file_information variant (no getSuperClass/getMethodDefinitions/etc.)
//      — every meaningful field threw and the try/catch silently dropped them.
//   2. MethodDefinitions.getAll() is a generator, not an array — wrap with
//      Array.from() before mapping.
//   3. ClassDefinition.getImplementing() returns `{name, partial}[]`, not
//      Identifier[] — the old code produced "[object Object]" strings.
function _buildClassSkeleton(obj) {
  const def = typeof obj.getDefinition === "function" ? obj.getDefinition() : null;
  if (!def) return { name: obj.getName(), error: "no class definition parsed" };

  const methods = _extractMethods(def, obj.getName());
  const interfaces = _extractImplementing(def, obj.getName());
  const attrBuckets = _extractAttributeBuckets(def, obj.getName());
  const events = _extractEvents(def, obj.getName());
  const types = _extractTypeDefs(def, obj.getName());

  return {
    name: obj.getName(),
    superClass: def.getSuperClass() || null,
    interfaces,
    isFinal: typeof def.isFinal === "function" ? def.isFinal() : false,
    isAbstract: typeof def.isAbstract === "function" ? def.isAbstract() : false,
    isForTesting: typeof def.isForTesting === "function" ? def.isForTesting() : false,
    createVisibility: _stringifyVisibility(_safeCall(def, "getCreateVisibility")),
    methodCount: methods.length,
    methods,
    attributes: attrBuckets.instance,
    staticAttributes: attrBuckets.static,
    constants: attrBuckets.constants,
    events,
    types,
  };
}

// Interface skeleton mirrors class skeleton but omits class-only fields
// (no superClass, no createVisibility, no static/instance distinction —
// everything in an interface is implicitly public + instance unless declared
// CLASS-METHODS / CLASS-DATA). Uses obj.getDefinition() — same rich path as
// classes; see _buildClassSkeleton for the reasoning.
function _buildInterfaceSkeleton(obj) {
  const def = typeof obj.getDefinition === "function" ? obj.getDefinition() : null;
  if (!def) return { name: obj.getName(), error: "no interface definition parsed" };

  const methods = _extractMethods(def, obj.getName());
  const interfaces = _extractImplementing(def, obj.getName());
  const attrBuckets = _extractAttributeBuckets(def, obj.getName());
  const events = _extractEvents(def, obj.getName());
  const types = _extractTypeDefs(def, obj.getName());

  return {
    name: obj.getName(),
    extendsInterfaces: interfaces,
    methodCount: methods.length,
    methods,
    attributes: attrBuckets.instance,
    staticAttributes: attrBuckets.static,
    constants: attrBuckets.constants,
    events,
    types,
  };
}

// Helpers shared by class and interface skeleton builders.
function _extractMethods(def, ownerName) {
  try {
    const defs = def.getMethodDefinitions();
    if (!defs) return [];
    // MethodDefinitions.getAll() is a generator (`*getAll()` in abaplint).
    // Materialize before mapping.
    return Array.from(defs.getAll()).map((m) => ({
      name: m.getName(),
      visibility: _stringifyVisibility(m.getVisibility()),
      isStatic: typeof m.isStatic === "function" ? m.isStatic() : false,
      isAbstract: typeof m.isAbstract === "function" ? m.isAbstract() : false,
      isRedefinition: typeof m.isRedefinition === "function" ? m.isRedefinition() : false,
      isEventHandler: typeof m.isEventHandler === "function" ? m.isEventHandler() : false,
      eventName: _safeCall(m, "getEventName"),
      eventClass: _safeCall(m, "getEventClass"),
      parameters: _extractParameters(m),
      raising: _safeCall(m, "getRaising") || [],
      exceptions: _safeCall(m, "getExceptions") || [],
    }));
  } catch (e) {
    log.debug(`Failed to extract methods for ${ownerName}: ${e.message}`);
    return [];
  }
}

function _extractParameters(method) {
  const params = typeof method.getParameters === "function" ? method.getParameters() : null;
  if (!params) return [];

  const optional = new Set(((params.getOptional && params.getOptional()) || []).map((n) =>
    String(n).toUpperCase()
  ));

  const out = [];
  const ret = typeof params.getReturning === "function" ? params.getReturning() : undefined;
  if (ret) out.push(_paramRecord(ret, "returning", optional, params));

  for (const p of _safeCall(params, "getImporting") || []) {
    out.push(_paramRecord(p, "importing", optional, params));
  }
  for (const p of _safeCall(params, "getExporting") || []) {
    out.push(_paramRecord(p, "exporting", optional, params));
  }
  for (const p of _safeCall(params, "getChanging") || []) {
    out.push(_paramRecord(p, "changing", optional, params));
  }
  return out;
}

function _paramRecord(typedIdentifier, kind, optionalSet, parametersOwner) {
  const name = typedIdentifier.getName();
  const nameUpper = String(name).toUpperCase();
  const isOptional = kind === "returning" ? false : optionalSet.has(nameUpper);
  let defaultExpr;
  try {
    defaultExpr = parametersOwner.getParameterDefault
      ? parametersOwner.getParameterDefault(nameUpper)
      : undefined;
  } catch (_) {
    defaultExpr = undefined;
  }
  return {
    name,
    kind,
    type: _stringifyType(typedIdentifier.getType && typedIdentifier.getType()),
    optional: isOptional,
    default: _stringifyExpressionNode(defaultExpr),
  };
}

function _extractImplementing(def, ownerName) {
  try {
    const list = typeof def.getImplementing === "function" ? def.getImplementing() : [];
    return (list || []).map((entry) => {
      if (entry && typeof entry === "object" && "name" in entry) {
        return entry.partial ? `${entry.name} (PARTIALLY IMPLEMENTED)` : entry.name;
      }
      return typeof entry?.getName === "function" ? entry.getName() : String(entry);
    });
  } catch (e) {
    log.debug(`Failed to extract interfaces for ${ownerName}: ${e.message}`);
    return [];
  }
}

function _extractAttributeBuckets(def, ownerName) {
  const out = { instance: [], static: [], constants: [] };
  try {
    const attrs = typeof def.getAttributes === "function" ? def.getAttributes() : null;
    if (!attrs) return out;
    for (const a of _safeCall(attrs, "getInstance") || []) out.instance.push(_attrRecord(a));
    for (const a of _safeCall(attrs, "getStatic") || []) out.static.push(_attrRecord(a));
    for (const a of _safeCall(attrs, "getConstants") || []) out.constants.push(_attrRecord(a));
  } catch (e) {
    log.debug(`Failed to extract attributes for ${ownerName}: ${e.message}`);
  }
  return out;
}

function _attrRecord(attr) {
  return {
    name: attr.getName(),
    visibility: _stringifyVisibility(_safeCall(attr, "getVisibility")),
    type: _stringifyType(attr.getType && attr.getType()),
    value: _stringifyValue(_safeCall(attr, "getValue")),
  };
}

function _extractEvents(def, ownerName) {
  try {
    const list = typeof def.getEvents === "function" ? def.getEvents() : [];
    return (list || []).map((e) => ({
      name: e.getName(),
      isStatic: typeof e.isStatic === "function" ? e.isStatic() : false,
      parameters: (_safeCall(e, "getParameters") || []).map((p) => ({
        name: p.getName(),
        type: _stringifyType(p.getType && p.getType()),
      })),
    }));
  } catch (e) {
    log.debug(`Failed to extract events for ${ownerName}: ${e.message}`);
    return [];
  }
}

function _extractTypeDefs(def, ownerName) {
  try {
    const tdefs = typeof def.getTypeDefinitions === "function" ? def.getTypeDefinitions() : null;
    if (!tdefs) return [];
    return (_safeCall(tdefs, "getAll") || []).map((entry) => ({
      name: entry?.type?.getName ? entry.type.getName() : String(entry?.type ?? ""),
      visibility: _stringifyVisibility(entry?.visibility),
      type: _stringifyType(entry?.type?.getType && entry.type.getType()),
    }));
  } catch (e) {
    log.debug(`Failed to extract type definitions for ${ownerName}: ${e.message}`);
    return [];
  }
}

// Best-effort string rendering for an abaplint AbstractType. Order of preference:
// toABAP() (most readable, e.g. "REF TO ZCL_FOO"), then toText() with markdown
// fences stripped, then qualifiedName / DDIC name, then constructor name.
function _stringifyType(t) {
  if (!t) return null;
  try {
    if (typeof t.toABAP === "function") {
      const v = t.toABAP();
      if (v) return String(v);
    }
    if (typeof t.toText === "function") {
      const v = t.toText();
      if (v) return String(v).replace(/`{1,3}/g, "").trim();
    }
    if (typeof t.getQualifiedName === "function") {
      const v = t.getQualifiedName();
      if (v) return String(v);
    }
    if (typeof t.getDDICName === "function") {
      const v = t.getDDICName();
      if (v) return String(v);
    }
    return t.constructor ? t.constructor.name : String(t);
  } catch (_) {
    return null;
  }
}

function _stringifyExpressionNode(node) {
  if (!node) return undefined;
  try {
    if (typeof node.concatTokens === "function") return node.concatTokens();
    if (typeof node.getFirstToken === "function") return node.getFirstToken().getStr();
    return String(node);
  } catch (_) {
    return undefined;
  }
}

// abaplint's Visibility is a numeric enum (1=Private, 2=Protected, 3=Public).
// Map to readable strings so the skeleton JSON is self-explanatory to an LLM.
const _VISIBILITY_BY_NUMBER = { 1: "Private", 2: "Protected", 3: "Public" };
function _stringifyVisibility(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return _VISIBILITY_BY_NUMBER[v] || String(v);
  if (typeof v === "string") return v;
  return String(v);
}

function _stringifyValue(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return _stringifyExpressionNode(v);
}

function _safeCall(target, method) {
  if (!target || typeof target[method] !== "function") return undefined;
  try {
    return target[method]();
  } catch (_) {
    return undefined;
  }
}

// Extract per-class cyclomatic complexity and method length metrics from a parsed Registry.
// Uses CyclomaticComplexityStats.run() and MethodLengthStats.run() static methods.
function extractMetrics(registry) {
  const results = [];
  let walked = 0;
  let classSeen = 0;

  for (const obj of registry.getObjects()) {
    walked++;
    if (obj.getType() !== "CLAS") continue;
    classSeen++;

    let ccResults = [];
    let mlResults = [];
    try {
      ccResults = abaplint.CyclomaticComplexityStats.run(obj) || [];
    } catch (e) {
      log.debug(`extractMetrics: CyclomaticComplexityStats threw for ${obj.getName()}: ${e.message}`);
    }
    try {
      mlResults = abaplint.MethodLengthStats.run(obj) || [];
    } catch (e) {
      log.debug(`extractMetrics: MethodLengthStats threw for ${obj.getName()}: ${e.message}`);
    }

    const methodMap = Object.create(null);
    for (const cc of ccResults) {
      if (!methodMap[cc.name]) methodMap[cc.name] = Object.create(null);
      methodMap[cc.name].complexity = cc.count;
    }
    for (const ml of mlResults) {
      if (!methodMap[ml.name]) methodMap[ml.name] = Object.create(null);
      methodMap[ml.name].length = ml.count;
    }

    const methods = Object.entries(methodMap)
      .map(([name, m]) => ({ name, complexity: m.complexity ?? 0, length: m.length ?? 0 }))
      .sort((a, b) => b.complexity - a.complexity);

    const maxComplexity = methods.length ? Math.max(...methods.map((m) => m.complexity)) : 0;
    const maxMethodLength = methods.length ? Math.max(...methods.map((m) => m.length)) : 0;

    log.debug(
      `extractMetrics: ${obj.getName()} ccResults=${ccResults.length} mlResults=${mlResults.length} methodMapKeys=${Object.keys(methodMap).length}`
    );

    results.push({
      name: obj.getName(),
      methodCount: methods.length,
      maxComplexity,
      maxMethodLength,
      isGodClass: methods.length > 30,
      methods,
    });
  }

  log.info(
    `extractMetrics: registry walked=${walked} CLAS seen=${classSeen} results=${results.length}`
  );

  return results.sort((a, b) => b.maxComplexity - a.maxComplexity);
}

// Run PrettyPrinter on every ABAP file in the Registry.
// Returns an array of { filename, source } for all formatted files.
function applyPrettyPrinter(registry) {
  const config = registry.getConfig();
  const formatted = [];

  for (const obj of registry.getObjects()) {
    for (const file of obj.getABAPFiles ? obj.getABAPFiles() : []) {
      try {
        const pp = new abaplint.PrettyPrinter(file, config);
        formatted.push({ filename: file.getFilename(), source: pp.run() });
      } catch (e) {
        log.warn(`PrettyPrinter failed on ${file.getFilename()}: ${e.message}`);
      }
    }
  }

  return formatted;
}

// Apply all auto-fixable issues in the Registry via Edits.applyEditList.
// Returns { applied, files } where files has the updated source per filename.
// Quick-fix edits may conflict if two fixes touch the same range — wraps in try/catch.
function applyQuickFixes(registry) {
  const issues = registry.findIssues();
  const fixableEdits = issues.map((i) => i.getDefaultFix()).filter(Boolean);

  if (!fixableEdits.length) return { applied: 0, files: [] };

  try {
    abaplint.Edits.applyEditList(registry, fixableEdits);
  } catch (e) {
    throw new Error(`Quick-fix apply failed (possible edit conflict): ${e.message}`);
  }

  registry.parse();

  const files = [];
  for (const obj of registry.getObjects()) {
    for (const file of obj.getABAPFiles ? obj.getABAPFiles() : []) {
      files.push({ filename: file.getFilename(), source: file.getRaw() });
    }
  }

  return { applied: fixableEdits.length, files };
}

// ---------------------------------------------------------------------------
// Issue normalization
// ---------------------------------------------------------------------------
//
// abaplint Issue objects use getter methods; we expand them into plain JSON so
// downstream consumers (scripts, agents, CI) can read fields without depending
// on @abaplint/core.

function normalizeIssue(issue) {
  const start = issue.getStart();
  const end = issue.getEnd();
  return {
    file: issue.getFilename(),
    key: issue.getKey(),
    message: issue.getMessage(),
    severity: issue.getSeverity(),
    start: { row: start.getRow(), col: start.getCol() },
    end: { row: end.getRow(), col: end.getCol() },
  };
}

function summarize(issues) {
  const normalized = issues.map(normalizeIssue);
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const i of normalized) {
    if (i.severity === "Error") errors += 1;
    else if (i.severity === "Warning") warnings += 1;
    else infos += 1;
  }
  return {
    issueCount: normalized.length,
    errorCount: errors,
    warningCount: warnings,
    infoCount: infos,
    issues: normalized,
  };
}

module.exports = {
  objectToFilename,
  isSupportedType,
  relevantIncludesFor,
  loadConfig,
  buildMemoryFile,
  lintFiles,
  normalizeIssue,
  summarize,
  buildPackageRegistry,
  extractSkeleton,
  extractMetrics,
  applyPrettyPrinter,
  applyQuickFixes,
};
