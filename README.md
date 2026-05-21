# adt-cli

A verbose, agent-friendly Node.js CLI for the **SAP ABAP Development Tools (ADT)**
HTTP services.

It is designed for two audiences:

1. **Coding agents** — every step is announced on `stderr`, results land on
  `stdout`. Predictable exit codes and a generic `http request` escape hatch
   make automation easy.
2. **Developers** — quick credential bootstrapping (Basic + BTP OAuth refresh),
  profile management, and one-shot recipes such as
   `adt object create program ZHELLO --source-file zhello.abap --activate`.

---

## Table of contents

- [Install](#install)
- [Command tree at a glance](#command-tree-at-a-glance)
- [Quick start](#quick-start)
- [CLI conventions](#cli-conventions)
- [Global options](#global-options)
- [Environment variables](#environment-variables)
- `[adt auth](#adt-auth--credentials-and-profiles)`
- `[adt system](#adt-system--server-discovery--metadata)`
- `[adt object](#adt-object--repository-objects)`
  - [Create](#create)
  - [Read (`structure`, `properties`, `source`, `versions`)](#read)
  - [Edit (`set-source`, `lock`, `unlock`)](#edit)
  - [Lifecycle (`activate`, `inactive`, `delete`)](#lifecycle)
- `[adt data](#adt-data--sql--ddic)`
- `[adt service](#adt-service--business-service-bindings)`
- `[adt cts](#adt-cts--change--transport-system)`
- `[adt trace](#adt-trace--abap-runtime-traces)`
- `[adt atc](#adt-atc--abap-test-cockpit)`
- `[adt debug](#adt-debug--debugger)`
- `[adt http](#adt-http--generic-request--http-files)`
- [Recipes](#recipes)
- [Configuration file](#configuration-file)
- [Exit codes](#exit-codes)
- [Troubleshooting](#troubleshooting)
- [Source map (TypeScript API ↔ CLI)](#source-map-typescript-api--cli)

---

## Install

```bash
cd adt-cli
npm install
npm link        # optional: exposes `adt` globally
```

Or run directly without installing globally:

```bash
node bin/adt.js --help
```

Requires **Node.js 18.17+** (uses global `fetch`).

---

## Command tree at a glance

Every command follows a 2-level **noun-verb** structure (the only depth-3 area
is `adt object create <kind>` and `adt debug breakpoint <set|delete>`):

```
adt
├── auth
│   ├── login        basic | oauth | destination | test
│   ├── profile      list | show | use | delete | path
│   └── destinations list | show | test

├── system
│   ├── discovery
│   ├── core-discovery
│   ├── graph
│   ├── feeds
│   ├── object-types
│   ├── type-structure
│   ├── users
│   └── dumps
├── object
│   ├── create   program | class | interface | include | fgroup | fmodule |
│   │            finclude | ddl | dcl | ddlx | ddla | package | table |
│   │            service-def | service-binding | dtel | msag |
│   │            auth-field | auth-object
│   ├── create-types
│   ├── create-generic
│   ├── validate
│   ├── structure
│   ├── properties
│   ├── source
│   ├── versions
│   ├── set-source
│   ├── lock
│   ├── unlock
│   ├── activate
│   ├── inactive
│   └── delete
├── data
│   ├── sql
│   ├── ddic
│   └── ddic-meta
├── service
│   ├── binding
│   └── odata-v2
├── cts
│   ├── config-metadata
│   ├── configurations
│   ├── configuration
│   ├── save-configuration
│   └── list
├── trace
│   ├── list
│   ├── requests
│   ├── hitlist
│   ├── db
│   ├── statements
│   ├── parameters
│   ├── create
│   └── delete
├── atc
│   ├── activate
│   ├── run
│   ├── worklist
│   ├── check
│   ├── customizing
│   └── users
├── debug
│   ├── discovery
│   ├── status
│   ├── listen
│   ├── settings
│   └── breakpoint
│       ├── set
│       └── delete
└── http
    ├── request   (alias req)
    ├── list
    └── run
```

`adt --help` and `adt <group> --help` always show the relevant subset.

---

## Quick start

```bash
# 1) Save credentials and verify them with /sap/bc/adt/discovery
adt auth login basic --name dev \
                     --url https://abap:44300 \
                     --user DEVELOPER --password '****'

# 2) Anything below uses the saved default profile
adt system discovery
adt object source programs/programs/zroman > zroman.abap
adt data sql 'SELECT CARRIER_ID, CUSTOMER_ID FROM /DMO/BOOKING WHERE BOOKING_ID = 0005' --rows 5
adt data ddic /DMO/TRAVEL --rows 100
adt trace list --user DEVELOPER

# 3) Create + push source + activate in a single step
adt object create program ZHELLO --package $YMU_PKG \
    --description "Hello from adt-cli" \
    --source-file ./zhello.abap --activate
```

For SAP BTP / Steampunk:

```bash
adt auth login oauth --name cloud \
                     --url https://abap.host \
                     --login-url https://uaa.host \
                     --client-id sb-... \
                     --client-secret '****' --refresh-token '****'
```

The OAuth `access_token` is cached and refreshed automatically when within 30s
of expiry.

---

## CLI conventions

- `**stderr` is for humans**: every step prints a timestamped, color-tagged log
line (`STEP`, `OK`, `INFO`, `WARN`, `ERR`, `HTTP`, `DBG`).
- `**stdout` is for data**: parsed (or raw) response body, ready to pipe.
- **Verbosity** (cumulative):
  - default: `INFO / STEP / OK / WARN / ERR`
  - `-v`/`--verbose`: adds `HTTP` (method, URL, status, content-type)
  - `--debug`: adds full request/response headers (Authorization redacted) and
  body previews truncated at ~400 bytes
  - `-q`/`--quiet`: only `ERR`
- **XML auto-parsed** via `fast-xml-parser` (use `--raw` for original bytes,
`--json` to force JSON, `--accept` to ask the server for a different type).
- **CSRF & cookies** are handled transparently. The first non-idempotent
request triggers `GET /sap/bc/adt/discovery` with `x-csrf-token: fetch`; the
token is cached and re-fetched on `403 X-CSRF-Token: required`.
- **Stateful sessions** (`X-sap-adt-sessiontype: stateful`) are switched on
automatically by `adt object set-source`, `adt object delete`, and the
`--source-file` / `--activate` flow on `adt object create`. Other commands
stay stateless.

---

## Global options

These apply to every subcommand.


| Flag                   | Description                                                               |
| ---------------------- | ------------------------------------------------------------------------- |
| `-V, --version`        | Print the CLI version and exit.                                           |
| `-p, --profile <name>` | Profile to use. Falls back to `ADT_PROFILE`, then to the default profile. |
| `-v, --verbose`        | Print HTTP method/URL/status for every request.                           |
| `--debug`              | Adds redacted header dumps and truncated body previews.                   |
| `-q, --quiet`          | Errors only.                                                              |
| `--insecure`           | Skip TLS certificate verification.                                        |
| `--accept <mime>`      | Override the `Accept` header on the request.                              |
| `--raw`                | Print the response body as-is (no XML→JSON parsing).                      |
| `--json`               | Force JSON output (default when the response was XML and parsed cleanly). |
| `--output <file>`      | Write the result body to a file instead of stdout.                        |
| `--user-jwt <token>`   | (destination profiles) JWT to forward as `X-User-Token` to the destination service and, when `forwardAuthToken=true`, as `Authorization` to the target system. Env: `ADT_USER_JWT`. |
| `--iss <url>`          | (destination profiles) Subscriber issuer URL for tenant-scoped destination lookup. Env: `ADT_ISS`. |


---

## Environment variables


| Variable         | Effect                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADT_PROFILE`    | Default profile name (overridden by `--profile`).                                                                                                       |
| `ADT_BEARER`     | Override Authorization with `bearer <token>` (skips OAuth refresh).                                                                                     |
| `ADT_BASIC`      | Override Authorization with `Basic <base64>` (skips profile lookup).                                                                                    |
| `ADT_CLI_HOME`   | Config directory (default `~/.adt-cli`).                                                                                                                |
| `NO_COLOR`       | Disable ANSI colors.                                                                                                                                    |
| `destinations`   | JSON array of local destinations for the destination resolver. See `adt auth login destination`. Local-dev convenience.                                 |
| `VCAP_SERVICES`  | When the CLI runs on Cloud Foundry / Kyma the `destination` (or `destination-lite`) binding here is consumed automatically by destination profiles.     |
| `ADT_USER_JWT`   | Default `--user-jwt` value (forwarded to the destination service and, when `forwardAuthToken=true`, to the target system).                              |
| `ADT_ISS`        | Default `--iss` value for subscriber-tenant destination lookup.                                                                                         |


---

## `adt auth` — credentials and profiles

### `adt auth login basic`

```text
adt auth login basic --url <url> --user <user> [--password <pwd>]
                     [--name <profile>] [--client <sap-client>] [--language <lang>]
                     [--insecure] [--no-verify]
```

Saves a Basic-auth profile and (by default) verifies it against
`/sap/bc/adt/discovery`. If `--password` is omitted you are prompted; input is
masked.

```bash
adt auth login basic --name dev \
                     --url https://abap:44300 \
                     --user DEVELOPER --password '****' \
                     --client 100 --language EN
```

### `adt auth login oauth`

```text
adt auth login oauth --url <abap-url> --login-url <uaa-url> --client-id <sb-...>
                     [--client-secret <secret>] [--refresh-token <token>]
                     [--name <profile>] [--client <sap-client>] [--language <lang>]
                     [--insecure] [--no-verify]
```

Mirrors the BTP refresh-token grant in `restcalls/cloud.http`. The CLI runs an
immediate refresh after saving so any wrong value fails fast. The access token
is cached and rotated transparently by every subsequent command.

### `adt auth login destination`

For agents and CI runs deployed on **SAP BTP** (Cloud Foundry / Kyma), the
target system's URL and credentials usually live in a [BTP destination](https://sap.github.io/cloud-sdk/docs/js/features/connectivity/destinations).
This profile kind defers URL + auth resolution to the destination service so
nothing sensitive is stored in `~/.adt-cli/config.json`.

```text
adt auth login destination --destination <name>
                           [--name <profile>]
                           [--service-binding <jsonOrPath>]
                           [--iss <subscriber-issuer-url>]
                           [--user-jwt <jwt>]
                           [--client <sap-client>] [--language <lang>]
                           [--insecure] [--no-verify]
```

Lookup order at runtime (mirrors `@sap-cloud-sdk/connectivity`):

1. **`process.env.destinations`** — JSON array of simple objects (`name`,
   `url`, `username`, `password`, `authentication`, optional
   `URL.headers.<H>` / `URL.queries.<Q>`). Local-dev convenience.
2. **`profile.serviceBindingJson`** — overrides the runtime VCAP for
   pointing at a different sub-account.
3. **`VCAP_SERVICES.destination`** — the bound destination service, used
   when the CLI runs inside a BTP app.

The resolver then calls the destination service:

- POST `<uaa>/oauth/token` (`grant_type=client_credentials`, basic auth with
  `clientid:clientsecret` from the binding).
- GET `<uri>/destination-configuration/v1/destinations/<name>` with
  `Bearer <token>`.

The response yields:

- target URL → `profile.url` (lazy)
- `Authentication=BasicAuthentication` → `Authorization: Basic ...` from
  `User`/`Password`.
- Any other auth type with `authTokens[]` → uses the `http_header` returned
  by the destination service (e.g. `Authorization: Bearer ...`).
- `URL.headers.<H>` / `URL.queries.<Q>` → applied to every request (lower
  precedence than caller-supplied headers).
- `sap-client` / `Language` → fold into `sap-client` / `sap-language` query
  parameters.

```bash
# On BTP - just reference the destination
adt auth login destination --destination MY_ABAP --name btp

# Local dev with a JSON env array
export destinations='[{"name":"MY_ABAP","url":"https://abap:44300","username":"DEVELOPER","password":"****"}]'
adt auth login destination --destination MY_ABAP --name btp

# Force a sub-account binding (instead of VCAP)
adt auth login destination --destination MY_ABAP --service-binding ./binding.json --name btp

# Subscriber-tenant lookup (multi-tenant scenario)
adt auth login destination --destination MY_ABAP --iss https://sub.authentication.eu10.hana.ondemand.com --name btp
```

`adt auth destinations` is the discovery group for inspection without
saving a profile:

| Command                                    | What it does                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `adt auth destinations list` / `dest list` | Dump local `destinations` env, visible `VCAP_SERVICES.destination` bindings, and (when reachable) all destinations enumerated via the destination service. Use `--no-remote` to skip the remote enumeration. |
| `adt auth destinations show <name>`        | Resolve a destination once and print the sanitised result (no secrets).             |
| `adt auth destinations test <name>`        | Resolve, then call `/sap/bc/adt/discovery` against the resulting URL.               |

#### Token forwarding

If the destination has either `forwardAuthToken` or
`HTML5.ForwardAuthToken` set to `true`, the resolver does **not** use the
destination's own auth. Instead it expects you to supply the user JWT at
runtime via `--user-jwt <token>` (or `ADT_USER_JWT`) and forwards it as
`Authorization: Bearer <jwt>` to the target system. This is the same
behaviour as the SAP Cloud SDK and is intended for destinations of type
`NoAuthentication`.

#### Currently unsupported destination types

`PrincipalPropagation`, `OAuth2SAMLBearerAssertion`, `OAuth2UserTokenExchange`,
`SAMLAssertion` and `ClientCertificateAuthentication`/mTLS are not handled
yet — they require either a connectivity service binding for the on-prem
cloud connector or CF instance identity certificates. If you hit one of
these, the URL is still resolved but no `Authorization` header is set, so
you can supply your own via `ADT_BEARER` / `ADT_BASIC` env or by overriding
the headers on a per-request basis.

### `adt auth login test`

```bash
adt auth login test [--name <profile>]
```

Hits `/sap/bc/adt/discovery` with the saved credentials. Exits 0 on success,
2 on failure.

### `adt auth profile`


| Command                          | Description                                 |
| -------------------------------- | ------------------------------------------- |
| `adt auth profile list` / `ls`   | List profiles and which is the default.     |
| `adt auth profile show [name]`   | Print profile settings (secrets masked).    |
| `adt auth profile use <name>`    | Make `<name>` the default.                  |
| `adt auth profile delete <name>` | Remove a profile.                           |
| `adt auth profile path`          | Print the absolute path of the config file. |


### Auth precedence

1. `ADT_BEARER` env (raw bearer token, no refresh).
2. `ADT_BASIC` env (raw `base64(user:password)`).
3. The selected profile (`basic`, `oauth`, or `destination`). Destination
   profiles defer URL + auth resolution to the BTP destination service at
   runtime.

---

## `adt system` — server discovery & metadata


| Command                                 | Endpoint                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `adt system discovery`                  | `GET /sap/bc/adt/discovery` (Atom service document).                                      |
| `adt system core-discovery`             | `GET /sap/bc/adt/core/discovery` and prime CSRF token.                                    |
| `adt system graph`                      | `GET /sap/bc/adt/compatibility/graph` (server compatibility info).                        |
| `adt system feeds`                      | `GET /sap/bc/adt/feeds`.                                                                  |
| `adt system object-types`               | `GET /sap/bc/adt/repository/informationsystem/objecttypes` (`--name`, `--max`, `--data`). |
| `adt system type-structure`             | `POST /sap/bc/adt/repository/typestructure`.                                              |
| `adt system users`                      | `GET /sap/bc/adt/system/users`.                                                           |
| `adt system dumps [--user <U>] [--top]` | Query short dumps from `/sap/bc/adt/runtime/dumps`.                                       |


```bash
adt system object-types --name 'Z*' --max 50
adt system dumps --user DEVELOPER --top 20
```

---

## `adt object` — repository objects

End-to-end coverage of `src/api/objectcreator.ts`, `objectcontents.ts`,
`activate.ts`, `objectstructure.ts`, `delete.ts`. The canonical workflow is:

1. **validate** the name (`adt object create ... --validate-only` or `adt object validate`)
2. **create** the object (`adt object create <kind>`)
3. **lock** the object (`adt object lock` — usually implicit)
4. **PUT source** (`adt object set-source`)
5. **unlock** (implicit)
6. **activate** (`adt object activate` or `--activate` flag)

`adt object create <kind> ... --source-file <f> --activate` does the full
sequence in a single command. For step-by-step control use the primitives
below.

### Create

`adt object create-types` lists every alias the CLI knows. Here is the full
table:


| Alias             | typeId     | Parent flag        | Notes                                                             |
| ----------------- | ---------- | ------------------ | ----------------------------------------------------------------- |
| `program`         | `PROG/P`   | `--package`        | Max 30 chars.                                                     |
| `class`           | `CLAS/OC`  | `--package`        | Max 30 chars.                                                     |
| `interface`       | `INTF/OI`  | `--package`        | Max 30 chars.                                                     |
| `include`         | `PROG/I`   | `--package`        | Max 30 chars.                                                     |
| `fgroup`          | `FUGR/F`   | `--package`        | Function group, max 26 chars.                                     |
| `fmodule`         | `FUGR/FF`  | `--group <fgroup>` | Function module inside `<fgroup>`.                                |
| `finclude`        | `FUGR/I`   | `--group <fgroup>` | Function group include.                                           |
| `ddl`             | `DDLS/DF`  | `--package`        | CDS data definition.                                              |
| `dcl`             | `DCLS/DL`  | `--package`        | CDS access control.                                               |
| `ddlx`            | `DDLX/EX`  | `--package`        | CDS metadata extension.                                           |
| `ddla`            | `DDLA/ADF` | `--package`        | CDS annotation definition.                                        |
| `package`         | `DEVC/K`   | `--super-package`  | Plus `--swcomp`, `--transport-layer`, `--package-type development |
| `table`           | `TABL/DT`  | `--package`        | Max 16 chars.                                                     |
| `service-def`     | `SRVD/SRV` | `--package`        | Service definition.                                               |
| `service-binding` | `SRVB/SVB` | `--package`        | Plus `--service <srvd>`, `--binding-type ODATA`, `--category 0    |
| `dtel`            | `DTEL/DE`  | `--package`        | Data element.                                                     |
| `msag`            | `MSAG/N`   | `--package`        | Message class, max 20 chars.                                      |
| `auth-field`      | `AUTH`     | `--package`        | Max 10 chars.                                                     |
| `auth-object`     | `SUSO/B`   | `--package`        | Max 10 chars.                                                     |


Common flags on every `adt object create <kind>` subcommand:


| Flag                   | Effect                                                                |
| ---------------------- | --------------------------------------------------------------------- |
| `--description <text>` | Object short text (`adtcore:description`).                            |
| `--responsible <user>` | Sets `adtcore:responsible`. Defaults to the profile user.             |
| `--transport <id>`     | Adds `corrNr=<id>` to the create / source / delete requests.          |
| `--validate-only`      | Run validation and stop.                                              |
| `--no-validate`        | Skip validation entirely.                                             |
| `--source-file <file>` | After create, switch to stateful, lock, PUT source from file, unlock. |
| `--source-stdin`       | Same, but read source from stdin.                                     |
| `--activate`           | After create (and optional source push), activate.                    |


Examples:

```bash
# Program: validate -> create -> source -> activate
adt object create program ZHELLO --package $YMU_PKG \
    --description "Hello from adt-cli" \
    --source-file ./zhello.abap --activate

# Class from stdin
echo 'CLASS zcl_demo DEFINITION PUBLIC FINAL CREATE PUBLIC. ENDCLASS.
CLASS zcl_demo IMPLEMENTATION. ENDCLASS.' \
  | adt object create class ZCL_DEMO --package $YMU_PKG --source-stdin --activate

# Function group + function module inside it
adt object create fgroup ZGRP_DEMO --package $YMU_PKG --description "Demo FG"
adt object create fmodule Z_FM_DEMO --group ZGRP_DEMO --description "demo FM"

# Sub-package
adt object create package YMU_SUB \
    --super-package $YMU_PKG \
    --swcomp HOME --transport-layer SAP --package-type development \
    --description "Sub package"

# CDS objects
adt object create ddl  ZI_DEMO        --package $YMU_PKG --description "CDS"
adt object create dcl  ZDCL_I_DEMO    --package $YMU_PKG --description "DCL"
adt object create ddlx ZE_DEMO_EXTEND --package $YMU_PKG --description "Metadata ext"

# Service definition + binding
adt object create service-def YMU_SRVD --package $YMU_PKG --description "Service def"
adt object create service-binding YMU_SB --package $YMU_PKG \
    --service YMU_SRVD --binding-type ODATA --category 0

# Dry run only
adt object create program ZHELLO --package $YMU_PKG --validate-only
adt object validate class ZCL_FOO --package $YMU_PKG
```

`adt object create-generic` takes a `typeId` directly (advanced):

```bash
adt object create-generic --type PROG/P --name ZHELLO --package $YMU_PKG \
                          --description "Hello" --source-file ./zhello.abap --activate
```

### Read


| Command                                         | What it does                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `adt object structure <objectUrl>`              | GET the object's metadata + (for classes) include list. `--version active         |
| `adt object properties <uri>`                   | Property values for an ADT URI (the object's source URI).                         |
| `adt object source <objectUrl> [--include I]`   | Read source text. `--version`. Honors the global `--output`.                      |
| `adt object versions <objectUrl> [--include I]` | Atom feed of revisions. Useful when the object tracks versions (cloud / abapGit). |


```bash
adt object structure  oo/classes/zcl_demo
adt object properties /sap/bc/adt/programs/programs/zhello/source/main
adt object source     programs/programs/zhello                # to stdout
adt object source     oo/classes/zcl_demo --include definitions
adt object source     programs/programs/zhello --version inactive --output zhello.inactive.abap
adt object versions   programs/programs/zhello
```

### Edit

```text
adt object set-source <objectUrl> [--file <f> | --source-stdin]
                                  [--include <name>]
                                  [--transport <id>]
                                  [--lock-handle <h>]   # use an existing lock
                                  [--keep-locked]       # don't unlock at the end
```

Stateful: locks → PUTs → unlocks (unless `--keep-locked`). Content-Type is
auto-selected: `application/*` if the body starts with `<?xml`, otherwise
`text/plain; charset=utf-8`.

```bash
adt object source     programs/programs/zhello > zhello.abap
$EDITOR zhello.abap
adt object set-source programs/programs/zhello --file zhello.abap --transport YMK900042
adt object activate   programs/programs/zhello
```

Manual lock primitives — *rarely useful directly*: each `adt` invocation is a
fresh process with a fresh cookie jar, so a lock acquired in one process is
gone by the time the next process runs. They exist for inspection and very
specific scripting needs.

```text
adt object lock   <objectUrl> [--mode MODIFY|DISPLAY]
adt object unlock <objectUrl> --handle <LOCK_HANDLE>
```

### Lifecycle

```text
adt object activate <objectUrl> [--name <N>] [--main-include <uri>] [--no-preaudit]
adt object inactive
adt object delete   <objectUrl> [--transport <id>] [--handle <h>]
```

`adt object activate` derives `<name>` from the URL automatically (last path
segment, uppercased) — `--name` overrides it. Returns:

```json
{
  "success": true,
  "messages": [ { "type": "I", "shortText": "...", ... } ],
  "inactive": [ /* objects still inactive */ ]
}
```

Exit code is `1` when `success` is `false`.

```bash
adt object activate programs/programs/zhello
adt object inactive
adt object delete   programs/programs/zhello --transport YMK900042
```

#### Object URL conventions

Every `<objectUrl>` accepts:

- a relative path under `/sap/bc/adt/`, e.g. `programs/programs/zhello`
- an absolute path, e.g. `/sap/bc/adt/programs/programs/zhello`
- a full URL (only the pathname + query is used)

---

## `adt data` — SQL / DDIC


| Command                                             | Endpoint                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `adt data sql <query...> [--rows N]`                | `POST /sap/bc/adt/datapreview/freestyle` (free-style ABAP SQL).      |
| `adt data ddic <entity> [--rows N] [--where <SQL>]` | `POST /sap/bc/adt/datapreview/ddic` (table or CDS view preview).     |
| `adt data ddic-meta <entity>`                       | `GET /sap/bc/adt/datapreview/ddic/<entity>/metadata` (column types). |


```bash
adt data sql 'SELECT CARRIER_ID, FLIGHT_DATE FROM /DMO/BOOKING WHERE BOOKING_ID = 0005' --rows 5
adt data ddic /DMO/TRAVEL --rows 100
adt data ddic /DMO/BOOKING --where "WHERE BOOKING_ID = '0005'"
adt data ddic-meta /DMO/TRAVEL
```

---

## `adt service` — business service bindings


| Command                                                                        | Endpoint                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `adt service binding <name>`                                                   | `GET /sap/bc/adt/businessservices/bindings/<name>`.       |
| `adt service odata-v2 <binding> --service <S> --service-def <D> [--version V]` | `GET /sap/bc/adt/businessservices/odatav2/<binding>?...`. |


```bash
adt service binding ymu_rap_ui_travel_o2
adt service odata-v2 YMU_RAP_UI_TRAVEL_O2 \
    --service YMU_RAP_UI_TRAVEL_O2 --service-def YMU_RAP_UI_TRAVEL
```

---

## `adt cts` — change & transport system


| Command                                                   | Endpoint                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `adt cts config-metadata`                                 | `GET .../cts/transportrequests/searchconfiguration/metadata`. |
| `adt cts configurations`                                  | List saved search configurations.                             |
| `adt cts configuration <id>`                              | Read one configuration (returns its etag for `--etag` below). |
| `adt cts save-configuration <id> --etag <e> --file <xml>` | `PUT` an updated configuration with `If-Match: <etag>`.       |
| `adt cts list --config <id> [--no-targets]`               | `GET /sap/bc/adt/cts/transportrequests?configUri=...`.        |


```bash
adt cts configurations
adt cts configuration 0242AC1100021EEB9CB819072C585EAB
adt cts list --config 0242AC1100021EEB9CB819072C585EAB
adt cts save-configuration 0242AC1100021EEB9CB819072C585EAB \
    --etag 20210220150417 --file ./tr-config.xml
```

---

## `adt trace` — ABAP runtime traces


| Command                                                                                                                                            | Endpoint                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `adt trace list [--user U]`                                                                                                                        | `GET /sap/bc/adt/runtime/traces/abaptraces?user=U`.                         |
| `adt trace requests [--user U]`                                                                                                                    | `GET .../abaptraces/requests`.                                              |
| `adt trace hitlist <traceId> [--system-events]`                                                                                                    | `GET .../abaptraces/<id>/hitlist`.                                          |
| `adt trace db <traceId> [--system-events]`                                                                                                         | `GET .../abaptraces/<id>/dbAccesses` (defaults to `withSystemEvents=true`). |
| `adt trace statements <traceId> [--id N] [--with-details] [--auto N] [--system-events]`                                                            | `GET .../abaptraces/<id>/statements`.                                       |
| `adt trace parameters --file <xml>`                                                                                                                | `POST .../abaptraces/parameters` (creates a parameter set; returns its id). |
| `adt trace create --description ... --user ... --client ... --process-type ... --object-type ... --expires ... --max-exec ... --parameters-id ...` | Create a trace request.                                                     |
| `adt trace delete <traceConfigId>`                                                                                                                 | Remove a trace configuration.                                               |


`<traceId>` may use literal commas; the CLI re-encodes them as `%2c`.

```bash
adt trace list --user DEVELOPER
adt trace statements bti1033_acd_00,AT000020.DAT --id 1 --with-details
adt trace hitlist  bti1033_acd_00,AT000020.DAT
```

---

## `adt atc` — ABAP Test Cockpit

The four-step ATC flow (mirrors `src/api/atc.ts`):

1. **activate** a check variant — returns a `worklistId`
2. **run** the worklist over one or more object URLs — returns a `runId`
3. **worklist** — fetch the actual findings for that `runId`
4. **check** — convenience verb that does all three back-to-back

| Command                                                              | Endpoint                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------- |
| `adt atc activate <variant>`                                         | `POST /sap/bc/adt/atc/worklists?checkVariant=V`       |
| `adt atc run <worklistId> <objectUrl...> [--max N]`                  | `POST /sap/bc/adt/atc/runs?worklistId=W` (XML body)   |
| `adt atc worklist <runId> [--include-exempted] [--object-set NAME]`  | `GET  /sap/bc/adt/atc/worklists/<runId>`              |
| `adt atc check <objectUrl...> [--variant DEFAULT] [--max N] [--include-exempted]` | activate + run + worklist as one call    |
| `adt atc customizing`                                                | `GET  /sap/bc/adt/atc/customizing`                    |
| `adt atc users`                                                      | `GET  /sap/bc/adt/system/users`                       |

`adt atc check` and `adt atc worklist` exit with code `1` if the worklist
contains errors (`priority=1`) or warnings (`priority=2`), so they can gate
CI without extra glue.

```bash
# One-shot
adt atc check programs/programs/zhello_adt --variant DEFAULT --max 50

# Step-by-step
WL=$(adt atc activate DEFAULT --raw)
RUN=$(adt atc run "$WL" programs/programs/zhello_adt --max 50 | jq -r .id)
adt atc worklist "$RUN" --include-exempted
```

The result of `adt atc worklist` includes a `summary` block:

```json
"summary": { "total": 3, "errors": 0, "warnings": 2, "info": 1 }
```

If you don't know the variant id of your system, run
`adt atc customizing` and look at the `properties` array, or ask BC.
Common values are `DEFAULT`, `STANDARD`, `ABAPLINT_DEFAULT`,
`S4_CLOUD_PLATFORM_CHECKS`.

---

## `adt debug` — debugger

These mirror `restcalls/debugger.http`. Each profile gets a stable, random
`ideId` / `terminalId` written on first use (debugger sessions need stable IDs).


| Command                                                                                             | Endpoint                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `adt debug discovery`                                                                               | `GET /sap/bc/adt/debugger`.                                |
| `adt debug status [--mode user                                                                      | system] [--user U]`                                        |
| `adt debug listen [--mode user                                                                      | system] [--user U]`                                        |
| `adt debug settings (--file                                                                         | --default)`                                                |
| `adt debug breakpoint set <objectUri> --line <N> [--program P] [--include I] [--user U] [--mode m]` | `POST /sap/bc/adt/debugger/breakpoints` (line breakpoint). |
| `adt debug breakpoint delete <breakpointId> [--user U] [--mode m]`                                  | `DELETE /sap/bc/adt/debugger/breakpoints/<id>?...`.        |


```bash
adt debug status
adt debug settings --default
adt debug breakpoint set /sap/bc/adt/programs/programs/zroman/source/main --line 23
```

---

## `adt http` — generic request & .http files

### `adt http request` (alias `req`)

Escape hatch for any endpoint not yet wrapped explicitly.

```text
adt http request <METHOD> <path> [-H 'Header: value' ...]
                                 [--content-type <mime>]
                                 [--data <text> | --data-file <path>]
                                 [--no-fail]
```

```bash
adt http request GET /sap/bc/adt/discovery
adt http request POST /sap/bc/adt/datapreview/freestyle?rowNumber=2 \
                 --content-type text/plain \
                 --data 'SELECT * FROM /DMO/BOOKING'
adt http req PUT /sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/<id> \
             -H 'If-Match: 20210220150417' \
             --content-type application/vnd.sap.adt.configuration.v1+xml \
             --data-file my-config.xml
```

CSRF, cookies, and Authorization are added automatically. `--no-fail` keeps
the exit code at 0 even on HTTP non-2xx (the body is still printed).

### `adt http list` / `adt http run`

Drop in a VS Code REST Client `.http` file (such as the ones in
`../restcalls/`) and execute it as a single command.

```text
adt http list <file>                     # parse and list the named requests
adt http run  <file> [--var k=v ...]
                     [--only <name>]
                     [--continue-on-error]
                     [--print-each]
```

```bash
adt http list ../restcalls/cloud.http
adt http run  ../restcalls/cloud.http --var rows=5 --print-each
adt http run  ../restcalls/traces.http --only readtraces
```

These variables are pre-populated from the active profile when not defined
inside the file: `{{baseUrl}}`, `{{url}}`, `{{user}}`, `{{password}}`,
`{{loginUrl}}`, `{{clientId}}`, `{{clientSecret}}`, `{{refreshToken}}`,
`{{client}}`.

References resolve across requests in the same run, e.g.
`{{readtraces.response.headers.x-csrf-token}}` and
`{{refresh.response.body.access_token}}`.

---

## Recipes

### One-shot: create program + source + activate

```bash
adt object create program ZHELLO --package $YMU_PKG \
    --description "Hello" --source-file ./zhello.abap --activate
```

### Edit an existing report

```bash
adt object source     programs/programs/zhello > zhello.abap
$EDITOR zhello.abap
adt object set-source programs/programs/zhello --file zhello.abap --transport $TR
adt object activate   programs/programs/zhello
```

### Bootstrap a small RAP stack

```bash
PKG=$YMU_PKG TR=YMK900042

adt object create class      ZCL_BP_DEMO  --package $PKG --transport $TR
adt object create interface  ZIF_DEMO     --package $PKG --transport $TR
adt object create ddl        ZI_DEMO_VIEW --package $PKG --transport $TR \
                                          --source-file zi_demo_view.cds --activate
adt object create dcl        ZDCL_I_DEMO  --package $PKG --transport $TR \
                                          --source-file zdcl_i_demo.dcl --activate
adt object create service-def YMU_SRVD    --package $PKG --transport $TR \
                                          --source-file ymu_srvd.srvd --activate
adt object create service-binding YMU_SB  --package $PKG --transport $TR \
                                          --service YMU_SRVD --binding-type ODATA --category 0
```

### Pipe SQL results into `jq`

```bash
adt data sql 'SELECT CARRIER_ID, CUSTOMER_ID FROM /DMO/BOOKING WHERE BOOKING_ID = 0005' \
  | jq '.. | objects | select(has("@_name")) | {col: ."@_name", val: ."#text"}'
```

### Save a binary blob to disk

```bash
adt http request GET /sap/bc/adt/some/binary --raw --output dump.bin
```

### Use raw env tokens in CI

```bash
ADT_BEARER='<my-token>' adt -p ignored data sql 'SELECT * FROM /DMO/BOOKING' --rows 1
```

---

## Configuration file

Profiles live in `~/.adt-cli/config.json` (mode `0600`, override the location
with `ADT_CLI_HOME`). Layout:

```json
{
  "defaultProfile": "dev",
  "profiles": {
    "dev": {
      "kind": "basic",
      "url": "https://abap:44300",
      "user": "DEVELOPER",
      "password": "b64:ZGV2****",
      "client": "100",
      "language": "EN",
      "ideId": "<UUID>",
      "terminalId": "<UUID>",
      "insecure": false
    },
    "cloud": {
      "kind": "oauth",
      "url": "https://abap.host",
      "loginUrl": "https://uaa.host",
      "clientId": "sb-...",
      "clientSecret": "b64:****",
      "refreshToken": "b64:****",
      "accessToken": "<jwt>",
      "tokenExpiresAt": 1735689600000
    }
  }
}
```

Secrets are base64-obfuscated, **not encrypted**. Treat the file as
sensitive: protect it with OS permissions or use the `ADT_BEARER` /
`ADT_BASIC` env vars in CI.

---

## Exit codes


| Code | Meaning                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success.                                                                                                                                      |
| 1    | Generic failure: HTTP non-2xx (without `--no-fail`), parsing error, missing profile, network error, activation reported `success=false`, etc. |
| 2    | Authentication / verification failure (`adt auth login basic                                                                                  |
| 130  | Aborted with Ctrl-C while reading a hidden prompt.                                                                                            |


---

## Troubleshooting

- `**No default profile is configured**` — run `adt auth login basic|oauth ...`
with `--name <profile>` and (optionally) `adt auth profile use <profile>`.
- `**HTTP 403` on a write call** — the CSRF token expired. The CLI auto-retries
once. If you keep seeing it, run `adt -v <command>` to see the exact request,
or `--debug` to see headers.
- `**HTTP 401` on a stateful flow** — your session was probably terminated by
the server. Re-run the command (cookies are per-process, so each invocation
starts fresh).
- **TLS errors** — pass `--insecure` or save it on the profile via
`adt auth login basic ... --insecure`.
- **Wrong content-type on PUT** — `adt object set-source` chooses based on
whether the body starts with `<?xml`. Use `adt http request PUT --content-type ...`
for full control.
- **OAuth refresh failed** — re-run `adt auth login oauth ...` with a fresh
refresh token (the IdP may have rotated yours).
- `**Validation failed: ERROR ...`** — re-run with `--debug` to see the full
validation response, then fix the name / package / type combination.
- **Missing endpoint** — fall back to `adt http request <METHOD> <path>` and
open an issue with the URL/body so it can be wrapped properly.

---

## Source map (TypeScript API ↔ CLI)


| Source                       | CLI commands                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restcalls/cloud.http`       | `adt auth login oauth`, `adt object properties`, `adt data ddic-meta`, `adt data ddic`, `adt data sql`, `adt service binding`, `adt service odata-v2` |
| `restcalls/debugger.http`    | `adt system discovery`, `adt system feeds`, `adt system dumps`, `adt debug ...`                                                                       |
| `restcalls/hana1909.http`    | `adt system core-discovery`, `adt system graph`, `adt system object-types`, `adt system type-structure`, `adt system users`, `adt cts ...`            |
| `restcalls/revisions.http`   | `adt object source`, `adt object versions`                                                                                                            |
| `restcalls/traces.http`      | `adt trace list/requests/hitlist/db/statements/parameters/create/delete`                                                                              |
| `src/api/objectcreator.ts`   | `adt object create <kind>`, `adt object create-types`, `adt object create-generic`, `adt object validate`                                             |
| `src/api/objectcontents.ts`  | `adt object lock`, `adt object unlock`, `adt object set-source`, `adt object source`                                                                  |
| `src/api/activate.ts`        | `adt object activate`, `adt object inactive`                                                                                                          |
| `src/api/objectstructure.ts` | `adt object structure`                                                                                                                                |
| `src/api/delete.ts`          | `adt object delete`                                                                                                                                   |


