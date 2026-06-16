"use strict";

// Write `docs/<id>.md` files for object and package long texts.
// We strip basic HTML tags (long-text endpoints often return text/html with a
// little SAP-specific markup) but preserve text content as-is.

const fs = require("fs");
const path = require("path");

function writeDocs(packageDir, docs) {
  if (!docs || docs.length === 0) return [];
  const dir = path.join(packageDir, "docs");
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const d of docs) {
    if (!d || !d.content) continue;
    const md = _renderMd(d);
    const filePath = path.join(dir, `${_safe(d.id)}.md`);
    fs.writeFileSync(filePath, md, "utf8");
    written.push(filePath);
  }
  return written;
}

function _renderMd(doc) {
  const body = _stripHtml(doc.content);
  return [
    `# ${doc.title || doc.id}`,
    "",
    `_Source: ${doc.source || "ADT longtexts"}_`,
    "",
    body,
    "",
  ].join("\n");
}

function _stripHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function _safe(id) {
  return String(id).replace(/[\\/:*?"<>|]/g, "_");
}

module.exports = { writeDocs };
