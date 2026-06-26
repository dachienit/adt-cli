"use strict";

// Project DDIC structure XML payloads into compact JSON descriptors suited
// for LLM consumption. The XML shape varies wildly between TABL / DTEL /
// DOMA / STRU / VIEW so we handle each type explicitly. Anything we cannot
// resolve falls back to a minimal `{ name, typeId, raw: ... }` record so
// the downstream consumer at least sees the object exists.

const log = require("../../logger");
const _shapeLogged = new Set();

function _logShapeOnce(typeId, structureXml, fieldsMeta) {
  if (_shapeLogged.has(typeId)) return;
  _shapeLogged.add(typeId);
  try {
    const structureKeys = structureXml && typeof structureXml === "object"
      ? Object.keys(structureXml).slice(0, 10).join(", ")
      : "(not-object)";
    const fieldsMetaKeys = fieldsMeta && typeof fieldsMeta === "object"
      ? Object.keys(fieldsMeta).slice(0, 10).join(", ")
      : "(missing)";
    log.info(`ddicSkeleton: first ${typeId} structureXml top-keys=[${structureKeys}] fieldsMeta top-keys=[${fieldsMetaKeys}]`);
    _dumpShape("structureXml", structureXml, 2);
    if (fieldsMeta && typeof fieldsMeta === "object") {
      _dumpShape("fieldsMeta", fieldsMeta, 2);
    }
  } catch (e) {
    log.debug(`ddicSkeleton: shape probe failed: ${e.message}`);
  }
}

function _dumpShape(label, node, depth, prefix = "  ") {
  if (!node || typeof node !== "object" || depth < 0) return;
  for (const k of Object.keys(node).slice(0, 8)) {
    const v = node[k];
    if (k.startsWith("@_")) {
      log.info(`ddicSkeleton: ${prefix}${label}.${k} = ${JSON.stringify(v).slice(0, 80)}`);
    } else if (Array.isArray(v)) {
      log.info(`ddicSkeleton: ${prefix}${label}.${k} = Array[${v.length}]`);
      if (v.length > 0 && depth > 0) _dumpShape(`${label}.${k}[0]`, v[0], depth - 1, prefix + "  ");
    } else if (v && typeof v === "object") {
      const subKeys = Object.keys(v).slice(0, 8).join(", ");
      log.info(`ddicSkeleton: ${prefix}${label}.${k} -> {${subKeys}}`);
      if (depth > 0) _dumpShape(`${label}.${k}`, v, depth - 1, prefix + "  ");
    } else {
      log.info(`ddicSkeleton: ${prefix}${label}.${k} = ${JSON.stringify(v).slice(0, 60)}`);
    }
  }
}

function buildDdicEntry(fetchedRecord) {
  if (!fetchedRecord) return null;
  if (fetchedRecord.error) {
    return {
      typeId: fetchedRecord.typeId,
      name: fetchedRecord.name,
      error: fetchedRecord.error,
    };
  }

  const { typeId, name, description, structureXml, fieldsMeta } = fetchedRecord;
  _logShapeOnce(typeId, structureXml, fieldsMeta);
  let built;
  if (typeId.startsWith("TABL")) built = _buildTable(typeId, name, structureXml, fieldsMeta);
  else if (typeId.startsWith("STRU")) built = _buildTable(typeId, name, structureXml, fieldsMeta);
  else if (typeId.startsWith("VIEW")) built = _buildTable(typeId, name, structureXml, fieldsMeta);
  else if (typeId.startsWith("DTEL")) built = _buildDataElement(typeId, name, structureXml);
  else if (typeId.startsWith("DOMA")) built = _buildDomain(typeId, name, structureXml);
  else built = { typeId, name, raw: _attrs(structureXml) };
  if (built && !built.description && description) built.description = description;
  return built;
}

function _buildTable(typeId, name, structureXml, fieldsMeta) {
  const root = (structureXml && structureXml["blue:blueSource"]) || {};
  const rootAttrs = _attrs(root);
  const fields = _extractFieldsFromDataPreview(fieldsMeta);
  const keyFields = fields.filter((f) => f.isKey).map((f) => f.name);
  return {
    typeId,
    name,
    type: typeId.split("/")[0],
    description: rootAttrs["adtcore:description"] || null,
    sourceUri: rootAttrs["abapsource:sourceUri"] || null,
    fieldCount: fields.length,
    keyFields,
    fields,
  };
}

function _buildDataElement(typeId, name, structureXml) {
  const wbobj = (structureXml && structureXml["blue:wbobj"]) || {};
  const wbAttrs = _attrs(wbobj);
  const dtel = wbobj["dtel:dataElement"] || {};
  // typeKind = "domain" | "intrinsic" | "reference"
  const typeKind = dtel["dtel:typeKind"] || null;
  return {
    typeId,
    name,
    type: "DTEL",
    description: wbAttrs["adtcore:description"] || null,
    typeKind,
    domain: typeKind === "domain" ? dtel["dtel:typeName"] || null : null,
    dataType: dtel["dtel:dataType"] || null,
    length: _toIntOrNull(dtel["dtel:dataTypeLength"]),
    decimals: _toIntOrNull(dtel["dtel:dataTypeDecimals"]),
    shortFieldLabel: dtel["dtel:shortFieldLabel"] || null,
    mediumFieldLabel: dtel["dtel:mediumFieldLabel"] || null,
    longFieldLabel: dtel["dtel:longFieldLabel"] || null,
    headingFieldLabel: dtel["dtel:headingFieldLabel"] || null,
  };
}

