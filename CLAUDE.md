# adt-cli

## Role in Octo

`adt-cli` is an **agent-friendly CLI** that bridges the `@octo/service` layer to SAP ABAP systems (on-prem or BTP) via the ADT HTTP API (`/sap/bc/adt/*`). It is not a general-purpose SDK — it is the concrete SAP adapter for the Octo platform.

## Stack

- Node.js ≥ 18.17 (uses global `fetch`)
- `commander` — CLI framework
- `fast-xml-parser` — XML ↔ JSON
- `undici` — HTTP client with proxy support
- `@abaplint/core` — offline ABAP static analysis
- Entry: `bin/adt.js` → `src/cli.js`
- Binaries: `adt`, `adt-cli`

## File Structure

```
bin/
  adt.js                  # Entry: injects proxy, BTP SSO token, hands off to src/cli.js
  adt-wrapper-pp.js       # Standalone BTP PrincipalPropagation helper (browser SSO)
src/
  cli.js                  # Top-level commander setup, preAction hook, ctx builder
  client.js               # AdtClient: thin fetch wrapper (auth, CSRF, cookies, logging)
  auth.js                 # Basic / OAuth refresh / destination resolution
  config.js               # Profile CRUD at ~/.adt-cli/config.json
  destinations.js         # BTP destination resolver (env / VCAP_SERVICES / binding)
  logger.js               # ANSI stderr logger (quiet/normal/verbose/debug)
  output.js               # renderResponse(), renderJson(), ensureOk()
  xml.js                  # parse(), looksLikeXml(), stripBom()
  objLib.js               # lock, putSource, deleteObject, activate, structure, getSource
  httpFile.js             # VS Code .http file parser & runner
  createables.js          # Registry of 21 ABAP object types (PROG, CLAS, DDLS, etc.)
  abaplintAdapter.js      # Bridge to @abaplint/core
  commands/
    login.js              # adt auth login basic|oauth|destination|test
    profile.js            # adt auth profile list|show|use|delete|path
    discovery.js          # adt system discovery|core-discovery|graph|feeds|...
    create.js             # adt object create <kind>|create-generic|validate
    objects.js            # adt object structure|source|set-source|lock|activate|delete|...
    data.js               # adt data sql|ddic|ddic-meta
    bindings.js           # adt service binding|odata-v2
    transports.js         # adt cts config-metadata|configurations|list|...
    traces.js             # adt trace list|requests|hitlist|db|statements|...
    atc.js                # adt atc activate|run|worklist|check|customizing|users
    debugger.js           # adt debug discovery|status|listen|breakpoint set|delete
    request.js            # adt http request|req (generic escape hatch)
    runHttp.js            # adt http list|run (.http file runner)
    lint.js               # adt lint object|file|package
```

## Command Tree

```
adt
├── auth
│   ├── login       basic | oauth | destination | test
│   ├── profile     list | show | use | delete | path
│   └── destinations list | show | test
├── system          discovery | core-discovery | graph | feeds | object-types | type-structure | users | dumps
├── object
│   ├── create      program|class|interface|include|fgroup|fmodule|finclude|ddl|dcl|ddlx|ddla|package|table|service-def|service-binding|dtel|msag|auth-field|auth-object
│   ├── create-generic | create-types | validate
│   └── structure | properties | source | versions | set-source | lock | unlock | activate | inactive | delete
├── data            sql | ddic | ddic-meta
├── service         binding | odata-v2
├── cts             config-metadata | configurations | configuration | save-configuration | list
├── trace           list | requests | hitlist | db | statements | parameters | create | delete
├── atc             activate | run | worklist | check | customizing | users
├── debug           discovery | status | listen | settings | breakpoint set|delete
├── http            request|req | list | run
└── lint            object | file | package | skeleton | metrics | refs | format
```

## Auth Mechanism

**Precedence (highest → lowest):**

1. `ADT_BEARER` env → raw `Authorization: Bearer <token>`
2. `ADT_BASIC` env → raw `Authorization: Basic <base64>`
3. Active profile (from `~/.adt-cli/config.json`):
   - **basic**: `user` + `password` → Basic auth
   - **oauth**: `refreshToken` → auto-refreshes Bearer (within 30s of expiry)
   - **destination**: resolves URL + auth from BTP destination service

