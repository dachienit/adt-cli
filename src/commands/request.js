"use strict";

// `adt http request` (alias `req`) - generic HTTP escape hatch.

const fs = require("fs");
const log = require("../logger");
const { renderResponse, ensureOk } = require("../output");

function register(http) {
  http
    .command("request")
    .alias("req")
    .description(
      "Generic ADT HTTP request. Auth, cookies, and CSRF are handled for you.\n" +
        "Path can be relative (/sap/bc/adt/...) or an absolute URL within the same host."
    )
    .argument("<method>", "HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD)")
    .argument("<path>", "request path or absolute URL")
    .option("-H, --header <header...>", "extra header(s), e.g. -H 'If-Match: 123'")
    .option("--content-type <mime>", "Content-Type for the request body")
    .option("--data <text>", "string body")
    .option("--data-file <path>", "read body from a file (binary-safe)")
    .option("--no-fail", "don't exit non-zero on HTTP errors")
    .action(async function (method, path, opts) {
      const ctx = this.ctx;
      const headers = {};
      if (opts.contentType) headers["Content-Type"] = opts.contentType;
      for (const h of opts.header || []) {
        const idx = h.indexOf(":");
        if (idx <= 0) {
          log.warn(`Ignoring malformed header: ${h}`);
          continue;
        }
        headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      }
      let body;
      if (opts.dataFile) body = fs.readFileSync(opts.dataFile);
      else if (opts.data != null) body = opts.data;

      const res = await ctx.getClient().send(method, path, {
        accept: ctx.globalOpts.accept || headers.Accept || "application/*",
        headers,
        body,
      });
      if (opts.fail !== false) ensureOk(res, `${method} ${path}`);
      renderResponse(res, ctx.globalOpts);
    });
}

module.exports = { register };
