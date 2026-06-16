"use strict";

// `adt lint <verb>` - offline static analysis via @abaplint/core.
//
// Subcommands:
//   adt lint object  <objectUrl>  [--include I] [--config P]
//   adt lint file    <path>       [--config P]
//   adt lint package <pkgName>    [--config P] [--max N] [--skip-unsupported]
//
// All commands print a JSON summary to stdout. Exit codes:
//   0  no issues
//   1  at least one Error-severity issue
//   2  only Warning / Info issues
//
// The lint engine runs entirely locally; for `object` and `package` we pull
// source from the ABAP system using the existing ADT client, then hand the
// in-memory files to abaplint.

const fs = require("fs");
const path = require("path");

const log = require("../logger");
const objLib = require("../objLib");
const adapter = require("../abaplintAdapter");
const { renderJson } = require("../output");
//IYH1HC add
const { fetchObjectAsMemoryFiles, inferUrlFromTypeAndName } = objLib;

// ---------------------------------------------------------------------------
// Object-URL helpers
// ---------------------------------------------------------------------------

// Extract a best-guess (typeId, name) from an ADT object URL.
// Patterns covered:
//   /sap/bc/adt/oo/classes/<name>           -> CLAS/OC
//   /sap/bc/adt/oo/interfaces/<name>        -> INTF/OI
//   /sap/bc/adt/programs/programs/<name>    -> PROG/P
//   /sap/bc/adt/programs/includes/<name>    -> PROG/I
//
// Anything else returns null and the caller should error out (or skip).
function inferTypeAndName(objectUrl) {
  const url = objLib.normalizeObjectUrl(objectUrl).split("?")[0];
  const m = url.match(/\/sap\/bc\/adt\/(oo\/classes|oo\/interfaces|programs\/programs|programs\/includes)\/([^/]+)/);
  if (!m) return null;
  const map = {
    "oo/classes": "CLAS/OC",
    "oo/interfaces": "INTF/OI",
    "programs/programs": "PROG/P",
    "programs/includes": "PROG/I",
  };
  return {
    typeId: map[m[1]],
    name: decodeURIComponent(m[2]).toUpperCase(),
  };
}

//IYH1HC comment — moved to objLib.fetchObjectAsMemoryFiles
// async function fetchObjectAsMemoryFiles(client, objectUrl, typeId, name, includeOverride) { ... }

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

