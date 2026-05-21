"use strict";

// `adt create <kind> <name>` - create ABAP objects.
//
// One subcommand per alias from createables.js so that --help shows the right
// flags for each (e.g. service-binding has --service / --binding-type).
// The shared work (validate, POST, optional source push, optional activate)
// lives in `runCreate` so the per-kind handlers stay tiny.
//
// Convenience flags (across all kinds):
//   --validate-only   stop after the validation call (no POST creation)
//   --no-validate     skip the validation call
//   --source-file F   after creation, lock + PUT source from file (stateful)
//   --source-stdin    same but read source from stdin
//   --activate        after creating (and optional source push), activate
//   --transport TR    pass corrNr=TR on creation/source/delete
//
// All actions are stateful when a lock is required.

const fs = require("fs");
const log = require("../logger");
const createables = require("../createables");
const { renderJson, ensureOk } = require("../output");
const objLib = require("../objLib");

function register(object) {
  const create = object
    .command("create")
    .description("Create ABAP development objects (program, class, package, ...).");

  for (const t of createables.list()) {
    const cmd = create
      .command(t.alias)
      .description(`Create a ${t.label} (${t.typeId}).`)
      .argument("<name>", `${t.label} name (max ${t.maxLen} chars)`);

    addCommonOptions(cmd, t);
    addTypeSpecificOptions(cmd, t);

    cmd.action(async function (name, opts) {
      const ctx = this.ctx;
      // Translate commander's per-kind flags (--package / --group /
      // --super-package / --service / ...) into the shared shape that
      // validationQuery() and the body builders expect (parentName, ...).
      const merged = mergeFromKindOpts(t, name, opts);
      await runCreate(ctx, t, name, merged);
    });
  }

  // Sibling commands on `adt object`: create-types, create-generic, validate.
  object
    .command("create-types")
    .description("List the object types this CLI knows how to create.")
    .action(() => {
      const items = createables.list().map((t) => ({
        alias: t.alias,
        typeId: t.typeId,
        label: t.label,
        parent: t.parent,
        creationPath: t.creationPath,
        maxLen: t.maxLen,
      }));
      renderJson(items);
    });

  object
    .command("create-generic")
    .description(
      "Create an object of any registered typeId. Equivalent to `adt object create <alias>`."
    )
    .requiredOption("--type <typeId>", "object typeId, e.g. PROG/P, CLAS/OC")
    .requiredOption("--name <name>", "object name")
    .option("--description <text>", "description", "")
    .option("--package <pkg>", "parent package (most types)")
    .option("--group <fgroup>", "parent function group (FUGR/FF, FUGR/I)")
    .option("--super-package <pkg>", "super package (DEVC/K only)")
    .option("--swcomp <comp>", "software component (DEVC/K only)")
    .option("--transport-layer <layer>", "transport layer (DEVC/K only)")
    .option("--package-type <kind>", "development|structure|main (DEVC/K only)")
    .option("--service <name>", "service definition (SRVB/SVB only)")
    .option("--binding-type <type>", "ODATA (SRVB/SVB only)", "ODATA")
    .option("--category <0|1>", "binding category 0=Web API, 1=UI (SRVB/SVB)", "0")
    .option("--responsible <user>", "adtcore:responsible (default = profile user)")
    .option("--transport <id>", "corrNr (transport request id)")
    .option("--validate-only", "stop after validation")
    .option("--no-validate", "skip validation")
    .option("--source-file <file>", "after creation, push this file as source")
    .option("--source-stdin", "after creation, read source from stdin and push")
    .option("--activate", "activate after creation/source push")
    .action(async function (opts) {
      const ctx = this.ctx;
      const t = createables.lookup(opts.type);
      if (!t) throw new Error(`Unknown typeId "${opts.type}". See "adt object create-types".`);
      const cliOpts = mergeGeneric(t, opts);
      await runCreate(ctx, t, opts.name, cliOpts);
    });

  object
    .command("validate")
    .description("Run server-side name validation for a not-yet-created object.")
    .argument("<kind>", "alias from `adt object create-types`, e.g. program, class, package")
    .argument("<name>", "object name")
    .option("--description <text>", "description", "")
    .option("--package <pkg>", "parent package")
    .option("--group <fgroup>", "parent function group (for FUGR members)")
    .option("--super-package <pkg>", "super package (DEVC/K)")
    .option("--swcomp <comp>", "software component (DEVC/K)")
    .option("--transport-layer <layer>", "transport layer (DEVC/K)")
    .option("--package-type <kind>", "package type (DEVC/K)")
    .action(async function (kind, name, opts) {
      const ctx = this.ctx;
      const t = createables.lookup(kind);
      if (!t) throw new Error(`Unknown kind "${kind}". See "adt object create-types".`);
      const merged = mergeFromKindOpts(t, name, opts);
      const result = await validateNew(ctx, t, merged);
      renderJson(result);
    });
}

