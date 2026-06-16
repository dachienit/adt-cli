"use strict";

//IYH1HC comment - // `adt object pull` - pull an ABAP package from the SAP system to local disk.
//IYH1HC comment - //
//IYH1HC comment - //   adt object pull --package <PKG> [--out <dir>] [--skip-unsupported] [--max <n>]
//IYH1HC comment - //
//IYH1HC comment - // Files are written in abapGit convention (e.g. zcl_foo.clas.abap).
//IYH1HC comment - // A manifest (.abap-package.json) is written alongside the source files so
//IYH1HC comment - // downstream tooling (Octo LLM) knows what was pulled and from where.

//IYH1HC add
// `adt object pull` — mirror an entire ABAP package (recursive) to local disk.
//
//   adt object pull --package <PKG>
//     [--out <dir>]                  output directory (default ./<pkg-lowercase>)
//     [--depth <n>]                  recursion depth into sub-packages
//                                    (omit = unlimited; 0 = root only)
//     [--max <n>]                    max objects to pull (default 500)
//     [--include-only <ids>]         CSV of typeIds — full override of config
//     [--skip-types <ids>]           CSV of typeIds — subtract from effective set
//     [--no-dependencies]            skip the where-used graph
//     [--no-docs]                    skip long-text fetch (reserved for next phase)
//     [--keep-going]                 continue when one object fetch fails
//     [--skip-unsupported]           suppress warnings for unknown typeIds
//     [--print-config]               print the effective pull config as JSON and exit
//
// Which typeIds are pulled is decided by pullConfig.loadEffectiveTypes:
//   built-in default → user ~/.adt-cli/pull-config.json
//                    → project <cwd>/.adt-cli/pull-config.json
//                    → CLI --include-only / --skip-types
//
// Output layout (root of --out directory):
//   <files in abapGit naming>     — see pullRegistry.js for typeId → extension
//   .abap-package.json            — schema v3, single inventory[] with status
//   .dependencies.json            — inbound where-used edges for pulled objects
//
// Schema v3 inventory[] semantics:
//   status="pulled"        → files[] populated, the fetcher succeeded
//   status="not-in-config" → known typeId but not in effective pullTypes
//   status="unknown-type"  → typeId has no fetcher in pullRegistry
//   status="fetch-failed"  → fetcher threw (timeout, 404, transient error)

const fs = require("fs");
const path = require("path");

const log = require("../logger");
//IYH1HC comment - const objLib = require("../objLib");
//IYH1HC comment - const adapter = require("../abaplintAdapter");
//IYH1HC add
const pullRegistry = require("../pullRegistry");
const pullConfig = require("../pullConfig");
const { walkPackage } = require("../context/packageWalker");
const { fetchDependenciesForPull } = require("../context/dependencyGraph");

//IYH1HC comment - const SCHEMA_VERSION = 2;
//IYH1HC add — v3 introduces unified inventory[] array (status enum)
const SCHEMA_VERSION = 3;

