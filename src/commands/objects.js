"use strict";

// `adt object <verb>` - everything you can do to an existing repository object.
//
// Read:
//   adt object structure  <objectUrl>
//   adt object properties <objectUri>
//   adt object source     <objectUrl> [--include I] [--version V] [--output F]
//   adt object versions   <objectUrl> [--include I]
//   adt object list       [--package PKG | --parent-type T --parent-name N] [--user U] [--json]
//
// Write:
//   adt object set-source <objectUrl> [--file F | --source-stdin] [--include I]
//                         [--transport TR] [--keep-locked] [--lock-handle H]
//   adt object activate   <objectUrl> [--name N] [--main-include URI] [--no-preaudit]
//   adt object delete     <objectUrl> [--transport TR] [--handle H]
//
// Lock primitives (rarely needed; set-source/delete handle them):
//   adt object lock   <objectUrl> [--mode MODIFY|DISPLAY]
//   adt object unlock <objectUrl> --handle <LOCK_HANDLE>
//
//   adt object inactive
//
// `<objectUrl>` accepts a relative path (programs/programs/zhello), an absolute
// path (/sap/bc/adt/...), or a full URL. The `properties` command takes the
// /sap/bc/adt/...source/main URI of the object instead.

const fs = require("fs");
const log = require("../logger");
const objLib = require("../objLib");
const { renderJson, renderResponse, ensureOk } = require("../output");