function addCommonOptions(cmd, t) {
  cmd
    .option("--description <text>", "description", "")
    .option("--responsible <user>", "adtcore:responsible (default = profile user)")
    .option("--transport <id>", "corrNr (transport request id)")
    .option("--validate-only", "run validation and stop")
    .option("--no-validate", "skip validation")
    .option("--source-file <file>", "after creation, lock + PUT source from this file")
    .option("--source-stdin", "after creation, read source from stdin and PUT it")
    .option("--activate", "activate after creation (and after source push if any)");
}

function addTypeSpecificOptions(cmd, t) {
  if (t.typeId === "DEVC/K") {
    cmd
      .option("--super-package <pkg>", "super package (parent in the hierarchy)")
      .option("--swcomp <comp>", "software component, e.g. HOME or LOCAL")
      .option("--transport-layer <layer>", "transport layer, e.g. SAP or HOME")
      .option("--package-type <kind>", "development|structure|main", "development");
    return;
  }
  if (t.parent === "fgroup") {
    cmd.requiredOption("--group <fgroup>", "parent function group");
    return;
  }
  if (t.typeId === "SRVB/SVB") {
    cmd
      .requiredOption("--package <pkg>", "parent package")
      .requiredOption("--service <name>", "service definition (srvd) name")
      .option("--binding-type <type>", "binding type, currently only ODATA", "ODATA")
      .option("--category <0|1>", "0 = Web API, 1 = UI", "0");
    return;
  }
  cmd.requiredOption("--package <pkg>", "parent package");
}

function mergeFromKindOpts(t, name, opts) {
  const out = {
    name,
    description: opts.description || "",
    responsible: opts.responsible,
    transport: opts.transport,
    validateOnly: !!opts.validateOnly,
    skipValidate: opts.validate === false,
    sourceFile: opts.sourceFile,
    sourceStdin: !!opts.sourceStdin,
    activate: !!opts.activate,
  };
  if (t.typeId === "DEVC/K") {
    out.parentName = opts.superPackage || opts.package || "";
    out.swcomp = opts.swcomp;
    out.transportLayer = opts.transportLayer;
    out.packageType = opts.packageType || "development";
  } else if (t.parent === "fgroup") {
    out.parentName = opts.group;
    // The parent FUGR/F lives at this URL on the server; needed for the body.
    out.parentPath = `/sap/bc/adt/functions/groups/${encodeURIComponent(
      String(out.parentName || "").toLowerCase()
    )}`;
  } else if (t.typeId === "SRVB/SVB") {
    out.parentName = opts.package;
    out.service = opts.service;
    out.bindingType = opts.bindingType || "ODATA";
    out.category = opts.category || "0";
  } else {
    out.parentName = opts.package;
  }
  return out;
}

function mergeGeneric(t, opts) {
  return mergeFromKindOpts(t, opts.name, {
    ...opts,
    package: opts.package,
    group: opts.group,
    superPackage: opts.superPackage,
  });
}

