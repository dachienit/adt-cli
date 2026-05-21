"use strict";

// `adt debug <verb>` - ABAP debugger control endpoints.
// Mirrors restcalls/debugger.http.
//
//   adt debug discovery
//   adt debug status   [--mode user|system] [--user U]
//   adt debug listen   [--mode user|system] [--user U]   (long-poll)
//   adt debug settings (--file <xml> | --default)
//   adt debug breakpoint set <objectUri> --line <n> [--program P] [--include I]
//   adt debug breakpoint delete <breakpointId> [--user U]

const fs = require("fs");
const log = require("../logger");
const config = require("../config");
const { renderResponse, ensureOk } = require("../output");

function register(debug) {
  debug
    .command("discovery")
    .description("GET /sap/bc/adt/debugger - discovery feed.")
    .action(async function () {
      const ctx = this.ctx;
      const res = await ctx.getClient().send("GET", "/sap/bc/adt/debugger", {
        accept: ctx.globalOpts.accept || "application/*",
      });
      ensureOk(res, "debug discovery");
      renderResponse(res, ctx.globalOpts);
    });

  debug
    .command("status")
    .description("GET listeners (debug status).")
    .option("--mode <m>", "debuggingMode", "user")
    .option("--user <user>", "requestUser (defaults to profile user)")
    .action(async function (opts) {
      const ctx = this.ctx;
      const profile = config.ensureIds(ctx.getProfile());
      const user = opts.user || profile.user || "DEVELOPER";
      const url =
        `/sap/bc/adt/debugger/listeners?debuggingMode=${encodeURIComponent(opts.mode)}` +
        `&requestUser=${encodeURIComponent(user)}` +
        `&terminalId=${profile.terminalId}` +
        `&ideId=${profile.ideId}`;
      const res = await ctx.getClient().send("GET", url, {
        accept: ctx.globalOpts.accept || "application/*",
        headers: { "x-csrf-token": "fetch" },
      });
      ensureOk(res, "debug status");
      renderResponse(res, ctx.globalOpts);
    });

  debug
    .command("listen")
    .description("Start listening for debug events (POST listeners; long-running).")
    .option("--mode <m>", "debuggingMode", "user")
    .option("--user <user>", "requestUser (defaults to profile user)")
    .action(async function (opts) {
      const ctx = this.ctx;
      const profile = config.ensureIds(ctx.getProfile());
      const user = opts.user || profile.user || "DEVELOPER";
      const url =
        `/sap/bc/adt/debugger/listeners?debuggingMode=${encodeURIComponent(opts.mode)}` +
        `&requestUser=${encodeURIComponent(user)}` +
        `&terminalId=${profile.terminalId}` +
        `&ideId=${profile.ideId}` +
        `&checkConflict=true&isNotifiedOnConflict=true`;
      log.warn("Starting long-poll listener. Press Ctrl-C to abort.");
      const client = ctx.getClient();
      await client.ensureCsrf(true);
      const res = await client.send("POST", url, {
        accept:
          ctx.globalOpts.accept ||
          "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.debugger.DebuggeesList",
        headers: { "X-sap-adt-profiling": "server-time" },
      });
      ensureOk(res, "debug listen");
      renderResponse(res, ctx.globalOpts);
    });

  debug
    .command("settings")
    .description("POST debugger settings XML.")
    .option("--file <file>", "XML body file")
    .option("--default", "post the canonical defaults from restcalls/debugger.http")
    .action(async function (opts) {
      const ctx = this.ctx;
      let body;
      if (opts.file) body = fs.readFileSync(opts.file, "utf8");
      else if (opts.default) {
        body =
          '<?xml version="1.0" encoding="UTF-8"?>' +
          '<dbg:settings xmlns:dbg="http://www.sap.com/adt/debugger" ' +
          'systemDebugging="false" createExceptionObject="false" backgroundRFC="false" ' +
          'sharedObjectDebugging="false" showDataAging="false"></dbg:settings>';
      } else {
        throw new Error("Provide --file <xml> or --default");
      }
      const res = await ctx
        .getClient()
        .send("POST", "/sap/bc/adt/debugger?method=setDebuggerSettings", {
          accept: ctx.globalOpts.accept || "application/xml",
          headers: { "Content-Type": "application/xml", "X-sap-adt-profiling": "server-time" },
          body,
        });
      ensureOk(res, "debug settings");
      log.ok("Debugger settings updated.");
      if (res.text) renderResponse(res, ctx.globalOpts);
    });

  const bp = debug.command("breakpoint").description("Manage external breakpoints.");

  bp.command("set")
    .description("POST a line breakpoint.")
    .argument("<objectUri>", "ADT URI, e.g. /sap/bc/adt/programs/programs/zroman/source/main")
    .requiredOption("--line <n>", "1-based source line")
    .option("--program <name>", "ABAP program name (defaults to last segment of objectUri)")
    .option("--include <name>", "include name (defaults to program)")
    .option("--user <user>", "requestUser (defaults to profile user)")
    .option("--mode <m>", "debuggingMode", "user")
    .action(async function (objectUri, opts) {
      const ctx = this.ctx;
      const profile = config.ensureIds(ctx.getProfile());
      const user = opts.user || profile.user || "DEVELOPER";
      const prog = (opts.program || lastSegment(objectUri)).toUpperCase();
      const incl = (opts.include || prog).toUpperCase();
      const id = `KIND=0.SOURCETYPE=ABAP.MAIN_PROGRAM=${prog}.INCLUDE=${incl}.LINE_NR=${opts.line}`;
      const uriWithLine = `${objectUri}#start=${opts.line}`;
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<dbg:breakpoints scope="external" debuggingMode="${opts.mode}" requestUser="${user}" ` +
        `terminalId="${profile.terminalId}" ideId="${profile.ideId}" ` +
        `systemDebugging="false" deactivated="false" xmlns:dbg="http://www.sap.com/adt/debugger">` +
        `<syncScope mode="full"></syncScope>` +
        `<breakpoint kind="line" id="${id}" clientId="adt-cli" skipCount="0" ` +
        `adtcore:uri="${uriWithLine}" xmlns:adtcore="http://www.sap.com/adt/core"></breakpoint>` +
        `</dbg:breakpoints>`;
      const res = await ctx.getClient().send("POST", "/sap/bc/adt/debugger/breakpoints", {
        accept: ctx.globalOpts.accept || "application/xml",
        headers: { "Content-Type": "application/xml" },
        body,
      });
      ensureOk(res, "breakpoint set");
      log.ok(`Breakpoint set at ${prog}/${incl}:${opts.line}`);
      renderResponse(res, ctx.globalOpts);
    });

  bp.command("delete")
    .description("DELETE a breakpoint by its server-side id.")
    .argument("<breakpointId>", "the KIND=0.SOURCETYPE=...LINE_NR=N id (URL-encoded if needed)")
    .option("--mode <m>", "debuggingMode", "user")
    .option("--user <user>", "requestUser (defaults to profile user)")
    .action(async function (id, opts) {
      const ctx = this.ctx;
      const profile = config.ensureIds(ctx.getProfile());
      const user = opts.user || profile.user || "DEVELOPER";
      const url =
        `/sap/bc/adt/debugger/breakpoints/${encodeURIComponent(id)}` +
        `?scope=external&debuggingMode=${encodeURIComponent(opts.mode)}` +
        `&requestUser=${encodeURIComponent(user)}` +
        `&terminalId=${profile.terminalId}` +
        `&ideId=${profile.ideId}`;
      const res = await ctx.getClient().send("DELETE", url, {
        accept: ctx.globalOpts.accept || "application/xml",
      });
      ensureOk(res, "breakpoint delete");
      log.ok(`Breakpoint ${id} deleted.`);
      if (res.text) renderResponse(res, ctx.globalOpts);
    });
}

function lastSegment(uri) {
  const clean = String(uri).split("#")[0].split("?")[0].replace(/\/source\/.*$/, "");
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

module.exports = { register };
