"use strict";

// `adt http list` and `adt http run` - parse / execute VS Code REST Client .http files.
//
// Useful for agents: drop a .http file (like the ones in restcalls/) and run
// it as a single command, with shared variables and CSRF/cookie state.
// File-level vars can be supplied with --var k=v (repeatable).
// The active profile contributes default values for {{baseUrl}} / {{url}} /
// {{user}} / {{password}} / {{loginUrl}} / {{clientId}} / {{clientSecret}} /
// {{refreshToken}} / {{client}} when the file does not define them.

const log = require("../logger");
const { renderResponse } = require("../output");
const httpFile = require("../httpFile");
const xml = require("../xml");

function register(http) {
  http
    .command("run")
    .description("Execute requests in a .http file end-to-end.")
    .argument("<file>", "path to a .http file")
    .option("--var <kv...>", "set / override file variables, e.g. --var rows=5")
    .option("--only <name>", "execute just one named request (matches '# @name <name>')")
    .option("--continue-on-error", "keep going after a failed request")
    .option("--print-each", "print each response body, not just the last one")
    .action(async function (file, opts) {
      const ctx = this.ctx;
      const profile = ctx.getProfile();
      const client = ctx.getClient();
      const parsed = httpFile.loadFile(file);

      const vars = {
        url: profile.url,
        baseUrl: profile.url,
        user: profile.user || "",
        password: profile.password || "",
        client: profile.client || "",
        loginUrl: profile.loginUrl || "",
        clientId: profile.clientId || "",
        clientSecret: profile.clientSecret || "",
        refreshToken: profile.refreshToken || "",
        ...parsed.fileVars,
      };
      for (const kv of opts.var || []) {
        const idx = kv.indexOf("=");
        if (idx <= 0) {
          log.warn(`Ignoring malformed --var "${kv}" (expected key=value).`);
          continue;
        }
        vars[kv.slice(0, idx)] = kv.slice(idx + 1);
      }

      const responses = {};
      let last = null;
      let executed = 0;

      for (let idx = 0; idx < parsed.blocks.length; idx++) {
        const blk = parsed.blocks[idx];
        if (opts.only && blk.name !== opts.only) continue;

        const url = httpFile.interpolate(blk.url, vars, responses);
        const headers = {};
        for (const [k, v] of Object.entries(blk.headers)) {
          headers[k] = httpFile.interpolate(v, vars, responses);
        }
        // VS Code REST Client encodes "Authorization: Basic user:password" automatically.
        if (headers.Authorization && /^Basic\s+\S+:\S+/i.test(headers.Authorization)) {
          const tok = headers.Authorization.replace(/^Basic\s+/i, "");
          headers.Authorization = "Basic " + Buffer.from(tok, "utf8").toString("base64");
        }
        const body = blk.body ? httpFile.interpolate(blk.body, vars, responses) : undefined;

        const label = blk.name ? `${blk.name}` : `#${idx + 1}`;
        log.step(`[${label}] ${blk.method} ${url}`);

        let res;
        try {
          res = await client.send(blk.method, url, {
            accept: headers.Accept,
            headers,
            body,
          });
        } catch (e) {
          log.err(`[${label}] network error: ${e.message}`);
          if (!opts.continueOnError) throw e;
          continue;
        }

        responses[label] = {
          status: res.status,
          headers: res.headers,
          body: res.text,
          bodyJson: tryJson(res),
        };
        last = res;
        executed++;

        if (!res.ok) {
          log.err(`[${label}] HTTP ${res.status} ${res.statusText}`);
          if (!opts.continueOnError) {
            renderResponse(res, ctx.globalOpts);
            process.exitCode = 1;
            return;
          }
        }
        if (opts.printEach) {
          log.info(`---- ${label} body ----`);
          renderResponse(res, ctx.globalOpts);
        }
      }

      log.ok(`Executed ${executed} request(s).`);
      if (last && !opts.printEach) {
        renderResponse(last, ctx.globalOpts);
      }
    });

  http
    .command("list")
    .description("List the named requests inside a .http file (without running them).")
    .argument("<file>", "path to a .http file")
    .action((file) => {
      const parsed = httpFile.loadFile(file);
      const items = parsed.blocks.map((b, i) => ({
        index: i + 1,
        name: b.name,
        method: b.method,
        url: b.url,
        contentLength: b.body ? Buffer.byteLength(b.body) : 0,
      }));
      process.stdout.write(JSON.stringify({ vars: parsed.fileVars, blocks: items }, null, 2) + "\n");
    });
}

function tryJson(res) {
  if (typeof res.body === "object" && res.body !== null) return res.body;
  if ((res.contentType || "").includes("json")) {
    try {
      return JSON.parse(res.text);
    } catch {
      return null;
    }
  }
  if (xml.looksLikeXml(res.text)) {
    try {
      return xml.parse(res.text);
    } catch {
      return null;
    }
  }
  return null;
}

module.exports = { register };