**CSRF:** Fetched on first mutating request, cached, re-fetched on HTTP 403.

**Sessions:** Stateless by default. Stateful (cookie-based) only for `lock`, `putSource`, `deleteObject`.

## Key Design Rules

- **stderr = logs, stdout = data** — safe to pipe stdout; all status goes to stderr
- Stateless by default, stateful only when SAP requires it (lock/unlock sequence)
- CSRF token is transparent to callers — managed inside `client.js`
- XML responses auto-parsed to JSON; use `--raw` to skip
- Every command exits with a predictable code (0/1/2/130)

## Profile Storage

`~/.adt-cli/config.json` (mode 0600). Three profile types:

| Type | Stored fields |
|------|---------------|
| basic | url, user, password (base64-obfuscated), client, language |
| oauth | loginUrl, clientId, clientSecret, refreshToken, cached accessToken/tokenExpiresAt |
| destination | destinationName, optional serviceBindingJson, iss, userJwt, client, language |

Each profile also gets a stable `ideId` and `terminalId` UUID (used by the debugger).

## Environment Variables

| Variable | Effect |
|----------|--------|
| `ADT_PROFILE` | Default profile name |
| `ADT_BEARER` | Raw bearer token — skips OAuth refresh |
| `ADT_BASIC` | Raw base64 auth — skips profile lookup |
| `ADT_CLI_HOME` | Config directory (default `~/.adt-cli`) |
| `ADT_USER_JWT` | Default `--user-jwt` for PrincipalPropagation |
| `ADT_ISS` | Default `--iss` for multi-tenant destinations |
| `NO_COLOR` | Disable ANSI colors |
| `destinations` | JSON array of local destinations (local dev) |
| `VCAP_SERVICES` | BTP service bindings (auto-consumed) |
| `HTTPS_PROXY` / `HTTP_PROXY` | Corporate proxy (undici ProxyAgent) |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic failure (HTTP non-2xx, parse error, missing profile) |
| 2 | Auth failure / ATC errors found / lint errors found |
| 130 | Ctrl-C during hidden prompt |

For `adt atc check` and `adt lint`: 1 = errors, 2 = warnings only.

## SAP APIs Accessed

All under the active profile's base URL:

| Path prefix | Domain |
|-------------|--------|
| `/sap/bc/adt/discovery` | System discovery, CSRF prime |
| `/sap/bc/adt/` + object paths | Object lifecycle (create, read, lock, activate, delete) |
| `/sap/bc/adt/activation` | Batch activation |
| `/sap/bc/adt/datapreview/` | SQL / DDIC preview |
| `/sap/bc/adt/cts/` | Change & Transport System |
| `/sap/bc/adt/runtime/traces/` | ABAP runtime tracing |
| `/sap/bc/adt/atc/` | ABAP Test Cockpit |
| `/sap/bc/adt/debugger/` | Debugger control |
| `/sap/bc/adt/businessservices/` | Service bindings / OData |

## abaplint Integration

`src/abaplintAdapter.js` bridges `@abaplint/core` for offline ABAP analysis. Supported object types: `CLAS/OC`, `INTF/OI`, `PROG/P`, `PROG/I`.

### Exported functions

| Function | Purpose |
|----------|---------|
| `lintFiles(files, config)` | Run all abaplint rules, return issues |
| `buildPackageRegistry(files, config)` | Build + parse a Registry, return the instance (use when you need more than issues) |
| `extractSkeleton(registry)` | JSON skeleton: classes (methods/superclass/interfaces), interfaces, programs — 5-10× cheaper token-wise than raw ABAP |
| `extractMetrics(registry)` | Per-class cyclomatic complexity + method length via `CyclomaticComplexityStats.run()` / `MethodLengthStats.run()` (static methods) |
| `applyPrettyPrinter(registry)` | Run `PrettyPrinter(file, config)` on all ABAP files, return `[{filename, source}]` |
| `applyQuickFixes(registry)` | Collect `issue.getDefaultFix()`, apply via `Edits.applyEditList()`, re-parse, return changed files |

