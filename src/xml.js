"use strict";

// XML helpers built on fast-xml-parser. We keep the API small and predictable
// so command modules can pass parsed bodies straight to the user as JSON.
//
// We deliberately use only `XMLParser` from fast-xml-parser; `XMLBuilder` was
// deprecated in v5 in favour of the standalone `fast-xml-builder` package and
// nothing in the CLI builds XML through fast-xml-parser anyway - every body
// is constructed via template strings in `createables.js` / `objLib.js`.

const { XMLParser } = require("fast-xml-parser");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: false,
  trimValues: true,
  parseTagValue: true,
  parseAttributeValue: true,
});

function parse(xml) {
  if (xml == null || xml === "") return null;
  if (typeof xml !== "string") xml = String(xml);
  return parser.parse(stripBom(xml));
}

function looksLikeXml(text) {
  if (!text) return false;
  const trimmed = stripBom(String(text)).trim();
  return trimmed.startsWith("<?xml") || /^<[A-Za-z_:]/.test(trimmed);
}

// Strip a leading UTF-8 BOM (\uFEFF) if present.
// PowerShell 5.x's `Out-File -Encoding utf8` writes a BOM by default and
// SAP's ABAP parser rejects it (mistakenly reports REPORT not expected).
function stripBom(s) {
  if (typeof s !== "string") return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

module.exports = { parse, looksLikeXml, stripBom };
