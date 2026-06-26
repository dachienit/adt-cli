# Real test: create a simple ABAP report with `adt-cli`

This walkthrough takes you from a fresh checkout to a working ABAP `REPORT`
in your SAP system, exercising every important command in the CLI:
authentication, validation, creation, source upload, activation, read-back,
edit round-trip, and cleanup.

The whole flow uses package `$TMP` so **no transport request is required**.
For non-`$TMP` packages, every `set-source` / `delete` / `activate` step
needs a `--transport <TR>` option.

---

## 0. Prerequisites

```powershell
# In PowerShell (Windows). Use the bash equivalent on Linux/macOS.
cd C:\Users\lha2hc\Documents\projects\abap-adt-api\adt-cli
node bin/adt.js --help    # sanity check
```

---

## 1. Save credentials and verify

Pick the matching block.

### On-prem ABAP

```powershell
node bin/adt.js auth login basic `
  --name dev `
  --url https://abap.host:44300 `
  --user DEVELOPER `
  --password 'YourPass!' `
  --client 100 --language EN
# Self-signed cert? Append:  --insecure
```

### BTP / Steampunk (refresh-token grant)

```powershell
node bin/adt.js auth login oauth `
  --name dev `
  --url https://abap.host `
  --login-url https://uaa.host `
  --client-id sb-... `
  --client-secret '****' `
  --refresh-token '****'
```

### BTP via destination service

When the CLI runs on Cloud Foundry / Kyma (or you can hand it a service
binding), you can avoid storing any URL or credentials by referencing a
destination by name. The resolver follows the same lookup order as
`@sap-cloud-sdk/connectivity`: `process.env.destinations` -> profile's
`serviceBindingJson` override -> `VCAP_SERVICES.destination`.

```powershell
# On BTP - VCAP_SERVICES.destination is auto-discovered
node bin/adt.js auth login destination --destination MY_ABAP --name btp

# Local dev - mock the same destination via env
$env:destinations = '[{"name":"MY_ABAP","url":"https://abap.host:44300","username":"DEVELOPER","password":"YourPass!"}]'
node bin/adt.js auth login destination --destination MY_ABAP --name btp

# Discover what is visible to the process (no profile needed)
node bin/adt.js auth destinations list
node bin/adt.js auth destinations show MY_ABAP
node bin/adt.js auth destinations test MY_ABAP   # resolve + /discovery
```

You should see:

```
STEP Verifying profile "dev" via /sap/bc/adt/discovery ...
OK   Authentication OK. basic as DEVELOPER.
```

Re-test any time with:

```powershell
node bin/adt.js auth login test --name dev
```

---

## 2. Pick the program name and write the source locally

```powershell
$PROG = "ZHELLO_ADT"
$src = @'
REPORT zhello_adt.

PARAMETERS p_name TYPE string DEFAULT 'World' LOWER CASE.

WRITE: / 'Hello, ', p_name, '!'.
WRITE: / 'Created via adt-cli at', sy-datum, sy-uzeit.
'@

# IMPORTANT on Windows PowerShell 5.x: `Out-File -Encoding utf8` writes a
# UTF-8 BOM, which ABAP rejects with a misleading "REPORT not expected".
# Use WriteAllText (BOM-less) or `Set-Content -Encoding utf8NoBOM` (PS 7+).
[System.IO.File]::WriteAllText("$PWD\zhello_adt.abap", $src, [System.Text.UTF8Encoding]::new($false))

Get-Content zhello_adt.abap     # peek at the file
```

The CLI also strips a leading BOM defensively before pushing source, so even
a BOM-laden file would now work — but you should still keep the file
clean for any other tool that reads it.

---

## 3. Dry run: validate the name first (optional but nice)

```powershell
node bin/adt.js object validate program $PROG --package '$TMP'
```

Expected:

```json
{
  "httpStatus": 200,
  "severity": null,
  "shortText": null,
  "checkResult": null,
  "success": true
}
```

---

## 4. Create + push source + activate in one shot

```powershell
node bin/adt.js -v object create program $PROG `
  --package '$TMP' `
  --description "Hello from adt-cli" `
  --source-file .\zhello_adt.abap `
  --activate
```

The `-v` makes every HTTP step visible. You should see, in order:

```
STEP Validating Program ZHELLO_ADT -> POST programs/validation
OK   Validation passed.
STEP Creating Program ZHELLO_ADT -> POST /sap/bc/adt/programs/programs
OK   Program ZHELLO_ADT created.
STEP Fetching CSRF token from /sap/bc/adt/discovery
OK   Locked /sap/bc/adt/programs/programs/ZHELLO_ADT; handle = ...
STEP PUT source -> /sap/bc/adt/programs/programs/ZHELLO_ADT/source/main (... bytes)
OK   Source updated.
OK   Unlocked /sap/bc/adt/programs/programs/ZHELLO_ADT
STEP Activating ZHELLO_ADT via /sap/bc/adt/activation
{
  "success": true,
  "messages": [],
  "inactive": [],
  "httpStatus": 200
}
```

---

## 5. Verify the round-trip

```powershell
# Read source back
node bin/adt.js object source programs/programs/$PROG

# Read metadata (changedBy, type, etag, links, ...)
node bin/adt.js object structure programs/programs/$PROG

# List versions (you should see one entry now)
node bin/adt.js object versions programs/programs/$PROG

# Confirm there are no inactive leftovers
node bin/adt.js object inactive
```

---

## 6. Edit the report (round-trip flow)

```powershell
# Pull, edit, push, activate
node bin/adt.js object source programs/programs/$PROG --output zhello_adt.abap