### `adt lint` commands

| Command | What it does |
|---------|-------------|
| `adt lint object <url>` | Lint single object pulled from ADT |
| `adt lint file <path>` | Lint local .abap file (no SAP connection) |
| `adt lint package <pkg> [--fix]` | Lint whole package as single Registry; `--fix` applies auto-fixes |
| `adt lint skeleton --object\|--package` | Extract JSON skeleton for LLM context |
| `adt lint metrics --object\|--package [--top N]` | Complexity/length metrics, flags god classes (>30 methods) |
| `adt lint refs --object --line L --char C [--package]` | LSP `LanguageServer.references()` — find callers |
| `adt lint format --object\|--package` | PrettyPrinter on all files, stdout JSON only (does not push to SAP) |

### abaplint API notes (verified against installed package)

- `CyclomaticComplexityStats.run(obj)` and `MethodLengthStats.run(obj)` are **static**, return `[{name, count, ...}]`
- `LanguageServer(registry)` — `textDocument.uri` must match the exact filename used in `new MemoryFile(filename, src)`
- `Edits` exports `applyEditSingle` and `applyEditList` — NOT `EditHelper`/`ApplyFix`
- Issue has `getDefaultFix()` and `getAlternativeFixes()` — NOT `getFix()`
- `PrettyPrinter(file, fullConfig)` — takes the full `Config` object, not a sub-config

## Pull / Mirror (`adt object pull`)

`adt object pull --package <PKG>` mirrors an entire ABAP package (recursive by default) to a local folder in abapGit naming. It is the **offline-first input** for `adt context build` and downstream LLM tooling — pull once, analyse many times.

### Type registry — Phase A1 (Phase A2 reads these offline)

| typeId | File written | Fetcher module |
|---|---|---|
| CLAS/OC | `<name>.clas.abap` + 4 sub-files | `objLib.fetchObjectAsMemoryFiles` |
| INTF/OI | `<name>.intf.abap` | `objLib.fetchObjectAsMemoryFiles` |
| PROG/P, PROG/I | `<name>.prog.abap` | `objLib.fetchObjectAsMemoryFiles` |
| FUGR/F (and FF/I) | `<name>.fugr.<member>.abap` (main + each FM + each include) | `context/objectFetchers/functionGroupFetcher.js` |
| TABL/DT, TABL/DS | `<name>.tabl.xml` | `ddicFetcher.fetchAsAbapGitFile` |
| STRU/DS | `<name>.stru.xml` | `ddicFetcher.fetchAsAbapGitFile` |
| DTEL/DE | `<name>.dtel.xml` | `ddicFetcher.fetchAsAbapGitFile` |
| DOMA/DD | `<name>.doma.xml` | `ddicFetcher.fetchAsAbapGitFile` |
| TTYP/DA | `<name>.ttyp.xml` | `ddicFetcher.fetchAsAbapGitFile` |
| VIEW/DV | `<name>.view.xml` | `ddicFetcher.fetchAsAbapGitFile` |
| DDLS/DF, DDLS/DL | `<name>.ddls.asddls` | `cdsFetcher.fetchAsAbapGitFile` |
| DCLS/DL | `<name>.dcls.asdcls` | `cdsFetcher.fetchAsAbapGitFile` |
| MSAG/N | `<name>.msag.xml` | `context/objectFetchers/msagFetcher.js` |
| TRAN/T | `<name>.tran.xml` | `context/objectFetchers/tranFetcher.js` (endpoint probe — may skip) |
| TOBJ/TOB | `<name>.tobj.xml` | `context/objectFetchers/tobjFetcher.js` (endpoint probe — may skip) |
| SUSH | `<name>.sush.xml` | `context/objectFetchers/sushFetcher.js` (endpoint probe — may skip) |
| DEVC/K | (recurses, not a file) | `context/packageWalker.js` |

The dispatch table lives in [src/pullRegistry.js](src/pullRegistry.js). Unknown typeIds are logged and recorded in the manifest's `skipped[]` array without aborting the pull.

