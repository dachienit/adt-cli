"use strict";

// `adt data <verb>` - data preview commands (mirrors restcalls/cloud.http).
//   adt data sql <query>        -> POST /sap/bc/adt/datapreview/freestyle
//   adt data ddic <entity>      -> POST /sap/bc/adt/datapreview/ddic
//   adt data ddic-meta <entity> -> GET  /sap/bc/adt/datapreview/ddic/<entity>/metadata
//
// SQL queries / SELECT bodies are sent as text/plain. The server returns XML
// describing rows; we parse it into JSON by default.

const log = require("../logger");
const { renderResponse, ensureOk } = require("../output");

function register(data) {
  data
    .command("sql")
    .description("Run a free-style ABAP SQL query and dump the table preview.")
    .argument("<query...>", "SQL statement (quoting rules apply)")
    .option("--rows <n>", "max rows to return", "100")
    .action(async function (queryParts, opts) {
      const ctx = this.ctx;
      const query = queryParts.join(" ");
      log.step(`Executing SQL (rows=${opts.rows}): ${truncate(query, 120)}`);
      const url = `/sap/bc/adt/datapreview/freestyle?rowNumber=${encodeURIComponent(opts.rows)}`;
      const res = await ctx.getClient().send("POST", url, {
        accept:
          ctx.globalOpts.accept ||
          "application/xml, application/vnd.sap.adt.datapreview.table.v1+xml",
        headers: { "Content-Type": "text/plain" },
        body: query,
      });
      ensureOk(res, "sql");
      renderResponse(res, ctx.globalOpts);
    });

  data
    .command("ddic")
    .description("Run a data preview against a DDIC entity (table or CDS view).")
    .argument("<entity>", "DDIC name, e.g. /DMO/TRAVEL")
    .option("--rows <n>", "max rows to return", "100")
    .option(
      "--where <sql>",
      "optional WHERE clause - sent as the request body, like the http file example"
    )
    .action(async function (entity, opts) {
      const ctx = this.ctx;
      const url =
        `/sap/bc/adt/datapreview/ddic?rowNumber=${encodeURIComponent(opts.rows)}` +
        `&ddicEntityName=${encodeURIComponent(entity)}`;
      log.step(`DDIC preview ${entity} (rows=${opts.rows})`);
      const res = await ctx.getClient().send("POST", url, {
        accept:
          ctx.globalOpts.accept ||
          "application/xml, application/vnd.sap.adt.datapreview.table.v1+xml",
        headers: { "Content-Type": "text/plain" },
        body: opts.where || "",
      });
      ensureOk(res, "ddic");
      renderResponse(res, ctx.globalOpts);
    });

  data
    .command("ddic-meta")
    .description("Read column metadata for a DDIC entity.")
    .argument("<entity>", "DDIC name, e.g. /DMO/TRAVEL")
    .action(async function (entity) {
      const ctx = this.ctx;
      const url = `/sap/bc/adt/datapreview/ddic/${encodeURIComponent(entity)}/metadata`;
      const res = await ctx.getClient().send("GET", url, {
        accept: ctx.globalOpts.accept || "application/vnd.sap.adt.datapreview.table.v1+xml",
      });
      ensureOk(res, "ddic-meta");
      renderResponse(res, ctx.globalOpts);
    });
}

function truncate(s, n) {
  s = String(s || "");
  return s.length <= n ? s : s.slice(0, n) + "...";
}

module.exports = { register };
