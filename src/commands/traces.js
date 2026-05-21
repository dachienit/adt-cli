"use strict";

// `adt trace <verb>` - ABAP runtime traces.
// Mirrors restcalls/traces.http.

const fs = require("fs");
const log = require("../logger");
const { renderResponse, ensureOk } = require("../output");

function register(trace) {
  trace
    .command("list")
    .description("GET /sap/bc/adt/runtime/traces/abaptraces")
    .option("--user <user>", "filter by user")
    .action(async function (opts) {
      const ctx = this.ctx;
      const params = new URLSearchParams();
      if (opts.user) params.set("user", opts.user);
      const res = await ctx
        .getClient()
        .send("GET", `/sap/bc/adt/runtime/traces/abaptraces?${params.toString()}`, {
          accept: ctx.globalOpts.accept || "application/atom+xml;type=feed",
          headers: { "x-csrf-token": "fetch" },
        });
      ensureOk(res, "trace list");
      renderResponse(res, ctx.globalOpts);
    });

  trace
    .command("requests")
    .description("GET /sap/bc/adt/runtime/traces/abaptraces/requests")
    .option("--user <user>", "filter by user")
    .action(async function (opts) {
      const ctx = this.ctx;
      const params = new URLSearchParams();
      if (opts.user) params.set("user", opts.user);
      const res = await ctx
        .getClient()
        .send("GET", `/sap/bc/adt/runtime/traces/abaptraces/requests?${params.toString()}`, {
          accept: ctx.globalOpts.accept || "application/atom+xml;type=feed",
          headers: { "x-csrf-token": "fetch" },
        });
      ensureOk(res, "trace requests");
      renderResponse(res, ctx.globalOpts);
    });

  trace
    .command("hitlist")
    .description("GET hitlist for a trace.")
    .argument("<traceId>", "trace identifier, e.g. bti1033_acd_00,AT000020.DAT")
    .option("--system-events", "include system events")
    .action(async function (traceId, opts) {
      const ctx = this.ctx;
      const url =
        `/sap/bc/adt/runtime/traces/abaptraces/${encodeTrace(traceId)}/hitlist` +
        `?withSystemEvents=${!!opts.systemEvents}`;
      const res = await ctx.getClient().send("GET", url, {
        accept: ctx.globalOpts.accept || "application/xml",
      });
      ensureOk(res, "trace hitlist");
      renderResponse(res, ctx.globalOpts);
    });

  trace
    .command("db")
    .description("GET database accesses for a trace.")
    .argument("<traceId>", "trace identifier")
    .option("--system-events", "include system events", true)
    .action(async function (traceId, opts) {
      const ctx = this.ctx;
      const url =
        `/sap/bc/adt/runtime/traces/abaptraces/${encodeTrace(traceId)}/dbAccesses` +
        `?withSystemEvents=${!!opts.systemEvents}`;
      const res = await ctx.getClient().send("GET", url, {
        accept:
          ctx.globalOpts.accept ||
          "application/vnd.sap.adt.runtime.traces.abaptraces.dbaccesses+xml, application/xml",
      });
      ensureOk(res, "trace db");
      renderResponse(res, ctx.globalOpts);
    });

  trace
    .command("statements")
    .description("GET aggregated call tree (statements) for a trace.")
    .argument("<traceId>", "trace identifier")
    .option("--id <n>", "drilldown id")
    .option("--with-details", "include details")
    .option("--auto <pct>", "autoDrillDownThreshold", "80")
    .option("--system-events", "include system events")
    .action(async function (traceId, opts) {
      const ctx = this.ctx;
      const params = new URLSearchParams();
      if (opts.id != null) params.set("id", opts.id);
      params.set("withDetails", String(!!opts.withDetails));
      if (opts.id != null) params.set("autoDrillDownThreshold", String(opts.auto));
      params.set("withSystemEvents", String(!!opts.systemEvents));
      const url =
        `/sap/bc/adt/runtime/traces/abaptraces/${encodeTrace(traceId)}/statements?${params.toString()}`;
      const res = await ctx.getClient().send("GET", url, {
        accept:
          ctx.globalOpts.accept ||
          "application/vnd.sap.adt.runtime.traces.abaptraces.aggcalltree+xml, application/xml",
      });
      ensureOk(res, "trace statements");
      renderResponse(res, ctx.globalOpts);
    });

  trace
    .command("parameters")
    .description("POST trace parameters XML (creates a parameter set; returns its id).")
    .requiredOption("--file <xml>", "path to parameters XML body")
    .action(async function (opts) {
      const ctx = this.ctx;
      const body = fs.readFileSync(opts.file, "utf8");
      const res = await ctx
        .getClient()
        .send("POST", "/sap/bc/adt/runtime/traces/abaptraces/parameters", {
          accept: ctx.globalOpts.accept || "application/xml",
          headers: { "Content-Type": "application/xml" },
          body,
        });
      ensureOk(res, "trace parameters");
      renderResponse(res, ctx.globalOpts);
    });

  trace
    .command("create")
    .description("Create a new trace configuration (POST .../traces/abaptraces/requests).")
    .requiredOption("--description <text>", "description")
    .requiredOption("--user <user>", "trace user")
    .requiredOption("--client <client>", "trace client (e.g. 100)")
    .requiredOption("--process-type <uri>", "processType, e.g. .../processtypes/http")
    .requiredOption("--object-type <uri>", "objectType, e.g. .../objecttypes/url")
    .requiredOption("--expires <iso>", "expiry, e.g. 2026-12-31T00:00:00Z")
    .option("--max-exec <n>", "maximalExecutions", "3")
    .requiredOption("--parameters-id <uri>", "parametersId from a previous POST .../parameters")
    .option("--server <pattern>", "server pattern", "*")
    .action(async function (opts) {
      const ctx = this.ctx;
      const params = new URLSearchParams();
      params.set("server", opts.server);
      params.set("description", opts.description);
      params.set("traceUser", opts.user);
      params.set("traceClient", opts.client);
      params.set("processType", opts.processType);
      params.set("objectType", opts.objectType);
      params.set("expires", opts.expires);
      params.set("maximalExecutions", opts.maxExec);
      params.set("parametersId", opts.parametersId);
      const res = await ctx
        .getClient()
        .send("POST", `/sap/bc/adt/runtime/traces/abaptraces/requests?${params.toString()}`, {
          accept: ctx.globalOpts.accept || "application/atom+xml;type=feed",
        });
      ensureOk(res, "trace create");
      log.ok("Trace configuration created.");
      renderResponse(res, ctx.globalOpts);
    });

  trace
    .command("delete")
    .description("Delete a trace configuration.")
    .argument("<traceConfigId>", "id, e.g. bti1033_acd_00,11,20231106082846")
    .action(async function (id) {
      const ctx = this.ctx;
      const url = `/sap/bc/adt/runtime/traces/abaptraces/requests/${encodeTrace(id)}`;
      const res = await ctx.getClient().send("DELETE", url, {
        accept: ctx.globalOpts.accept || "application/xml",
      });
      ensureOk(res, "trace delete");
      log.ok(`Deleted trace configuration ${id}`);
      if (res.text) renderResponse(res, ctx.globalOpts);
    });
}

// SAP encodes traceIds with %2C between segments; we accept literal commas.
function encodeTrace(id) {
  return id.split(",").map(encodeURIComponent).join("%2c");
}

module.exports = { register };