function _parseCsv(value) {
  if (!value) return null;
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function _parseDepth(value) {
  if (value == null || value === "") return Infinity;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return Infinity;
  return n;
}

function register(object) {
  object
    .command("pull")
    .description(
      "Mirror an ABAP package (recursive) to a local folder using abapGit naming. " +
        "Writes .abap-package.json (manifest v3 with full inventory + status) and " +
        ".dependencies.json (where-used edges) alongside the source files."
    )
    .requiredOption("--package <pkg>", "ABAP package name, e.g. ZABAP_GENERATOR")
    .option("--out <dir>", "output directory (default: ./<package-lowercase>)")
    .option(
      "--depth <n>",
      "recurse into sub-packages: 0 = root only; omit = unlimited",
      ""
    )
    .option("--max <n>", "maximum objects to pull (default 500)", "500")
    .option(
      "--include-only <ids>",
      "comma-separated typeIds; full override of pull-config (only these are pulled)"
    )
    .option(
      "--skip-types <ids>",
      "comma-separated typeIds to subtract from the effective set"
    )
    .option("--no-dependencies", "do not fetch and write .dependencies.json")
    .option("--no-docs", "do not fetch long-text docs (reserved)")
    .option("--keep-going", "continue when one object fetch fails")
    .option("--skip-unsupported", "suppress warnings for unknown object types")
    //IYH1HC add
    .option(
      "--namespace-prefixes <list>",
      "comma-separated name prefixes (Z,Y,/RB...). Overrides config. Empty = pull nothing."
    )
    //IYH1HC add
    .option(
      "--print-config",
      "print the effective pull config (resolved typeIds + namespaces) as JSON and exit"
    )
    .action(async function (opts) {
      const ctx = this.ctx;
      const pkg = String(opts.package).toUpperCase();
      const outDir = path.resolve(opts.out || pkg.toLowerCase());
      const max = Math.max(1, parseInt(opts.max, 10) || 500);
      const depth = _parseDepth(opts.depth);
      const includeOnly = _parseCsv(opts.includeOnly);
      const skipTypes = _parseCsv(opts.skipTypes) || [];
      const keepGoing = !!opts.keepGoing;
      //IYH1HC add — null when flag not passed; [] when user passed empty CSV
      const cliNamespacePrefixes =
        opts.namespacePrefixes != null ? _parseCsv(opts.namespacePrefixes) || [] : null;

      //IYH1HC add — resolve effective pull policy (types + namespaces)
      const {
        types: effectiveTypes,
        namespacePrefixes,
        source: configSource,
        namespaceSource,
      } = pullConfig.loadEffectiveTypes({
        projectDir: process.cwd(),
        cliIncludeOnly: includeOnly,
        cliSkipTypes: skipTypes,
        cliNamespacePrefixes,
      });

      //IYH1HC add — --print-config short-circuit (no SAP traffic)
      if (opts.printConfig) {
        log.info(`Effective pull config: types from ${configSource}; namespaces from ${namespaceSource}`);
        console.log(
          JSON.stringify(
            {
              version: 1,
              source: configSource,
              namespaceSource,
              pullTypes: effectiveTypes,
              namespacePrefixes,
            },
            null,
            2
          )
        );
        return;
      }

      log.info(
        `Pull config: ${effectiveTypes.length} typeId(s) from ${configSource}; ` +
          `namespaces=[${namespacePrefixes.join(", ") || "<empty — blocks all>"}] from ${namespaceSource}`
      );

      const client = ctx.getClient();
      const effectiveTypeSet = new Set(effectiveTypes);

      // -- Walk package tree --------------------------------------------
      log.step(
        `Walking package tree for ${pkg} (depth ${depth === Infinity ? "unlimited" : depth})`
      );
      const packagesMap = await walkPackage(client, pkg, { depth });
      const allNodes = [];
      const subPackages = [];
      for (const [pkgName, info] of packagesMap.entries()) {
        if (pkgName !== pkg) subPackages.push(pkgName);
        for (const n of info.nodes) allNodes.push({ ...n, package: pkgName });
      }
      log.info(
        `Tree: ${packagesMap.size} package(s), ${allNodes.length} object(s) total`
      );

      fs.mkdirSync(outDir, { recursive: true });

      //IYH1HC add — single-loop inventory builder.
      // Every walked node ends up in inventory[] with a final status:
      //   "pulled"        — fetched OK, files written
      //   "not-in-config" — known typeId but not in effective pullTypes (also: --max reached)
      //   "unknown-type"  — no fetcher in pullRegistry
      //   "fetch-failed"  — fetcher threw
      // This single source of truth lets Phase A2 (LLM analyzer) enumerate
      // the WHOLE package, not just the pulled subset.
      const inventory = [];
      const pulledObjects = []; // subset of inventory with status="pulled" — used for where-used phase
      let pulledCount = 0;
      let fileCount = 0;
      let failCount = 0;

      for (const node of allNodes) {
        const base = {
          typeId: node.typeId,
          name: node.name,
          description: node.description || "",
          uri: node.uri || null,
          package: node.package || pkg,
        };

        // Classify by effective config
        if (!effectiveTypeSet.has(node.typeId)) {
          if (pullRegistry.isKnownType(node.typeId)) {
            inventory.push({
              ...base,
              status: "not-in-config",
              reason: `${node.typeId} not in effective pullTypes`,
            });
          } else {
            inventory.push({
              ...base,
              status: "unknown-type",
              reason: "no fetcher in pull registry",
            });
            if (!opts.skipUnsupported) {
              log.warn(
                `Unknown type ${node.typeId} ${node.name} — recorded in inventory only`
              );
            }
          }
          continue;
        }

        //IYH1HC add — namespace gate (safe-by-default: empty list = block all)
        if (!pullConfig.matchesNamespace(node.name, namespacePrefixes)) {
          inventory.push({
            ...base,
            status: "not-in-namespace",
            reason:
              namespacePrefixes.length === 0
                ? "namespacePrefixes is empty — blocks all (set namespaces in pull-config.json to enable pulling)"
                : `name "${node.name}" outside configured namespaces [${namespacePrefixes.join(", ")}]`,
          });
          continue;
        }

        // --max enforcement — surplus known-includable nodes recorded as
        // "not-in-config" with a clear reason so the LLM still sees them.
        if (pulledCount >= max) {
          inventory.push({
            ...base,
            status: "not-in-config",
            reason: `--max limit (${max}) reached before this object`,
          });
          continue;
        }

        // Dispatch + fetch
        const strategy = pullRegistry.getStrategy(node.typeId);
        if (!strategy) {
          // Should not happen — typeId in effective set but no dispatch entry
          inventory.push({
            ...base,
            status: "unknown-type",
            reason: "registry inconsistency: no dispatch for in-config typeId",
          });
          log.warn(
            `Registry inconsistency: ${node.typeId} in pullTypes but no fetcher`
          );
          continue;
        }

        try {
          //IYH1HC add — pass namespacePrefixes so FUGR fetcher can drop standard children
          const result = await strategy.fetch(client, node, { namespacePrefixes });
          const files = result && Array.isArray(result.files) ? result.files : [];
          if (files.length === 0) {
            inventory.push({
              ...base,
              status: "fetch-failed",
              reason: "fetcher returned no files",
            });
            log.warn(`  [empty] ${node.typeId} ${node.name}`);
            failCount++;
            continue;
          }
          const writtenFiles = [];
          for (const f of files) {
            fs.writeFileSync(path.join(outDir, f.filename), f.content, "utf8");
            writtenFiles.push(f.filename);
            fileCount++;
          }
          const entry = { ...base, status: "pulled", files: writtenFiles };
          inventory.push(entry);
          pulledObjects.push(entry);
          pulledCount++;
          log.info(
            `  [pulled] ${node.typeId} ${node.name} (${writtenFiles.length} file(s))`
          );
        } catch (e) {
          failCount++;
          inventory.push({
            ...base,
            status: "fetch-failed",
            reason: e.message,
          });
          log.warn(`  [fail] ${node.typeId} ${node.name}: ${e.message}`);
          if (!keepGoing) {
            throw new Error(
              `pull aborted at ${node.typeId} ${node.name}: ${e.message} (use --keep-going to continue)`
            );
          }
        }
      }

      // -- Fetch where-used graph for pulled objects only ----------------
      let dependenciesFile = null;
      if (opts.dependencies !== false && pulledObjects.length > 0) {
        log.step(
          `Fetching where-used graph for ${pulledObjects.length} pulled object(s)`
        );
        try {
          const depGraph = await fetchDependenciesForPull(client, pulledObjects, {
            keepGoing: true,
          });
          const payload = {
            schemaVersion: 1,
            package: pkg,
            generatedAt: new Date().toISOString(),
            edgeCount: depGraph.edges.length,
            edges: depGraph.edges,
          };
          fs.writeFileSync(
            path.join(outDir, ".dependencies.json"),
            JSON.stringify(payload, null, 2),
            "utf8"
          );
          dependenciesFile = ".dependencies.json";
          log.ok(`  ${depGraph.edges.length} inbound edge(s) → .dependencies.json`);
        } catch (e) {
          log.warn(
            `  where-used fetch failed: ${e.message} (continuing without dependencies)`
          );
        }
      }

      // -- Write extended manifest (schema v3) ---------------------------
      const profile = ctx.getProfile();
      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        package: pkg,
        system: profile.name,
        url: profile.url || null,
        pulledAt: new Date().toISOString(),
        depth: depth === Infinity ? null : depth,
        effectivePullTypes: effectiveTypes,
        //IYH1HC add
        effectiveNamespacePrefixes: namespacePrefixes,
        configSource,
        //IYH1HC add
        namespaceSource,
        objectCount: pulledCount,
        fileCount,
        inventory,
        subPackages,
        dependencies: dependenciesFile,
      };
      fs.writeFileSync(
        path.join(outDir, ".abap-package.json"),
        JSON.stringify(manifest, null, 2),
        "utf8"
      );

      const notInConfig = inventory.filter(
        (i) => i.status === "not-in-config"
      ).length;
      //IYH1HC add
      const notInNamespace = inventory.filter(
        (i) => i.status === "not-in-namespace"
      ).length;
      const unknownType = inventory.filter(
        (i) => i.status === "unknown-type"
      ).length;
      log.ok(
        `Pulled ${pulledCount} object(s) (${fileCount} file(s)) → ${outDir}` +
          `  [inventory: ${inventory.length} | not-in-config: ${notInConfig}` +
          (notInNamespace ? ` | not-in-namespace: ${notInNamespace}` : "") +
          (unknownType ? ` | unknown: ${unknownType}` : "") +
          (failCount ? ` | failed: ${failCount}` : "") +
          `]`
      );
    });
}

module.exports = { register };
