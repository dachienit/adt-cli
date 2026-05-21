"use strict";

// `adt cts <verb>` - SAP Change & Transport System.
// Mirrors the cts/transportrequests calls in restcalls/hana1909.http.

const fs = require("fs");
const log = require("../logger");
const { renderResponse, ensureOk } = require("../output");

function register(cts) {
  cts
    .command("config-metadata")
    .description("GET /sap/bc/adt/cts/transportrequests/searchconfiguration/metadata")
    .action(async function () {
      const ctx = this.ctx;
      const res = await ctx
        .getClient()
        .send("GET", "/sap/bc/adt/cts/transportrequests/searchconfiguration/metadata", {
          accept: ctx.globalOpts.accept || "application/*",
        });
      ensureOk(res, "config-metadata");
      renderResponse(res, ctx.globalOpts);
    });

  cts
    .command("configurations")
    .description("List saved transport search configurations.")
    .action(async function () {
      const ctx = this.ctx;
      const res = await ctx
        .getClient()
        .send("GET", "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations", {
          accept: ctx.globalOpts.accept || "application/*",
        });
      ensureOk(res, "configurations");
      renderResponse(res, ctx.globalOpts);
    });

  cts
    .command("configuration")
    .description("Read a single transport search configuration by id.")
    .argument("<configId>", "configuration id, e.g. 0242AC1100021EEB9CB819072C585EAB")
    .action(async function (configId) {
      const ctx = this.ctx;
      const res = await ctx
        .getClient()
        .send(
          "GET",
          `/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/${encodeURIComponent(configId)}`,
          { accept: ctx.globalOpts.accept || "application/vnd.sap.adt.configuration.v1+xml" }
        );
      ensureOk(res, "configuration");
      renderResponse(res, ctx.globalOpts);
    });

  cts
    .command("save-configuration")
    .description("Update a transport search configuration (PUT, requires If-Match etag).")
    .argument("<configId>", "configuration id")
    .requiredOption("--etag <etag>", "If-Match value, taken from the previous read")
    .requiredOption("--file <file>", "XML body file (configuration:configuration document)")
    .action(async function (configId, opts) {
      const ctx = this.ctx;
      const body = fs.readFileSync(opts.file, "utf8");
      const res = await ctx.getClient().send(
        "PUT",
        `/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/${encodeURIComponent(configId)}`,
        {
          accept: ctx.globalOpts.accept || "application/vnd.sap.adt.configuration.v1+xml",
          headers: {
            "Content-Type": "application/vnd.sap.adt.configuration.v1+xml",
            "If-Match": opts.etag,
          },
          body,
        }
      );
      ensureOk(res, "save-configuration");
      log.ok("Configuration updated.");
      renderResponse(res, ctx.globalOpts);
    });

  cts
    .command("list")
    .description("List transports for a given search configuration.")
    .requiredOption("--config <configId>", "configuration id used as configUri")
    .option("--no-targets", "omit targets=true")
    .action(async function (opts) {
      const ctx = this.ctx;
      const params = new URLSearchParams();
      if (opts.targets !== false) params.set("targets", "true");
      params.set(
        "configUri",
        `/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations/${opts.config}`
      );
      const res = await ctx
        .getClient()
        .send("GET", `/sap/bc/adt/cts/transportrequests?${params.toString()}`, {
          accept:
            ctx.globalOpts.accept ||
            "application/vnd.sap.adt.transportorganizer.v1+xml, application/vnd.sap.adt.transportorganizertree.v1+xml",
        });
      ensureOk(res, "list");
      renderResponse(res, ctx.globalOpts);
    });
}

module.exports = { register };