### Companion files (root of output directory)

- `.abap-package.json` — **schemaVersion 3**; unified `inventory[]` with per-object `status` (see schema below), plus `effectivePullTypes`, `configSource`, sub-pkgs, dependencies pointer
- `.dependencies.json` — inbound where-used edges (`{ from, to, kind: "usedBy", external }`) for pulled objects only; skip with `--no-dependencies`

### Inventory schema (manifest v3)

Every walked node ends up in `inventory[]` with one of four statuses so downstream LLM analyzers (Phase A2) can describe the **whole** package, not just the pulled subset:

| status | When | Has `files[]` | Has `reason` |
|---|---|---|---|
| `pulled` | fetcher succeeded, files written | yes | no |
| `not-in-config` | known typeId but not in effective pullTypes (or `--max` reached) | no | yes |
| `not-in-namespace` | name does not start with any prefix in effective `namespacePrefixes` (also fires when the list is `[]` — safe-by-default) | no | yes |
| `unknown-type` | typeId not in `pullRegistry.KNOWN_TYPE_IDS` | no | yes |
| `fetch-failed` | fetcher threw (timeout, 404, transient error) | no | yes (exception message) |

Every entry carries `typeId`, `name`, `description`, `uri`, `package` regardless of status, so LLMs can enumerate (and explain) the full package even when the source was not pulled.

### Defaults (Phase A1)

- Recursion: unlimited (was: only direct children)
- Max objects: 500 (was: 200)
- Pulls inbound where-used graph by default (was: not pulled at all)
- **Which typeIds are pulled is decided by `pullConfig`**, NOT by `pullRegistry`. See "Pull config" below.

### Pull config (`src/pullConfig.js`)

Decides *which* typeIds to mirror. The registry only answers *how* to fetch a given typeId.

**Precedence (lowest → highest)**:

1. Built-in default — `DEFAULT_PULL_TYPES` in [src/pullConfig.js](src/pullConfig.js): 16 typeIds covering CLAS, INTF, PROG, INCL, FUGR family, DDIC data (TABL/STRU/DTEL/DOMA/TTYP), CDS (DDLS/DCLS). Niche types (`MSAG/N`, `TRAN/T`, `TOBJ/TOB`, `SUSH`, `VIEW/DV`) are **excluded** by default.
2. User config — `~/.adt-cli/pull-config.json` (auto-bootstrapped from built-in default on first pull). Edit this for global preferences.
3. Project config — `<cwd>/.adt-cli/pull-config.json` (per-repo override, full replace not merge).
4. CLI flags — `--include-only X,Y` (full override) and `--skip-types X,Y` (subtract).

**Config file schema** (both user and project):

```json
{
  "version": 1,
  "pullTypes": ["CLAS/OC", "INTF/OI", "TABL/DT", "..."],
  "namespacePrefixes": ["Z", "Y", "/RB"]
}
```

Unknown typeIds (not in `pullRegistry.KNOWN_TYPE_IDS`) are dropped with a warn log; the resolver never throws.

**Namespace prefix filter** (`namespacePrefixes`, alongside `pullTypes` in the same config file):

- A node is pulled only when its `name` starts (case-insensitively) with at least one prefix in this list.
- Bootstrap default: `["Z", "Y", "/RB"]` — Bosch customer code namespaces.
- **Safe-by-default**: an empty array `[]` blocks everything — every walked node lands in `inventory[]` with `status: "not-in-namespace"`. Required because otherwise SE54-generated function-group children (`LSVIMTOP`, `LSVIMF01`, ...) would be pulled and stall the source GETs.
- The filter applies at TWO points:
  1. Top-level package nodes (in `pull.js` classify loop).
  2. Function-group children (in `functionGroupFetcher.js` after Step 1 discovery, before Step 2 source fetch). This is the critical fix that prevents the FUGR hang.
- CLI override: `--namespace-prefixes Z,Y,/RB` (replaces config); pass `--namespace-prefixes ""` to deliberately block everything.
- Add more namespaces by editing the config file — e.g. `["Z", "Y", "/RB", "/MY_NS"]`.

