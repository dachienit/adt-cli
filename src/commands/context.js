"use strict";

const path = require("path");
const fs = require("fs");

const log = require("../logger");
const adapter = require("../abaplintAdapter");
const { walkPackage } = require("../context/packageWalker");
const { buildBundleForPackage } = require("../context/builder");
const { renderJson } = require("../output");
const tokenBudget = require("../context/tokenBudget");
const pullConfig = require("../pullConfig");

const DEFAULT_OUT_DIR = "./adt-context";

function register(context) {
  // ---------- adt context build -----------------------------------------
  context
    .command("build")
    .description(
      "Walk an ABAP package and emit a multi-file context bundle per package " +
        "(skeleton + metadata + reading guide) ready for LLM analysis."
    )
    .requiredOption("--package <pkg>", "ABAP package name to extract (root)")
    .option(
      "--out <dir>",
      `output root directory (default: ${DEFAULT_OUT_DIR})`,
      DEFAULT_OUT_DIR
    )
    .option(
      "--depth <n>",
      "recurse into sub-packages up to N levels (0 = root only, omit = unlimited)"
    )
    .option("--target-model <id>", "record target LLM in manifest for downstream budgeting")
    .option("--max-tokens <n>", "soft cap; degrade if exceeded (Phase 3)")
    .option("--include-source [glob]", "include raw ABAP source for objects matching glob (Phase 3)")
    .option("--strip [level]", "strip boilerplate from sources: light|medium|aggressive (Phase 3)")
    .option("--with-docs", "fetch object & package long texts (Phase 4)")
    .option("--with-where-used", "fetch inbound references via /usageReferences (Phase 4)")
    .option(
      "--types <list>",
      "comma-separated typeId families (CLAS,INTF,PROG,FUGR,DDIC,CDS); Phase 1 ignores"
    )
    .option("--max <n>", "max objects per package to process", "500")
    .option(
      "--namespace-prefixes <csv>",
      "comma-separated name prefixes to keep (overrides pull-config); e.g. Z,Y,/RB"
    )
    .option("--clean", "delete <out>/<PACKAGE>/ before writing (mutually exclusive with --no-overwrite)")
    .option("--no-overwrite", "abort if <out>/<PACKAGE>/ already exists")
    .option("--keep-going", "continue on per-object failures (default: stop on first error)")
    .option("--dry-run", "walk + classify but do not fetch or write; print intended actions")
    .option("--config <path>", "abaplint config file (overrides profile setting)")
    .action(async function (opts) {
      const ctx = this.ctx;

      if (opts.clean && opts.overwrite === false) {
        throw new Error("--clean and --no-overwrite are mutually exclusive.");
      }

      const writeMode = opts.clean
        ? "clean"
        : opts.overwrite === false
        ? "refuse"
        : "overwrite";

      const depth =
        opts.depth === undefined || opts.depth === null
          ? Infinity
          : Math.max(0, parseInt(opts.depth, 10) || 0);
      const outRoot = path.resolve(opts.out || DEFAULT_OUT_DIR);
      const maxPerPackage = Math.max(1, parseInt(opts.max, 10) || 500);

      log.step(
        `adt context build: package=${opts.package} depth=${depth === Infinity ? "unlimited" : depth} out=${outRoot} writeMode=${writeMode}` +
          (opts.dryRun ? " [dry-run]" : "")
      );

      const client = ctx.getClient();

      // Walk the package tree -------------------------------------------
      const tree = await walkPackage(client, opts.package, { depth });
      log.info(`Discovered ${tree.size} package(s) in tree (depth limit = ${depth}).`);

      // Load abaplint config once (shared across all package bundles) ---
      const abaplintConfig = adapter.loadConfig({
        configPath: opts.config,
        profile: _safeProfile(ctx),
      });

      const stripLevel = _resolveStripLevel(opts.strip);
      _warnUnimplemented(opts);

      const cliNamespacePrefixes =
        opts.namespacePrefixes !== undefined
          ? _parseCsvOrEmpty(opts.namespacePrefixes)
          : null;
      const { namespacePrefixes, namespaceSource } = pullConfig.loadEffectiveTypes({
        projectDir: process.cwd(),
        cliNamespacePrefixes,
      });
      log.info(
        `Namespace prefixes: [${namespacePrefixes.join(", ")}] (source: ${namespaceSource})`
      );

      // Build one bundle per package ------------------------------------
      const results = [];
      for (const [pkgName, entry] of tree.entries()) {
        // Per-package object cap (cheap guard against accidental huge runs).
        if (entry.nodes.length > maxPerPackage) {
          log.warn(
            `Package ${pkgName} has ${entry.nodes.length} objects but --max=${maxPerPackage}; truncating.`
          );
          entry.nodes = entry.nodes.slice(0, maxPerPackage);
        }
        const result = await buildBundleForPackage(client, entry, {
          outRoot,
          abaplintConfig,
          writeMode,
          targetModel: opts.targetModel || null,
          maxTokens: opts.maxTokens ? Number(opts.maxTokens) : null,
          includeSource: opts.includeSource === undefined ? false : opts.includeSource,
          stripLevel,
          withDocs: !!opts.withDocs,
          withWhereUsed: !!opts.withWhereUsed,
          keepGoing: !!opts.keepGoing,
          dryRun: !!opts.dryRun,
          namespacePrefixes,
        });
        results.push({ package: pkgName, ...result });
      }

      const summary = {
        rootPackage: String(opts.package).toUpperCase(),
        depth: depth === Infinity ? "unlimited" : depth,
        outRoot,
        writeMode,
        dryRun: !!opts.dryRun,
        targetModel: opts.targetModel || null,
        packageCount: results.length,
        packages: results.map((r) => ({
          package: r.package,
          packageDir: r.packageDir,
          supported: r.supported,
          unsupported: r.unsupported,
          skipped: !!r.skipped,
          skipReason: r.skipReason || null,
          errorCount: (r.errors || []).length,
          written: r.written || [],
        })),
      };

      renderJson(summary);

      // Exit code: 1 if any package had any errors, 0 otherwise. A "skipped
      // because folder exists" is not an error — it's a deliberate guard.
      const hadErrors = results.some((r) => (r.errors || []).length > 0);
      if (hadErrors) process.exitCode = 1;
    });

  context
    .command("inspect")
    .description(
      "Inspect an existing bundle directory: recompute per-file token estimates " +
        "against a target model and report whether the bundle fits."
    )
    .argument("<bundleDir>", "path to a single <PACKAGE> bundle folder (not the outRoot)")
    .option("--target-model <id>", "target LLM (default: claude-opus-4-7)", "claude-opus-4-7")
    .option("--max-tokens <n>", "override soft cap")
    .action(async function (bundleDir, opts) {
      const abs = path.resolve(bundleDir);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        throw new Error(`Bundle directory not found: ${abs}`);
      }
      const softCap = tokenBudget.softCapFor(opts.targetModel, opts.maxTokens);
      const perFile = {};
      let total = 0;
      // Top-level JSON / MD files
      for (const name of fs.readdirSync(abs)) {
        const full = path.join(abs, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          // Recurse one level for sources/ and docs/.
          const subTotal = _measureDirectory(full);
          perFile[`${name}/`] = subTotal;
          total += subTotal;
        } else if (stat.isFile()) {
          const text = fs.readFileSync(full, "utf8");
          const t = tokenBudget.estimate(text);
          perFile[name] = t;
          total += t;
        }
      }
      renderJson({
        bundleDir: abs,
        targetModel: opts.targetModel,
        softCap,
        totalTokens: total,
        fitsBudget: total <= softCap,
        tokenizer: tokenBudget.tokenizerName(),
        perFile,
      });
      if (total > softCap) process.exitCode = 2;
    });

  context
    .command("budget")
    .description("Print the model context-window table used for adaptive degradation.")
    .option("--target-model <id>", "highlight one model")
    .action(function (opts) {
      const rows = Object.entries(tokenBudget.MODELS).map(([id, info]) => ({
        model: id,
        window: info.window,
        encoder: info.encoder,
        softCap: Math.floor(info.window * tokenBudget.SOFT_CAP_RATIO),
        highlighted: opts.targetModel ? id === opts.targetModel : false,
      }));
      renderJson({
        tokenizer: tokenBudget.tokenizerName(),
        softCapRatio: tokenBudget.SOFT_CAP_RATIO,
        models: rows,
      });
    });
}

function _measureDirectory(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) total += _measureDirectory(full);
    else if (stat.isFile()) total += tokenBudget.estimate(fs.readFileSync(full, "utf8"));
  }
  return total;
}

function _warnUnimplemented(opts) {
  const unimplemented = [];
  if (opts.types) unimplemented.push("--types");
  if (unimplemented.length > 0) {
    log.warn(`Flags accepted but not yet wired: ${unimplemented.join(", ")}.`);
  }
}

function _resolveStripLevel(stripOpt) {
  if (stripOpt === undefined) return null;
  // commander treats `[level]` as: `--strip` -> true (no value), `--strip=light` -> "light"
  if (stripOpt === true) return "medium";
  const valid = new Set(["light", "medium", "aggressive"]);
  const v = String(stripOpt).toLowerCase();
  if (!valid.has(v)) {
    throw new Error(`Invalid --strip level "${stripOpt}". Use: light | medium | aggressive.`);
  }
  return v;
}

function _parseCsvOrEmpty(value) {
  if (value === undefined || value === null) return null;
  const parts = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts;
}

function _safeProfile(ctx) {
  try {
    return ctx.getProfile();
  } catch (_) {
    return null;
  }
}

module.exports = { register };
