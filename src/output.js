"use strict";

// Common rendering for command results.
// - --raw  : print res.text/raw
// - --json : print parsed body as JSON (or string fallback)
// - default: parsed body as JSON if it parsed, else raw text

const fs = require("fs");
const log = require("./logger");

function renderResponse(res, globalOpts = {}) {
  const isXml = (res.contentType || "").toLowerCase().includes("xml");
  let payload;

  if (globalOpts.raw) {
    payload = res.text;
  } else if (globalOpts.json || (typeof res.body === "object" && res.body != null)) {
    payload = JSON.stringify(res.body, null, 2);
  } else {
    payload = typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2);
  }

  if (globalOpts.output) {
    fs.writeFileSync(globalOpts.output, payload);
    log.ok(`Wrote ${Buffer.byteLength(payload)} bytes to ${globalOpts.output}`);
    return;
  }

  process.stdout.write(payload);
  if (!payload.endsWith("\n")) process.stdout.write("\n");

  if (isXml && !globalOpts.raw && !globalOpts.json && typeof res.body === "object") {
    // Already printed as JSON above by default - no-op.
  }
}

function renderJson(value, globalOpts = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (globalOpts.output) {
    fs.writeFileSync(globalOpts.output, text);
    log.ok(`Wrote ${Buffer.byteLength(text)} bytes to ${globalOpts.output}`);
    return;
  }
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
}

function ensureOk(res, what) {
  if (!res.ok) {
    const err = new Error(`${what} failed: HTTP ${res.status} ${res.statusText}`);
    err.response = res;
    throw err;
  }
}

module.exports = { renderResponse, renderJson, ensureOk };