`matchesNamespace` lives in [src/namespaceUtil.js](src/namespaceUtil.js) (standalone to avoid a `pullConfig → pullRegistry → fugrFetcher → pullConfig` circular dependency).

**Inspect the resolved config** without hitting SAP:

```sh
adt object pull --package ZPK_X --print-config
# emits { version, source, pullTypes } to stdout and exits
```

The `source` field surfaces provenance so you can confirm which layer won (e.g. `"project config (...)"` or `"CLI --include-only"`).

Old behaviour (only ABAP code, no DDIC, no recursion, no deps) can be reproduced with:

```sh
adt object pull --package X --depth 0 --no-dependencies \
  --include-only CLAS/OC,INTF/OI,PROG/P,PROG/I,FUGR/F,FUGR/FF,FUGR/I
```

### Code path summary

1. `src/commands/pull.js` parses flags
2. `pullConfig.loadEffectiveTypes(...)` resolves the effective typeIds (built-in → user → project → CLI)
3. `walkPackage` (from `src/context/packageWalker.js`) returns `Map<pkgName, {nodes, subPackages}>` recursively
4. **Single-loop inventory builder**: for each node, classify by `effectivePullTypes` then (if included) call `pullRegistry.getStrategy(typeId)` and execute the fetcher. Every node gets an entry in `inventory[]` with one of 4 status values.
5. `fetchDependenciesForPull` (from `src/context/dependencyGraph.js`) bulk-fetches `usageReferences` for the `status:"pulled"` subset and writes `.dependencies.json`
6. Manifest v3 `.abap-package.json` written last (records `inventory[]`, `effectivePullTypes`, `configSource`, sub-packages, dependencies pointer)

### Known fetcher caveats

- TRAN/T, TOBJ/TOB, SUSH endpoints are NOT publicly documented in ADT. Their fetchers probe likely paths and throw on 404; with `--keep-going` (default true) the entry lands in `inventory[]` with `status: "fetch-failed"`. Verify live before opting them in.
- **MSAG/N, TRAN/T, TOBJ/TOB, SUSH, VIEW/DV are NOT in the default pull config**. Live test showed `/sap/bc/adt/messageclasses/<name>` can stall on T4X. Add them to your pull config or pass `--include-only ...,MSAG/N` if you need them.
- DDIC fetcher writes RAW ADT XML (Accept: */*) — schema is SAP-version-dependent. Downstream parsers (Phase A2 `localReader`) should treat fields defensively.

### Per-call timeout (defensive)

[src/client.js](src/client.js) `request()` wraps every `fetch()` in an `AbortController` with a default 60s timeout. Per-call override via `options.timeoutMs`. On timeout the call throws `Error("timeout after Xms at <path>")` which is caught by `--keep-going` so one stalled endpoint cannot freeze a bulk operation.

## Known Issues / Bugs Fixed

- **`objLib.listPackageContents`**: do NOT pass `headers: {"x-csrf-token": "fetch"}` in the `client.send()` call. `client.js` manages CSRF via `ensureCsrf()` and the condition at line 190 (`!headers.has("x-csrf-token")`) will skip injection if that header is already present — causing the POST to go out with `"fetch"` instead of the real token → SAP 403. Fixed by removing the header from the call.
- **`bin/adt.js` SSO injection**: auto-inject now sets both `ADT_BEARER` and `ADT_USER_JWT` (wrapper sets both; adt.js was only setting `ADT_BEARER`). Also reconstructs `destinations` env var from profile's cached `url` so destination-type profiles work without re-running the wrapper.

## Coding Notes

- Do not add new top-level commands without a matching entry in `src/cli.js` (commander registration).
- New object types go into `createables.js` (the registry drives validation paths and XML templates).
- CSRF + cookie handling lives exclusively in `client.js` — do not replicate in commands.
- Never pass `"x-csrf-token": "fetch"` in options.headers for mutating requests — client handles it.
- Profile secrets are base64-obfuscated, not encrypted — do not store them in logs or stdout.
- `objLib.js` is the low-level primitive layer; commands in `commands/` are the user-facing wrappers.
