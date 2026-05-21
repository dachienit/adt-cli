"use strict";

// Minimal parser for VS Code REST Client .http files.
// Supports:
//   - "###" request separators (with optional title comment).
//   - "# @name <id>" naming directive (for variable references).
//   - "@var = value" file-level variables (top of file or between requests).
//   - Method + URL line (HTTP/1.1 suffix optional).
//   - Header lines.
//   - Empty line then request body until the next "###" / EOF.
//   - {{var}} interpolation, including {{<name>.response.headers.x-csrf-token}}
//     and {{<name>.response.body.<field>}} when those previous responses
//     are available in the runtime context.
//
// We deliberately keep this conservative: it covers the patterns used in the
// repo's restcalls/*.http files and is safe to extend later.

const fs = require("fs");

function parse(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  const fileVars = {};
  let i = 0;

  // Collect any pre-request file-level vars + skip blanks/comments at top.
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#(?!@name\b)/.test(line)) {
      i++;
      continue;
    }
    if (/^\s*@/.test(line)) {
      const m = line.match(/^\s*@([A-Za-z_][\w-]*)\s*=\s*(.*)$/);
      if (m) fileVars[m[1]] = m[2];
      i++;
      continue;
    }
    break;
  }

  while (i < lines.length) {
    // Skip separators / blank lines between blocks.
    while (i < lines.length && (/^\s*$/.test(lines[i]) || /^\s*###/.test(lines[i]))) {
      i++;
    }
    if (i >= lines.length) break;

    let name = null;
    while (i < lines.length && /^\s*#/.test(lines[i])) {
      const m = lines[i].match(/^\s*#\s*@name\s+([\w.-]+)/);
      if (m) name = m[1];
      i++;
    }
    while (i < lines.length && /^\s*$/.test(lines[i])) i++;

    if (i >= lines.length) break;

    // Variables can also appear *between* requests.
    if (/^\s*@/.test(lines[i])) {
      const m = lines[i].match(/^\s*@([A-Za-z_][\w-]*)\s*=\s*(.*)$/);
      if (m) fileVars[m[1]] = m[2];
      i++;
      continue;
    }

    const requestLine = lines[i++];
    const reqMatch = requestLine.match(/^\s*([A-Z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/);
    if (!reqMatch) {
      // Not a request line; treat as another comment/var and continue.
      continue;
    }
    const method = reqMatch[1];
    const url = reqMatch[2];

    const headers = {};
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*###/.test(lines[i])) {
      const hl = lines[i++];
      const idx = hl.indexOf(":");
      if (idx > 0) {
        const k = hl.slice(0, idx).trim();
        const v = hl.slice(idx + 1).trim();
        headers[k] = v;
      }
    }
    // Skip the blank line that separates headers from body.
    if (i < lines.length && lines[i].trim() === "") i++;

    const bodyLines = [];
    while (i < lines.length && !/^\s*###/.test(lines[i])) {
      bodyLines.push(lines[i++]);
    }
    // Trim trailing blank lines from body.
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
    const body = bodyLines.join("\n");

    blocks.push({ name, method, url, headers, body });
  }

  return { fileVars, blocks };
}

function loadFile(filePath) {
  return parse(fs.readFileSync(filePath, "utf8"));
}

// Interpolate {{var}} and {{name.response.headers.x-foo}} / {{name.response.body.field}}.
function interpolate(text, vars, responses) {
  if (!text) return text;
  return String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, expr) => {
    const v = resolveExpr(expr, vars, responses);
    return v == null ? "" : String(v);
  });
}

function resolveExpr(expr, vars, responses) {
  // Direct variable.
  if (Object.prototype.hasOwnProperty.call(vars, expr)) {
    // Allow recursive {{var}} resolution one level deep.
    return interpolate(vars[expr], vars, responses);
  }
  // <name>.response.(headers|body).<field...>
  const m = expr.match(/^([\w.-]+)\.response\.(headers|body)\.(.+)$/);
  if (m) {
    const respName = m[1];
    const part = m[2];
    const field = m[3];
    const r = responses[respName];
    if (!r) return "";
    if (part === "headers") {
      const h = r.headers || {};
      const lower = field.toLowerCase();
      for (const k of Object.keys(h)) {
        if (k.toLowerCase() === lower) return h[k];
      }
      return "";
    }
    if (part === "body") {
      // Best effort: navigate the JSON body, else fall back to text.
      const segments = field.split(".");
      let cur = r.bodyJson != null ? r.bodyJson : r.body;
      for (const s of segments) {
        if (cur == null) return "";
        cur = cur[s];
      }
      return cur;
    }
  }
  return "";
}

module.exports = { parse, loadFile, interpolate };