# Make a small change - e.g. another WRITE line
Add-Content zhello_adt.abap "WRITE: / 'Edited at', sy-uzeit."

node bin/adt.js -v object set-source programs/programs/$PROG --file .\zhello_adt.abap
node bin/adt.js -v object activate   programs/programs/$PROG
```

Because the package is `$TMP`, no `--transport` is needed.
For a real package, add `--transport YMK900042` to both `set-source` and
`delete`.

---

## 7. "Run" the report (no GUI)

`adt-cli` doesn't render a SAP GUI screen, but the activation block above
proves the report compiles. To exercise ABAP execution from the HTTP
surface, use the SQL data preview against a real table (`T000` is the
client table and exists on every ABAP system):

```powershell
node bin/adt.js data sql 'SELECT MANDT, MTEXT FROM T000' --rows 5
```

You should get back a small JSON table.

(Actually starting the report runs in SE38/SAP GUI; ADT's HTTP surface
doesn't expose a "run report" verb.)

---

## 7b. Run an ATC check on the report

`adt atc` exposes the four-step ABAP Test Cockpit flow:

1. activate a check variant - returns a `worklistId`
2. run the worklist over one or more object URLs - returns a `runId`
3. fetch the worklist for that run - returns the actual findings
4. (one-shot) `adt atc check` does all three back-to-back

### One-shot

```powershell
node bin/adt.js atc check programs/programs/$PROG --variant DEFAULT --max 50
```

Expected output:

```json
{
  "variant": "DEFAULT",
  "worklistId": "...",
  "runId": "...",
  "id": "...",
  "timestamp": 1747000000000,
  "usedObjectSet": "ALL",
  "objectSetIsComplete": true,
  "objectSets": [ ... ],
  "objects": [
    {
      "uri": "/sap/bc/adt/programs/programs/ZHELLO_ADT",
      "name": "ZHELLO_ADT",
      "type": "PROG/P",
      "packageName": "$TMP",
      "author": "DEVELOPER",
      "findings": [
        {
          "priority": 2,
          "checkId": "...",
          "checkTitle": "...",
          "messageId": "...",
          "messageTitle": "...",
          "location": { ... },
          "uri": "/sap/bc/adt/programs/programs/ZHELLO_ADT#start=...",
          "exemptionApproval": "",
          "exemptionKind": ""
        }
      ]
    }
  ],
  "summary": { "total": 1, "errors": 0, "warnings": 1, "info": 0 }
}
```

`adt atc check` exits with code `1` when `summary.errors > 0` or
`summary.warnings > 0` so it can gate CI.

### Step-by-step (when you want to inspect each round-trip)

```powershell
# 1. Activate the variant
$WL = (node bin/adt.js atc activate DEFAULT --raw).Trim()
echo "worklistId=$WL"

# 2. Start the run (prints { id, timestamp, infos })
$RUN = node bin/adt.js atc run $WL programs/programs/$PROG --max 50 | ConvertFrom-Json
echo "runId=$($RUN.id)"

# 3. Fetch findings
node bin/adt.js atc worklist $RUN.id --include-exempted
```

### Other ATC verbs

```powershell
# List configured properties + exemption reasons
node bin/adt.js atc customizing

# List ATC processors (used when changing the contact for a finding)
node bin/adt.js atc users
```

If your system uses a different default variant, ask BC or use
`adt atc customizing` to discover the available ones; common values are
`DEFAULT`, `STANDARD`, `ABAPLINT_DEFAULT`, `S4_CLOUD_PLATFORM_CHECKS`.

---

## 8. Cleanup

```powershell
node bin/adt.js -v object delete programs/programs/$PROG
# For a non-$TMP package add: --transport YMK900042
```

You should see:

```
OK   Locked /sap/bc/adt/programs/programs/ZHELLO_ADT; handle = ...
STEP DELETE /sap/bc/adt/programs/programs/ZHELLO_ADT
OK   Deleted /sap/bc/adt/programs/programs/ZHELLO_ADT.
```

---

## Troubleshooting cheatsheet

| Symptom | Cause / fix |
|---|---|
| `HTTP 401` on step 1 | Wrong user/password/client. Re-run `adt auth login basic ...`. |
| `HTTP 403` mentioning `X-CSRF-Token: required` | Rare; the CLI auto-retries once. |
| `Validation failed: ERROR Object name not allowed` | Name does not start with a customer namespace (typically `Z` or `Y`) or is too long. |
| `HTTP 403` on create with a real package | The package is locked or you don't have permission. Use `$TMP` for testing. |
| `HTTP 423 Locked` | Someone (or a previous failed run) holds the lock. Wait, or `adt object unlock programs/programs/$PROG --handle <H>`. |
| `success: false` in activation output | Syntax error - the `messages` array tells you which line. Fix the `.abap` file and re-run `set-source` + `activate`. |
| TLS certificate errors | Append `--insecure` to step 1. |

---

## One-liner recap (everything in 4 lines)

```powershell
"REPORT zhello_adt. WRITE: / 'Hello from adt-cli', sy-datum." | Out-File -Encoding utf8 zhello_adt.abap
node bin/adt.js auth login basic --name dev --url https://abap.host:44300 --user DEVELOPER --password 'YourPass!'
node bin/adt.js -v object create program ZHELLO_ADT --package '$TMP' --description "Hi" --source-file .\zhello_adt.abap --activate
node bin/adt.js object source programs/programs/ZHELLO_ADT
```