function register(object) {
  // -------- read commands ------------------------------------------------

  object
    .command("structure")
    .description("Read the object metadata for an existing ADT object.")
    .argument("<objectUrl>", "ADT path or URL, e.g. programs/programs/zhello")
    .option("--version <v>", "active | inactive | workingArea")
    .action(async function (objectUrl, opts) {
      const ctx = this.ctx;
      const body = await objLib.structure(ctx.getClient(), objectUrl, opts.version);
      renderJson(body);
    });

  object
    .command("properties")
    .description(
      "Read property values for an ADT URI (object properties endpoint). " +
        "Accepts the object's source URI (e.g. /sap/bc/adt/.../source/main)."
    )
    .argument("<uri>", "ADT URI, e.g. /sap/bc/adt/ddic/tables/%2fdmo%2ftravel/source/main")
    .action(async function (uri) {
      const ctx = this.ctx;
      const url =
        `/sap/bc/adt/repository/informationsystem/objectproperties/values?uri=` +
        encodeURIComponent(uri);
      const res = await ctx.getClient().send("GET", url, {
        accept:
          ctx.globalOpts.accept ||
          "application/vnd.sap.adt.repository.objproperties.result.v1+xml",
        headers: { "x-csrf-token": "fetch" },
      });
      ensureOk(res, "object properties");
      renderResponse(res, ctx.globalOpts);
    });

  object
    .command("source")
    .description(
      "Read an object's source. Combines what was previously `adt source` and `adt get-source`."
    )
    .argument("<objectUrl>", "ADT path or URL of the object (with or without /source/<incl>)")
    .option("--include <name>", "include name", "main")
    .option("--version <v>", "active | inactive | workingArea")
    .action(async function (objectUrl, opts) {
      const ctx = this.ctx;
      const text = await objLib.getSource(ctx.getClient(), objectUrl, {
        include: opts.include,
        version: opts.version,
      });
      if (ctx.globalOpts.output) {
        fs.writeFileSync(ctx.globalOpts.output, text, "utf8");
        log.ok(`Wrote ${Buffer.byteLength(text)} bytes to ${ctx.globalOpts.output}`);
      } else {
        process.stdout.write(text);
        if (!text.endsWith("\n")) process.stdout.write("\n");
      }
    });

  //List the children of a tree node (package or sub-package) via
  // the repository nodestructure endpoint. Emits the full { nodes, categories,
  // objectTypes } payload so consumers can rebuild an Eclipse-style category tree.
  object
    .command("list")
    .description("List the direct children of an ADT tree node (package / sub-package).")
    .option("--package <pkg>", "package name (shorthand for --parent-type DEVC/K --parent-name <pkg>)")
    .option("--parent-type <type>", "ADT parent type, e.g. DEVC/K", "DEVC/K")
    .option("--parent-name <name>", "ADT parent name")
    .option("--parent-tech-name <name>", "ADT parent technical name (defaults to --parent-name)")
    .option("--user <user>", "scope local objects to a user (for $TMP)")
    .option("--json", "emit JSON (default output is already JSON)")
    .action(async function (opts) {
      const ctx = this.ctx;
      const parentName = opts.package || opts.parentName;
      const parentType = opts.package ? "DEVC/K" : opts.parentType;
      const result = await objLib.listNodes(ctx.getClient(), {
        parentType,
        parentName,
        parentTechName: opts.parentTechName || parentName,
        userName: opts.user,
      });
      renderJson(result, ctx.globalOpts);
    });

  object
    .command("versions")
    .description("List version history of an ABAP object.")
    .argument("<objectUrl>", "ADT path or URL")
    .option("--include <name>", "include name", "main")
    .action(async function (objectUrl, opts) {
      const ctx = this.ctx;
      const url = objLib.normalizeObjectUrl(objectUrl);
      const fullUrl = url.endsWith(`/source/${opts.include}`)
        ? `${url}/versions`
        : `${url}/source/${encodeURIComponent(opts.include)}/versions`;
      const res = await ctx.getClient().send("GET", fullUrl, {
        accept: ctx.globalOpts.accept || "application/atom+xml;type=feed",
        headers: { "Cache-Control": "no-cache", "X-sap-adt-sessiontype": "stateless" },
      });
      ensureOk(res, "versions");
      renderResponse(res, ctx.globalOpts);
    });

  // -------- write commands ----------------------------------------------

  object
    .command("set-source")
    .description("Lock + PUT source + unlock for an ADT object (stateful).")
    .argument("<objectUrl>", "ADT path or URL of the object (without /source/<incl>)")
    .option("--file <file>", "source file (omit to read from stdin)")
    .option("--source-stdin", "force reading from stdin even when stdin is a TTY")
    .option("--include <name>", "include name", "main")
    .option("--transport <id>", "corrNr (transport request id)")
    .option("--keep-locked", "do not unlock at the end (advanced)")
    .option("--lock-handle <handle>", "use an existing lock instead of acquiring a new one")
    .action(async function (objectUrl, opts) {
      const ctx = this.ctx;
      const source = opts.file ? fs.readFileSync(opts.file, "utf8") : await readStdin();
      const result = await objLib.putSource(ctx.getClient(), objectUrl, source, {
        include: opts.include,
        transport: opts.transport,
        keepLocked: !!opts.keepLocked,
        lockHandle: opts.lockHandle,
      });
      renderJson(result);
    });

  object
    .command("activate")
    .description("Activate an ABAP object via /sap/bc/adt/activation.")
    .argument("<objectUrl>", "ADT path or URL of the object")
    .option("--name <name>", "object name (defaults to the last segment of the URL, uppercased)")
    .option("--main-include <uri>", "context/mainInclude URI (rare; for class includes)")
    .option("--no-preaudit", "set preauditRequested=false")
    .action(async function (objectUrl, opts) {
      const ctx = this.ctx;
      const name = opts.name || deriveName(objectUrl);
      const result = await objLib.activate(ctx.getClient(), name, objectUrl, {
        mainInclude: opts.mainInclude,
        preauditRequested: opts.preaudit !== false,
      });
      renderJson(result);
      if (!result.success) process.exitCode = 1;
    });

  object
    .command("delete")
    .description(
      "Delete an ADT object (acquires a lock automatically if --handle is omitted)."
    )
    .argument("<objectUrl>", "ADT path or URL")
    .option("--transport <id>", "corrNr (transport request id)")
    .option("--handle <handle>", "use an existing lock handle (skips auto-lock)")
    .action(async function (objectUrl, opts) {
      const ctx = this.ctx;
      const result = await objLib.deleteObject(ctx.getClient(), objectUrl, {
        transport: opts.transport,
        lockHandle: opts.handle,
      });
      renderJson(result);
    });

  // -------- lock primitives ---------------------------------------------

  object
    .command("lock")
    .description("Acquire a MODIFY lock on an ADT object (rarely needed standalone).")
    .argument("<objectUrl>", "ADT path or URL")
    .option("--mode <mode>", "accessMode", "MODIFY")
    .action(async function (objectUrl, opts) {
      const ctx = this.ctx;
      const handle = await objLib.lock(ctx.getClient(), objectUrl, opts.mode);
      renderJson(handle);
    });

  object
    .command("unlock")
    .description("Release a previously acquired lock.")
    .argument("<objectUrl>", "ADT path or URL")
    .requiredOption("--handle <handle>", "the LOCK_HANDLE returned by `adt object lock`")
    .action(async function (objectUrl, opts) {
      const ctx = this.ctx;
      await objLib.unLock(ctx.getClient(), objectUrl, opts.handle);
      renderJson({ unlocked: true });
    });

  object
    .command("inactive")
    .description("List inactive objects waiting for activation.")
    .action(async function () {
      const ctx = this.ctx;
      const body = await objLib.inactiveObjects(ctx.getClient());
      renderJson(body);
    });
}

function deriveName(objectUrl) {
  const url = objLib.normalizeObjectUrl(objectUrl);
  const path = url.split("?")[0].split("#")[0];
  // Strip optional /source/<include> tail to get the "object" segment.
  const noSource = path.replace(/\/source\/[^/]+$/, "");
  const last = noSource.split("/").filter(Boolean).pop() || "";
  return decodeURIComponent(last).toUpperCase();
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