function _buildDomain(typeId, name, structureXml) {
  const domain = (structureXml && structureXml["doma:domain"]) || {};
  const domainAttrs = _attrs(domain);
  const content = domain["doma:content"] || {};
  const ti = content["doma:typeInformation"] || {};
  const oi = content["doma:outputInformation"] || {};
  const vi = content["doma:valueInformation"] || {};
  const valueTableRef = vi["doma:valueTableRef"] || null;
  return {
    typeId,
    name,
    type: "DOMA",
    description: domainAttrs["adtcore:description"] || null,
    dataType: ti["doma:datatype"] || ti["doma:dataType"] || null,
    length: _toIntOrNull(ti["doma:length"]),
    decimals: _toIntOrNull(ti["doma:decimals"]),
    outputLength: _toIntOrNull(oi["doma:length"]),
    conversionExit: oi["doma:conversionExit"] || null,
    valueTable: valueTableRef ? _attrs(valueTableRef)["adtcore:name"] || null : null,
  };
}

function _extractFieldsFromDataPreview(fieldsMeta) {
  if (!fieldsMeta || typeof fieldsMeta !== "object") return [];
  const tableData = fieldsMeta["dataPreview:tableData"];
  if (!tableData) return [];
  let columns = tableData["dataPreview:columns"];
  if (!columns) return [];
  if (!Array.isArray(columns)) columns = [columns];
  return columns.map(_normalizeDataPreviewColumn).filter(Boolean);
}

function _normalizeDataPreviewColumn(col) {
  if (!col || typeof col !== "object") return null;
  const md = col["dataPreview:metadata"];
  if (!md) return null;
  const a = _attrs(md);
  const keyIndexRaw = a["dataPreview:keyIndex"];
  const keyIndex = keyIndexRaw === undefined ? null : Number(keyIndexRaw);
  return {
    name: a["dataPreview:name"] || a["name"] || null,
    dataType: a["dataPreview:type"] || a["type"] || null,
    length: _toIntOrNull(a["dataPreview:length"] || a["length"]),
    decimals: _toIntOrNull(a["dataPreview:decimals"] || a["decimals"]),
    isKey: Number.isFinite(keyIndex) && keyIndex > 0,
    keyIndex: Number.isFinite(keyIndex) ? keyIndex : null,
    description: a["dataPreview:description"] || a["description"] || null,
  };
}

function _toIntOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _extractFields(xml) {
  if (!xml || typeof xml !== "object") return null;
  // ddic-meta endpoint returns something like:
  //   <entity><entityMetadata:metadata>...
  //   <entityMetadata:elements><entityMetadata:element>...
  //
  // The structure endpoint may return:
  //   <dataElements:dbTable> ... <tableTypes:fields> ...
  //
  // We walk the tree generically and pick out elements that look like
  // field rows. This is intentionally loose — DDIC XML shapes drift
  // between SAP releases.
  const candidates = [];
  _walkForFields(xml, candidates);
  if (candidates.length === 0) return null;
  return candidates.map(_normalizeField);
}

function _walkForFields(node, out) {
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith("@_")) continue;
    if (
      /(field|element|column|component)$/i.test(k) &&
      Array.isArray(v)
    ) {
      for (const row of v) out.push(row);
    } else if (
      /(field|element|column|component)$/i.test(k) &&
      v &&
      typeof v === "object"
    ) {
      out.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) _walkForFields(item, out);
    } else if (v && typeof v === "object") {
      _walkForFields(v, out);
    }
  }
}

function _normalizeField(raw) {
  const a = _attrs(raw);
  return {
    name:
      _normAttr(a, "adtcore:name") ||
      a["name"] ||
      a["FIELDNAME"] ||
      a["fieldName"] ||
      null,
    dataElement:
      a["rollName"] ||
      a["dataElement"] ||
      _firstValue(raw, ["rollName", "ROLLNAME"]) ||
      null,
    dataType:
      a["dataType"] ||
      a["DATATYPE"] ||
      _firstValue(raw, ["dataType", "DATATYPE"]) ||
      null,
    length:
      a["length"] ||
      a["LENG"] ||
      _firstValue(raw, ["length", "LENG"]) ||
      null,
    decimals: a["decimals"] || _firstValue(raw, ["decimals", "DECIMALS"]) || null,
    isKey:
      a["keyFlag"] === "true" ||
      a["KEYFLAG"] === "X" ||
      a["isKey"] === "true" ||
      false,
    notNull:
      a["notNull"] === "true" ||
      a["NOTNULL"] === "X" ||
      false,
    description:
      _normAttr(a, "adtcore:description") ||
      a["description"] ||
      a["DDTEXT"] ||
      null,
  };
}

function _attrs(node) {
  if (!node || typeof node !== "object") return {};
  const out = {};
  for (const k of Object.keys(node)) {
    if (k.startsWith("@_")) out[k.slice(2)] = node[k];
  }
  return out;
}

function _normAttr(attrs, key) {
  if (!attrs) return null;
  // Try exact key, then key without namespace prefix.
  if (attrs[key]) return attrs[key];
  const stripped = key.split(":").pop();
  return attrs[stripped] || null;
}

function _firstValue(node, candidateKeys) {
  if (!node || typeof node !== "object") return null;
  // Search depth-first for the first occurrence of any candidate key whose
  // value is a primitive. Useful when XML has nested elements like
  // <foo><DOMNAME>S_BOOKID</DOMNAME></foo>.
  const stack = [node];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur == null || typeof cur !== "object") continue;
    for (const k of candidateKeys) {
      if (cur[k] !== undefined && cur[k] !== null && typeof cur[k] !== "object") {
        return cur[k];
      }
    }
    for (const v of Object.values(cur)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

module.exports = { buildDdicEntry };
