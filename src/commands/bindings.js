"use strict";

// `adt service <verb>` - business service bindings.
// Mirrors the last two requests in restcalls/cloud.http.
//
//   adt service binding <name>
//   adt service odata-v2 <binding> --service S --service-def D [--version V]

const { renderResponse, ensureOk } = require("../output");

function register(service) {
  service
    .command("binding")
    .description("GET /sap/bc/adt/businessservices/bindings/<name>")
    .argument("<name>", "binding name, e.g. ymu_rap_ui_travel_o2")
    .action(async function (name) {
      const ctx = this.ctx;
      const res = await ctx
        .getClient()
        .send("GET", `/sap/bc/adt/businessservices/bindings/${encodeURIComponent(name)}`, {
          accept: ctx.globalOpts.accept || "application/*",
        });
      ensureOk(res, "service binding");
      renderResponse(res, ctx.globalOpts);
    });

  service
    .command("odata-v2")
    .description("Read OData v2 service details for a binding.")
    .argument("<binding>", "binding name (uppercase)")
    .requiredOption("--service <name>", "service name (servicename)")
    .option("--version <ver>", "service version", "0001")
    .requiredOption("--service-def <def>", "service definition (srvdname)")
    .action(async function (binding, opts) {
      const ctx = this.ctx;
      const url =
        `/sap/bc/adt/businessservices/odatav2/${encodeURIComponent(binding)}` +
        `?servicename=${encodeURIComponent(opts.service)}` +
        `&serviceversion=${encodeURIComponent(opts.version)}` +
        `&srvdname=${encodeURIComponent(opts.serviceDef)}`;
      const res = await ctx.getClient().send("GET", url, {
        accept:
          ctx.globalOpts.accept ||
          "application/vnd.sap.adt.businessservices.odatav2.v1+xml, application/vnd.sap.adt.businessservices.odatav2.v2+xml",
      });
      ensureOk(res, "service odata-v2");
      renderResponse(res, ctx.globalOpts);
    });
}

module.exports = { register };