async function validateNew(ctx, t, merged) {
  if (!t.validationPath) {
    log.info(`Type ${t.typeId} has no validation endpoint - skipping.`);
    return { skipped: true };
  }
  const q = createables.validationQuery(t, merged);
  const url = `/sap/bc/adt/${t.validationPath}?${q.toString()}`;
  log.step(`Validating ${t.label} ${merged.name} -> POST ${t.validationPath}`);
  // The validation endpoint only produces application/vnd.sap.as+xml;
  // sending application/xml triggers an HTTP 406 from the server.
  const res = await ctx.getClient().send("POST", url, {
    accept: "application/vnd.sap.as+xml",
  });
  ensureOk(res, "validate-new");
  // The TS API only throws on SEVERITY=ERROR; otherwise the call returned 2xx.
  return summarizeValidation(res);
}

function summarizeValidation(res) {
  // Pull SEVERITY/SHORT_TEXT/CHECK_RESULT from the asx:abap envelope when present.
  let severity, shortText, checkResult;
  const body = res.body;
  if (body && typeof body === "object") {
    const data = walk(body, ["asx:abap", "asx:values", "DATA"]);
    if (data) {
      severity = data.SEVERITY;
      shortText = data.SHORT_TEXT;
      checkResult = data.CHECK_RESULT;
    }
  }
  return {
    httpStatus: res.status,
    severity: severity || null,
    shortText: shortText || null,
    checkResult: checkResult ?? null,
    success: severity !== "ERROR",
    body: res.body,
  };
}

function walk(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null) return null;
    cur = cur[k];
  }
  return cur;
}

async function runCreate(ctx, t, name, opts) {
  const merged = { ...opts, name };
  if (!merged.responsible) {
    const profile = ctx.getProfile();
    merged.responsible = (profile.user || "").toUpperCase();
  }

  enforceMaxLen(t, name);

  const client = ctx.getClient();

  if (!merged.skipValidate) {
    const v = await validateNew(ctx, t, merged);
    if (v && v.severity === "ERROR") {
      throw new Error(`Validation failed: ${v.shortText || "ERROR"}`);
    }
    if (merged.validateOnly) {
      renderJson(v);
      return;
    }
    log.ok(`Validation passed${v.shortText ? ": " + v.shortText : ""}.`);
  }

  // Create
  const url = createables.creationUrl(t, merged.parentName);
  const body = createables.buildBody(t, merged);
  const qs = merged.transport ? `?corrNr=${encodeURIComponent(merged.transport)}` : "";
  log.step(`Creating ${t.label} ${name} -> POST ${url}${qs}`);
  if (log.getLevel() >= 3) log.debug("create body", body);
  const res = await client.send("POST", url + qs, {
    // Some ADT create endpoints only emit application/vnd.sap.as+xml; use
    // a wildcard Accept like the reference TS client to avoid HTTP 406s.
    accept: "*/*",
    headers: { "Content-Type": "application/*" },
    body,
  });
  ensureOk(res, `create ${t.alias}`);
  log.ok(`${t.label} ${name} created.`);

  const objUrl = createables.objectUrl(t, name, merged.parentName);
  log.info(`Object URL: ${objUrl}`);

  // Optional source push (stateful: lock -> PUT source -> unlock).
  if (merged.sourceFile || merged.sourceStdin) {
    const source = merged.sourceFile
      ? fs.readFileSync(merged.sourceFile, "utf8")
      : await readStdin();
    await objLib.putSource(client, objUrl, source, {
      transport: merged.transport,
      include: defaultIncludeFor(t),
    });
  }

  // Optional activate
  if (merged.activate) {
    const result = await objLib.activate(client, name, objUrl);
    renderJson(result);
    if (!result.success) process.exitCode = 1;
    return;
  }

  // Default output: a tiny summary the agent can pipe.
  renderJson({
    created: true,
    typeId: t.typeId,
    name,
    objectUrl: objUrl,
    sourcePushed: !!(merged.sourceFile || merged.sourceStdin),
    activated: !!merged.activate,
  });
}

function defaultIncludeFor(t) {
  // Most types use 'main' as their source include. Class/include exceptions
  // can be handled by the user via `adt put-source --include <name>`.
  return "main";
}

function enforceMaxLen(t, name) {
  if (t.maxLen && name.length > t.maxLen) {
    throw new Error(`Name "${name}" is ${name.length} chars; ${t.label} max is ${t.maxLen}.`);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

module.exports = { register };