function register(lint) {
  // ---------- adt lint object ----------------------------------------------
  lint
    .command("object")
    .description("Pull an object's source via ADT, then lint it with abaplint.")
    .argument("<objectUrl>", "ADT path or URL, e.g. oo/classes/zcl_foo")
    .option("--include <name>", "lint only this specific include (skip the others)")
    .option("--config <path>", "abaplint config file (overrides profile setting)")
    .action(async function (objectUrl, opts) {
      const ctx = this.ctx;
      const inferred = inferTypeAndName(objectUrl);
      if (!inferred) {
        throw new Error(
          `Cannot infer object type from URL "${objectUrl}". ` +
            "Supported: oo/classes/*, oo/interfaces/*, programs/programs/*, programs/includes/*"
        );
      }
      if (!adapter.isSupportedType(inferred.typeId)) {
        throw new Error(
          `Object type "${inferred.typeId}" is not yet supported by adt lint.`
        );
      }

      log.step(`Linting ${inferred.typeId} ${inferred.name}`);
      const client = ctx.getClient();
      const memFiles = await fetchObjectAsMemoryFiles(
        client,
        objectUrl,
        inferred.typeId,
        inferred.name,
        opts.include
      );
      if (memFiles.length === 0) {
        throw new Error("No source could be fetched for this object.");
      }

      const config = adapter.loadConfig({
        configPath: opts.config,
        profile: ctx.getProfile(),
      });
      const issues = adapter.lintFiles(memFiles, config);
      const summary = adapter.summarize(issues);

      const output = {
        objectUrl: objLib.normalizeObjectUrl(objectUrl),
        typeId: inferred.typeId,
        name: inferred.name,
        filesLinted: memFiles.map((f) => f.getFilename()),
        ...summary,
      };
      renderJson(output);
      setExitCodeFromSummary(summary);
    });

  // ---------- adt lint file ------------------------------------------------
  lint
    .command("file")
    .description(
      "Lint a local .abap file directly (no SAP connection required). " +
        "Filename is auto-converted to abapGit convention if needed " +
        "(e.g. ZCL_FOO.abap -> zcl_foo.clas.abap). Use --type to override."
    )
    .argument("<filePath>", "path to a local .abap file")
    .option("--config <path>", "abaplint config file")
    //IYH1HC add
    .option(
      "--type <kind>",
      "force object type: class|interface|program|include (auto-detected from filename prefix if omitted)"
    )
    .action(async function (filePath, opts) {
      const ctx = this.ctx;
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) {
        throw new Error(`File not found: ${abs}`);
      }
      const raw = fs.readFileSync(abs, "utf8");
      const abaplint = require("@abaplint/core");

      //IYH1HC add
      const abapgitName = resolveAbapgitFilename(path.basename(abs), opts.type);
      if (abapgitName !== path.basename(abs)) {
        log.info(`Filename mapped to abapGit convention: ${path.basename(abs)} -> ${abapgitName}`);
      }
      const memFile = new abaplint.MemoryFile(abapgitName, raw);

      const profile = safeGetProfile(ctx);
      const config = adapter.loadConfig({
        configPath: opts.config,
        profile,
      });
      const issues = adapter.lintFiles([memFile], config);
      const summary = adapter.summarize(issues);

      const output = {
        filePath: abs,
        filesLinted: [memFile.getFilename()],
        ...summary,
      };
      renderJson(output);
      setExitCodeFromSummary(summary);
    });

  // ---------- adt lint package ---------------------------------------------
  lint
    .command("package")
    .description(
      "List all objects in a package, fetch their source, and lint them as a single Registry."
    )
    .argument("<package>", "ABAP package name, e.g. $YMU_PKG or ZMY_PKG")
    .option("--config <path>", "abaplint config file")
    .option("--max <n>", "maximum objects to lint", "200")
    .option(
      "--skip-unsupported",
      "skip object types not yet supported (default true)",
      true
    )
    //IYH1HC add
    .option("--fix", "apply all auto-fixable issues (prints changed sources to stdout)")
    .action(async function (pkgName, opts) {
      const ctx = this.ctx;
      const client = ctx.getClient();
      const max = Math.max(1, parseInt(opts.max, 10) || 200);

      log.step(`Listing contents of package ${pkgName}`);
      const nodes = await objLib.listPackageContents(client, pkgName);
      log.info(`Found ${nodes.length} direct children in ${pkgName}`);

      const skipped = [];
      const supported = [];
      for (const n of nodes) {
        if (!adapter.isSupportedType(n.typeId)) {
          skipped.push(n);
          continue;
        }
        supported.push(n);
        if (supported.length >= max) break;
      }
      log.info(
        `Linting ${supported.length} objects (skipped ${skipped.length} unsupported).`
      );

      // Collect MemoryFiles across all objects so abaplint sees the full
      // package as a single Registry. This gives better cross-object
      // resolution than linting each object in isolation.
      const allFiles = [];
      for (const obj of supported) {
        const url = obj.uri || inferUrlFromTypeAndName(obj.typeId, obj.name);
        try {
          const memFiles = await fetchObjectAsMemoryFiles(client, url, obj.typeId, obj.name, null);
          for (const f of memFiles) allFiles.push(f);
        } catch (e) {
          log.warn(`Failed to fetch ${obj.typeId} ${obj.name}: ${e.message}`);
        }
      }

      const config = adapter.loadConfig({ configPath: opts.config, profile: ctx.getProfile() });

      //IYH1HC add — use buildPackageRegistry to keep the registry instance for --fix
      const registry = adapter.buildPackageRegistry(allFiles, config);

      //IYH1HC add
      let fixResult = null;
      if (opts.fix) {
        log.step("Applying auto-fixable issues...");
        fixResult = adapter.applyQuickFixes(registry);
        log.ok(`Applied ${fixResult.applied} fix(es).`);
      }

      const issues = registry.findIssues();
      const normalized = issues.map(adapter.normalizeIssue);

      // Group issues back per object using filename prefix.
      const results = supported.map((obj) => {
        const prefix = String(obj.name).toLowerCase() + ".";
        const objIssues = normalized.filter((i) => i.file.startsWith(prefix));
        return {
          typeId: obj.typeId,
          name: obj.name,
          uri: obj.uri,
          issueCount: objIssues.length,
          issues: objIssues,
        };
      });

      const output = {
        package: pkgName,
        scanned: supported.length,
        skipped: skipped.length,
        skippedTypes: countByType(skipped),
        totalIssues: normalized.length,
        errorCount: normalized.filter((i) => i.severity === "Error").length,
        warningCount: normalized.filter((i) => i.severity === "Warning").length,
        //IYH1HC add
        ...(fixResult && { fixesApplied: fixResult.applied, fixedFiles: fixResult.files }),
        results,
      };
      renderJson(output);
      setExitCodeFromSummary({
        errorCount: output.errorCount,
        issueCount: output.totalIssues,
      });
    });

  //IYH1HC add
  // ---------- adt lint skeleton --------------------------------------------
  lint
    .command("skeleton")
    .description(
      "Extract a lightweight JSON skeleton (classes, methods, interfaces) from one object or a whole package. " +
        "Produces 5-10x less token cost than raw ABAP — suited for LLM context building."
    )
    .option("--object <url>", "ADT object URL to skeleton a single object")
    .option("--package <pkg>", "ABAP package name to skeleton all supported objects")
    .option("--config <path>", "abaplint config file")
    .option("--max <n>", "maximum objects when using --package (default 200)", "200")
    .action(async function (opts) {
      const ctx = this.ctx;
      if (!opts.object && !opts.package) {
        throw new Error("Specify --object <url> or --package <pkg>.");
      }

      const config = adapter.loadConfig({ configPath: opts.config, profile: ctx.getProfile() });
      let allFiles = [];
      let label;

      if (opts.object) {
        const client = ctx.getClient();
        const inferred = inferTypeAndName(opts.object);
        if (!inferred) throw new Error(`Cannot infer type from URL "${opts.object}"`);
        if (!adapter.isSupportedType(inferred.typeId)) {
          throw new Error(`Object type "${inferred.typeId}" is not supported.`);
        }
        log.step(`Fetching source for ${inferred.typeId} ${inferred.name}`);
        allFiles = await fetchObjectAsMemoryFiles(client, opts.object, inferred.typeId, inferred.name, null);
        label = `${inferred.typeId} ${inferred.name}`;
      } else {
        const client = ctx.getClient();
        const max = Math.max(1, parseInt(opts.max, 10) || 200);
        log.step(`Listing contents of package ${opts.package}`);
        const nodes = await objLib.listPackageContents(client, opts.package);
        const supported = nodes.filter((n) => adapter.isSupportedType(n.typeId)).slice(0, max);
        log.info(`Fetching source for ${supported.length} objects...`);
        for (const obj of supported) {
          const url = obj.uri || inferUrlFromTypeAndName(obj.typeId, obj.name);
          try {
            const memFiles = await fetchObjectAsMemoryFiles(client, url, obj.typeId, obj.name, null);
            allFiles.push(...memFiles);
            log.info(`  [ok] ${obj.typeId} ${obj.name}`);
          } catch (e) {
            log.warn(`  [skip] ${obj.name}: ${e.message}`);
          }
        }
        label = opts.package;
      }

      if (!allFiles.length) throw new Error("No source fetched — nothing to skeleton.");

      log.step("Parsing and extracting skeleton...");
      const registry = adapter.buildPackageRegistry(allFiles, config);
      const skeleton = adapter.extractSkeleton(registry);

      renderJson({
        label,
        classCount: skeleton.classes.length,
        interfaceCount: skeleton.interfaces.length,
        programCount: skeleton.programs.length,
        ...skeleton,
      });
    });

  //IYH1HC add
  // ---------- adt lint metrics ---------------------------------------------
  lint
    .command("metrics")
    .description(
      "Compute cyclomatic complexity and method length for all classes in a package."
    )
    .option("--object <url>", "ADT object URL to measure a single class")
    .option("--package <pkg>", "ABAP package name")
    .option("--top <n>", "show only top N classes by max complexity (0 = all)", "0")
    .option("--config <path>", "abaplint config file")
    .option("--max <n>", "maximum objects when using --package (default 200)", "200")
    .action(async function (opts) {
      const ctx = this.ctx;
      if (!opts.object && !opts.package) {
        throw new Error("Specify --object <url> or --package <pkg>.");
      }

      const config = adapter.loadConfig({ configPath: opts.config, profile: ctx.getProfile() });
      const client = ctx.getClient();
      let allFiles = [];
      let label;

      if (opts.object) {
        const inferred = inferTypeAndName(opts.object);
        if (!inferred) throw new Error(`Cannot infer type from URL "${opts.object}"`);
        log.step(`Fetching source for ${inferred.typeId} ${inferred.name}`);
        allFiles = await fetchObjectAsMemoryFiles(client, opts.object, inferred.typeId, inferred.name, null);
        label = `${inferred.typeId} ${inferred.name}`;
      } else {
        const max = Math.max(1, parseInt(opts.max, 10) || 200);
        log.step(`Listing contents of package ${opts.package}`);
        const nodes = await objLib.listPackageContents(client, opts.package);
        const supported = nodes.filter((n) => adapter.isSupportedType(n.typeId)).slice(0, max);
        log.info(`Fetching source for ${supported.length} objects...`);
        for (const obj of supported) {
          const url = obj.uri || inferUrlFromTypeAndName(obj.typeId, obj.name);
          try {
            const memFiles = await fetchObjectAsMemoryFiles(client, url, obj.typeId, obj.name, null);
            allFiles.push(...memFiles);
          } catch (e) {
            log.warn(`  [skip] ${obj.name}: ${e.message}`);
          }
        }
        label = opts.package;
      }

      if (!allFiles.length) throw new Error("No source fetched — nothing to measure.");

      log.step("Parsing and computing metrics...");
      const registry = adapter.buildPackageRegistry(allFiles, config);
      let metrics = adapter.extractMetrics(registry);

      const top = parseInt(opts.top, 10) || 0;
      if (top > 0) metrics = metrics.slice(0, top);

      renderJson({
        label,
        classCount: metrics.length,
        godClassCount: metrics.filter((m) => m.isGodClass).length,
        metrics,
      });
    });

  //IYH1HC add
  // ---------- adt lint refs ------------------------------------------------
  lint
    .command("refs")
    .description(
      "Find all references to the symbol at a given line/character position using LSP LanguageServer.references(). " +
        "Use --package to load cross-object context for full resolution."
    )
    .requiredOption("--object <url>", "ADT object URL whose source contains the symbol")
    .requiredOption("--line <n>", "1-based line number of the symbol")
    .requiredOption("--char <n>", "1-based character position on the line")
    .option("--package <pkg>", "load full package for cross-object reference resolution")
    .option("--config <path>", "abaplint config file")
    .option("--max <n>", "maximum package objects to load (default 200)", "200")
    .action(async function (opts) {
      const ctx = this.ctx;
      const client = ctx.getClient();

      const inferred = inferTypeAndName(opts.object);
      if (!inferred) throw new Error(`Cannot infer type from URL "${opts.object}"`);
      if (!adapter.isSupportedType(inferred.typeId)) {
        throw new Error(`Object type "${inferred.typeId}" is not supported.`);
      }

      const config = adapter.loadConfig({ configPath: opts.config, profile: ctx.getProfile() });
      const allFiles = [];

      // Always load the target object first.
      log.step(`Fetching ${inferred.typeId} ${inferred.name}`);
      const targetFiles = await fetchObjectAsMemoryFiles(client, opts.object, inferred.typeId, inferred.name, null);
      allFiles.push(...targetFiles);

      // Optionally load the full package for cross-object resolution.
      if (opts.package) {
        const max = Math.max(1, parseInt(opts.max, 10) || 200);
        log.step(`Loading package ${opts.package} for cross-object resolution...`);
        const nodes = await objLib.listPackageContents(client, opts.package);
        const others = nodes
          .filter((n) => adapter.isSupportedType(n.typeId) && n.name.toUpperCase() !== inferred.name)
          .slice(0, max);
        for (const obj of others) {
          const url = obj.uri || inferUrlFromTypeAndName(obj.typeId, obj.name);
          try {
            const memFiles = await fetchObjectAsMemoryFiles(client, url, obj.typeId, obj.name, null);
            allFiles.push(...memFiles);
          } catch (e) {
            log.info(`  [skip] ${obj.name}: ${e.message}`);
          }
        }
        log.info(`Loaded ${allFiles.length} files total.`);
      }

      log.step("Parsing registry and resolving references...");
      const registry = adapter.buildPackageRegistry(allFiles, config);

      const { LanguageServer } = require("@abaplint/core");
      const ls = new LanguageServer(registry);

      // The LSP URI must match the filename used in MemoryFile construction.
      const mainFilename = adapter.objectToFilename(inferred.typeId, inferred.name, "main");
      if (!mainFilename) throw new Error(`Cannot determine main filename for ${inferred.typeId}`);

      const line = Math.max(0, parseInt(opts.line, 10) - 1);
      const character = Math.max(0, parseInt(opts.char, 10) - 1);

      const refs = ls.references({
        textDocument: { uri: mainFilename },
        position: { line, character },
        context: { includeDeclaration: false },
      });

      renderJson({
        object: inferred.name,
        file: mainFilename,
        line: parseInt(opts.line, 10),
        char: parseInt(opts.char, 10),
        referenceCount: refs ? refs.length : 0,
        references: refs || [],
      });
    });

  //IYH1HC add
  // ---------- adt lint format ----------------------------------------------
  lint
    .command("format")
    .description(
      "Run abaplint PrettyPrinter on one object or a whole package. " +
        "Prints formatted sources to stdout as JSON by default. " +
        "Does NOT push back to the SAP system — pipe the output or use adt object set-source manually."
    )
    .option("--object <url>", "ADT object URL to format a single object")
    .option("--package <pkg>", "ABAP package name to format all objects")
    .option("--config <path>", "abaplint config file")
    .option("--max <n>", "maximum package objects (default 200)", "200")
    .action(async function (opts) {
      const ctx = this.ctx;
      if (!opts.object && !opts.package) {
        throw new Error("Specify --object <url> or --package <pkg>.");
      }

      const config = adapter.loadConfig({ configPath: opts.config, profile: ctx.getProfile() });
      const client = ctx.getClient();
      const allFiles = [];
      let label;

      if (opts.object) {
        const inferred = inferTypeAndName(opts.object);
        if (!inferred) throw new Error(`Cannot infer type from URL "${opts.object}"`);
        if (!adapter.isSupportedType(inferred.typeId)) {
          throw new Error(`Object type "${inferred.typeId}" is not supported.`);
        }
        log.step(`Fetching source for ${inferred.typeId} ${inferred.name}`);
        allFiles.push(...await fetchObjectAsMemoryFiles(client, opts.object, inferred.typeId, inferred.name, null));
        label = `${inferred.typeId} ${inferred.name}`;
      } else {
        const max = Math.max(1, parseInt(opts.max, 10) || 200);
        log.step(`Listing contents of package ${opts.package}`);
        const nodes = await objLib.listPackageContents(client, opts.package);
        const supported = nodes.filter((n) => adapter.isSupportedType(n.typeId)).slice(0, max);
        log.info(`Fetching source for ${supported.length} objects...`);
        for (const obj of supported) {
          const url = obj.uri || inferUrlFromTypeAndName(obj.typeId, obj.name);
          try {
            allFiles.push(...await fetchObjectAsMemoryFiles(client, url, obj.typeId, obj.name, null));
          } catch (e) {
            log.warn(`  [skip] ${obj.name}: ${e.message}`);
          }
        }
        label = opts.package;
      }

      if (!allFiles.length) throw new Error("No source fetched — nothing to format.");

      log.step("Parsing and formatting...");
      const registry = adapter.buildPackageRegistry(allFiles, config);
      const formatted = adapter.applyPrettyPrinter(registry);

      renderJson({ label, fileCount: formatted.length, files: formatted });
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setExitCodeFromSummary(summary) {
  if (summary.errorCount > 0) process.exitCode = 1;
  else if (summary.issueCount > 0) process.exitCode = 2;
}

function safeGetProfile(ctx) {
  // `adt lint file` should work without a configured profile - we only need
  // the profile if it carries an abaplintConfig path. Swallow the "no profile"
  // error so users can lint local files in clean environments.
  try {
    return ctx.getProfile();
  } catch {
    return null;
  }
}

//IYH1HC comment — moved to objLib.inferUrlFromTypeAndName
// function inferUrlFromTypeAndName(typeId, name) { ... }

function countByType(nodes) {
  const counts = {};
  for (const n of nodes) {
    counts[n.typeId] = (counts[n.typeId] || 0) + 1;
  }
  return counts;
}

//IYH1HC add
// Convert any .abap filename to the 3-part abapGit convention that abaplint
// requires (abaplint silently skips files with fewer than 3 dot-separated parts).
//
// Resolution order:
//   1. typeOverride flag  (--type class|interface|program|include)
//   2. Auto-detect from SAP naming prefixes (ZCL_/CL_ -> class, ZIF_/IF_ -> interface)
//   3. Default: program
//
// Examples:
//   ZCL_IYH1HC_MCP_TMP.abap  -> zcl_iyh1hc_mcp_tmp.clas.abap
//   ZIF_MY_INTF.abap          -> zif_my_intf.intf.abap
//   ZREPORT.abap              -> zreport.prog.abap
//   zcl_foo.clas.abap         -> zcl_foo.clas.abap  (already correct, unchanged)
function resolveAbapgitFilename(basename, typeOverride) {
  // Already follows abapGit convention (3+ dot parts) - use as-is.
  if (basename.split(".").length >= 3) return basename;

  const withoutExt = basename.replace(/\.abap$/i, "").toLowerCase();

  let suffix;
  if (typeOverride) {
    const kindMap = {
      class: "clas.abap",
      interface: "intf.abap",
      program: "prog.abap",
      include: "prog.abap",
    };
    suffix = kindMap[typeOverride.toLowerCase()];
    if (!suffix) throw new Error(`Unknown --type "${typeOverride}". Use: class|interface|program|include`);
  } else {
    // Auto-detect from SAP naming convention prefixes.
    const up = withoutExt.toUpperCase();
    if (/^(ZCL_|YCL_|LCL_|TCL_|CL_)/.test(up)) {
      suffix = "clas.abap";
    } else if (/^(ZIF_|YIF_|LIF_|IF_)/.test(up)) {
      suffix = "intf.abap";
    } else {
      suffix = "prog.abap";
    }
  }

  return `${withoutExt}.${suffix}`;
}

module.exports = { register };
