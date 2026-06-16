"use strict";

// Pull-config: which ABAP typeIds should `adt object pull` mirror to local?
//
// Resolution order (lowest → highest precedence):
//   1. Built-in DEFAULT_PULL_TYPES (this file)
//   2. User-level    ~/.adt-cli/pull-config.json
//   3. Project-level <cwd>/.adt-cli/pull-config.json
//   4. CLI flags     --include-only X,Y (full override)
//                    --skip-types X,Y   (subtract from effective)
//
// On first run the user-level file is bootstrapped from the built-in default
// so the user can edit it without searching for docs.
//
// File schema:
//   { "version": 1, "pullTypes": ["CLAS/OC", "INTF/OI", ...] }
//
// Unknown typeIds (not in pullRegistry.KNOWN_TYPE_IDS) are dropped with a
// warn log; the resolver never throws on bad input.

const fs = require("fs");
const os = require("os");
const path = require("path");

const log = require("./logger");
const pullRegistry = require("./pullRegistry");
//IYH1HC add — keep matchesNamespace in a standalone module so that
// functionGroupFetcher can import it without creating a circular dependency
// (pullConfig → pullRegistry → fugrFetcher → pullConfig).
const { matchesNamespace } = require("./namespaceUtil");

// Built-in default — the single source of truth for "what does an out-of-box
// pull mirror". Pre-approved with the user (CLAS, INTF, PROG, INCL, FUGR
// family, DDIC code+data + CDS). Niche/runtime-only typeIds (MSAG, TRAN, TOBJ,
// SUSH, VIEW) are deliberately excluded — user opts in via CLI or config edit.
const DEFAULT_PULL_TYPES = Object.freeze([
  // Code
  "CLAS/OC",
  "INTF/OI",
  "PROG/P",
  "PROG/I",
  // Function group family
  "FUGR/F",
  "FUGR/FF",
  "FUGR/I",
  // DDIC data
  "TABL/DT",
  "TABL/DS",
  "STRU/DS",
  "DTEL/DE",
  "DOMA/DD",
  "TTYP/DA",
  // CDS
  "DDLS/DF",
  "DDLS/DL",
  "DCLS/DL",
]);

// Default namespace prefixes for Bosch customer code. Names starting with any
// of these prefixes (case-insensitive) belong to customer space and should be
// pulled. Standard SAP code (LSVIMTOP, RFC*, SAPL*, MFOO, ...) is excluded.
// Used for bootstrap content + fallback when a config file omits the field.
const DEFAULT_NAMESPACE_PREFIXES = Object.freeze(["Z", "Y", "/RB"]);

//IYH1HC comment - matchesNamespace moved to src/namespaceUtil.js to break the
//IYH1HC comment - pullConfig → pullRegistry → fugrFetcher → pullConfig cycle.
//IYH1HC comment - Re-exported below via module.exports for backward compat.

const CONFIG_FILE_NAME = "pull-config.json";

function _userConfigPath() {
  return path.join(os.homedir(), ".adt-cli", CONFIG_FILE_NAME);
}

function _projectConfigPath(projectDir) {
  return path.join(projectDir || process.cwd(), ".adt-cli", CONFIG_FILE_NAME);
}

// Returns { pullTypes, namespacePrefixes } parsed from a config file.
// Each field is null when missing/invalid (caller falls back accordingly).
function _readConfig(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      log.warn(`pull-config: ${filePath} not a JSON object — ignored`);
      return { pullTypes: null, namespacePrefixes: null };
    }
    const pullTypes = Array.isArray(parsed.pullTypes)
      ? parsed.pullTypes.filter((t) => typeof t === "string")
      : null;
    const namespacePrefixes = Array.isArray(parsed.namespacePrefixes)
      ? parsed.namespacePrefixes.filter((t) => typeof t === "string")
      : null;
    return { pullTypes, namespacePrefixes };
  } catch (e) {
    log.warn(`pull-config: failed to read ${filePath}: ${e.message} — ignored`);
    return { pullTypes: null, namespacePrefixes: null };
  }
}

