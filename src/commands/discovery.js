"use strict";

// `adt system <verb>` - server-level discovery and metadata.
// Mirrors restcalls/hana1909.http + the Atom-feed reads in other .http files.
//
//   adt system discovery        -> /sap/bc/adt/discovery
//   adt system core-discovery   -> /sap/bc/adt/core/discovery   (also fetches CSRF)
//   adt system graph            -> /sap/bc/adt/compatibility/graph
//   adt system feeds            -> /sap/bc/adt/feeds
//   adt system object-types     -> /sap/bc/adt/repository/informationsystem/objecttypes
//   adt system type-structure   -> POST /sap/bc/adt/repository/typestructure
//   adt system users            -> /sap/bc/adt/system/users
//   adt system dumps            -> /sap/bc/adt/runtime/dumps
//
// (The per-object property reader moved to `adt object properties`.)

const log = require("../logger");
const { renderResponse, ensureOk } = require("../output");

function register(system) {
  system
    .command("discovery")
    .description("GET /sap/bc/adt/discovery - root service document.")
    .action(async function () {
      const ctx = this.ctx;
      const res = await ctx.getClient().send("GET", "/sap/bc/adt/discovery", {
        accept: ctx.globalOpts.accept || "application/atomsvc+xml",
      });
      ensureOk(res, "discovery");
      renderResponse(res, ctx.globalOpts);
    });

  system
    .command("core-discovery")
    .description("GET /sap/bc/adt/core/discovery and prime the CSRF token.")
    .action(async function () {
      const ctx = this.ctx;
      const client = ctx.getClient();
      const res = await client.send("GET", "/sap/bc/adt/core/discovery", {
        accept: ctx.globalOpts.accept || "application/atomsvc+xml",
        headers: { "x-csrf-token": "fetch" },
      });
      ensureOk(res, "core-discovery");
      const csrf = res.headers["x-csrf-token"];
      if (csrf) log.info(`Cached CSRF token (${csrf.length} chars).`);
      renderResponse(res, ctx.globalOpts);
    });

  system
    .command("graph")
    .description("GET /sap/bc/adt/compatibility/graph - server compatibility info.")
    .action(async function () {
      const ctx = this.ctx;
      const res = await ctx.getClient().send("GET", "/sap/bc/adt/compatibility/graph", {
        accept: ctx.globalOpts.accept || "application/xml",
      });
      ensureOk(res, "graph");
      renderResponse(res, ctx.globalOpts);
    });

  system
    .command("feeds")
    .description("GET /sap/bc/adt/feeds - atom feed of available feeds.")
    .action(async function () {
      const ctx = this.ctx;
      const res = await ctx.getClient().send("GET", "/sap/bc/adt/feeds", {
        accept: ctx.globalOpts.accept || "application/atom+xml;type=feed",
      });
      ensureOk(res, "feeds");
      renderResponse(res, ctx.globalOpts);
    });

  system
    .command("object-types")
    .description("GET /sap/bc/adt/repository/informationsystem/objecttypes")
    .option("--name <name>", "name pattern (default '*')", "*")
    .option("--max <n>", "maxItemCount", "999")
    .option("--data <data>", "data flag (e.g. usedByProvider)", "usedByProvider")
    .action(async function (opts) {
      const ctx = this.ctx;
      const url = `/sap/bc/adt/repository/informationsystem/objecttypes?maxItemCount=${encodeURIComponent(
        opts.max
      )}&name=${encodeURIComponent(opts.name)}&data=${encodeURIComponent(opts.data)}`;
      const res = await ctx.getClient().send("GET", url, {
        accept: ctx.globalOpts.accept || "application/xml",
      });
      ensureOk(res, "object-types");
      renderResponse(res, ctx.globalOpts);
    });

  system
    .command("type-structure")
    .description("POST /sap/bc/adt/repository/typestructure")
    .action(async function () {
      const ctx = this.ctx;
      const res = await ctx.getClient().send("POST", "/sap/bc/adt/repository/typestructure", {
        accept:
          ctx.globalOpts.accept ||
          "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.RepositoryTypeList",
      });
      ensureOk(res, "type-structure");
      renderResponse(res, ctx.globalOpts);
    });

  system
    .command("users")
    .description("GET /sap/bc/adt/system/users - list of system users.")
    .action(async function () {
      const ctx = this.ctx;
      const res = await ctx.getClient().send("GET", "/sap/bc/adt/system/users", {
        accept: ctx.globalOpts.accept || "application/atom+xml;type=feed",
      });
      ensureOk(res, "users");
      renderResponse(res, ctx.globalOpts);
    });

  system
    .command("dumps")
    .description("Query short dumps from /sap/bc/adt/runtime/dumps.")
    .option("--user <user>", "filter dumps by responsible user")
    .option("--top <n>", "max items", "50")
    .action(async function (opts) {
      const ctx = this.ctx;
      const params = new URLSearchParams();
      if (opts.user) {
        params.set("$query", `and( equals( responsible, ${opts.user} ) )`);
      }
      params.set("$inlinecount", "allpages");
      params.set("$top", String(opts.top));
      const res = await ctx.getClient().send("GET", `/sap/bc/adt/runtime/dumps?${params.toString()}`, {
        accept: ctx.globalOpts.accept || "application/atom+xml;type=feed",
      });
      ensureOk(res, "dumps");
      renderResponse(res, ctx.globalOpts);
    });

}

module.exports = { register };