function _writeDefault(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const body = {
      version: 1,
      pullTypes: Array.from(DEFAULT_PULL_TYPES),
      namespacePrefixes: Array.from(DEFAULT_NAMESPACE_PREFIXES),
    };
    fs.writeFileSync(filePath, JSON.stringify(body, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    log.info(`Created default pull config at ${filePath}`);
  } catch (e) {
    log.warn(`pull-config: cannot bootstrap ${filePath}: ${e.message}`);
  }
}

// Returns the resolved policy:
//   {
//     types:             string[],  // typeIds to pull
//     namespacePrefixes: string[],  // name prefixes to include
//     source:            string,    // provenance description
//     namespaceSource:   string     // provenance for namespacePrefixes
//   }
// Logs every step so `adt object pull --print-config` can show provenance.
//
// Resolution rules:
//   pullTypes:
//     missing field in a layer  → that layer leaves prior value alone
//     []                        → that layer leaves prior value alone (treated as "no override")
//     [..items..]               → replaces prior value
//   namespacePrefixes:
//     missing field             → that layer leaves prior value alone
//     []                        → that layer SETS to [] (user explicitly clears → blocks all)
//     [..items..]               → replaces prior value
//
// The asymmetry is intentional. An empty pullTypes is meaningless (= "pull
// nothing of any type"), so we treat it as "not specified". An empty
// namespacePrefixes is the safe-block signal per user policy.
function loadEffectiveTypes(opts = {}) {
  const projectDir = opts.projectDir || process.cwd();
  const cliIncludeOnly = Array.isArray(opts.cliIncludeOnly)
    ? opts.cliIncludeOnly
    : null;
  const cliSkipTypes = Array.isArray(opts.cliSkipTypes) ? opts.cliSkipTypes : [];
  const cliNamespacePrefixes = Array.isArray(opts.cliNamespacePrefixes)
    ? opts.cliNamespacePrefixes
    : null;

  // 1. Built-in default
  let types = Array.from(DEFAULT_PULL_TYPES);
  let source = "built-in default";
  let namespacePrefixes = Array.from(DEFAULT_NAMESPACE_PREFIXES);
  let namespaceSource = "built-in default";

  // 2. User-level override (bootstrap if missing)
  const userPath = _userConfigPath();
  if (fs.existsSync(userPath)) {
    const cfg = _readConfig(userPath);
    if (cfg.pullTypes && cfg.pullTypes.length > 0) {
      types = cfg.pullTypes;
      source = `user config (${userPath})`;
    }
    if (cfg.namespacePrefixes !== null) {
      namespacePrefixes = cfg.namespacePrefixes;
      namespaceSource = `user config (${userPath})`;
    }
  } else {
    _writeDefault(userPath);
    source = `bootstrapped user config (${userPath})`;
    namespaceSource = `bootstrapped user config (${userPath})`;
  }

  // 3. Project-level override (full replace per field, not merge)
  const projPath = _projectConfigPath(projectDir);
  if (fs.existsSync(projPath)) {
    const cfg = _readConfig(projPath);
    if (cfg.pullTypes && cfg.pullTypes.length > 0) {
      types = cfg.pullTypes;
      source = `project config (${projPath})`;
    }
    if (cfg.namespacePrefixes !== null) {
      namespacePrefixes = cfg.namespacePrefixes;
      namespaceSource = `project config (${projPath})`;
    }
  }

  // 4. CLI overrides
  if (cliIncludeOnly && cliIncludeOnly.length > 0) {
    types = cliIncludeOnly.slice();
    source = `CLI --include-only`;
  }
  if (cliSkipTypes.length > 0) {
    types = types.filter((t) => !cliSkipTypes.includes(t));
    source += ` (− CLI --skip-types)`;
  }
  if (cliNamespacePrefixes !== null) {
    namespacePrefixes = cliNamespacePrefixes.slice();
    namespaceSource = `CLI --namespace-prefixes`;
  }

  // Validate types against pullRegistry
  const known = new Set(pullRegistry.KNOWN_TYPE_IDS);
  const ok = [];
  for (const t of types) {
    if (known.has(t)) {
      ok.push(t);
    } else {
      log.warn(`pull-config: unknown typeId "${t}" — ignored`);
    }
  }

  return {
    types: ok,
    namespacePrefixes,
    source,
    namespaceSource,
  };
}

module.exports = {
  DEFAULT_PULL_TYPES,
  DEFAULT_NAMESPACE_PREFIXES,
  loadEffectiveTypes,
  matchesNamespace,
  // Exported for tests / introspection
  _userConfigPath,
  _projectConfigPath,
};
