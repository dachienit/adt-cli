"use strict";

// Port of the CreatableTypes registry from src/api/objectcreator.ts.
// We mirror creationPath, validationPath, namespace, root tag, alias and
// max name length verbatim. These tuples are what the ADT server expects:
// changing any of them will silently break creation.

const TYPES = [
  {
    alias: "program",
    typeId: "PROG/P",
    label: "Program",
    creationPath: "programs/programs",
    validationPath: "programs/validation",
    rootName: "program:abapProgram",
    nameSpace: 'xmlns:program="http://www.sap.com/adt/programs/programs"',
    parent: "package",
    maxLen: 30,
  },
  {
    alias: "class",
    typeId: "CLAS/OC",
    label: "Class",
    creationPath: "oo/classes",
    validationPath: "oo/validation/objectname",
    rootName: "class:abapClass",
    nameSpace: 'xmlns:class="http://www.sap.com/adt/oo/classes"',
    parent: "package",
    maxLen: 30,
  },
  {
    alias: "interface",
    typeId: "INTF/OI",
    label: "Interface",
    creationPath: "oo/interfaces",
    validationPath: "oo/validation/objectname",
    rootName: "intf:abapInterface",
    nameSpace: 'xmlns:intf="http://www.sap.com/adt/oo/interfaces"',
    parent: "package",
    maxLen: 30,
  },
  {
    alias: "include",
    typeId: "PROG/I",
    label: "Include",
    creationPath: "programs/includes",
    validationPath: "includes/validation",
    rootName: "include:abapInclude",
    nameSpace: 'xmlns:include="http://www.sap.com/adt/programs/includes"',
    parent: "package",
    maxLen: 30,
  },
  {
    alias: "fgroup",
    typeId: "FUGR/F",
    label: "Function Group",
    creationPath: "functions/groups",
    validationPath: "functions/validation",
    rootName: "group:abapFunctionGroup",
    nameSpace: 'xmlns:group="http://www.sap.com/adt/functions/groups"',
    parent: "package",
    maxLen: 26,
  },
  {
    alias: "fmodule",
    typeId: "FUGR/FF",
    label: "Function module",
    creationPath: "functions/groups/%s/fmodules",
    validationPath: "functions/validation",
    rootName: "fmodule:abapFunctionModule",
    nameSpace: 'xmlns:fmodule="http://www.sap.com/adt/functions/fmodules"',
    parent: "fgroup",
    maxLen: 30,
  },
  {
    alias: "finclude",
    typeId: "FUGR/I",
    label: "Function group include",
    creationPath: "functions/groups/%s/includes",
    validationPath: "functions/validation",
    rootName: "finclude:abapFunctionGroupInclude",
    nameSpace: 'xmlns:finclude="http://www.sap.com/adt/functions/fincludes"',
    parent: "fgroup",
    maxLen: 30,
  },
  {
    alias: "ddl",
    typeId: "DDLS/DF",
    label: "CDS Data Definition",
    creationPath: "ddic/ddl/sources",
    validationPath: "ddic/ddl/validation",
    rootName: "ddl:ddlSource",
    nameSpace: 'xmlns:ddl="http://www.sap.com/adt/ddic/ddlsources"',
    parent: "package",
    maxLen: 30,
  },
  {
    alias: "dcl",
    typeId: "DCLS/DL",
    label: "CDS Access Control",
    creationPath: "acm/dcl/sources",
    validationPath: "acm/dcl/validation",
    rootName: "dcl:dclSource",
    nameSpace: 'xmlns:dcl="http://www.sap.com/adt/acm/dclsources"',
    parent: "package",
    maxLen: 30,
  },
  {
    alias: "ddlx",
    typeId: "DDLX/EX",
    label: "CDS metadata extension",
    creationPath: "ddic/ddlx/sources",
    validationPath: "ddic/ddlx/sources/validation",
    rootName: "ddlx:ddlxSource",
    nameSpace: 'xmlns:ddlx="http://www.sap.com/adt/ddic/ddlxsources"',
    parent: "package",
    maxLen: 30,
  },
  {
    alias: "ddla",
    typeId: "DDLA/ADF",
    label: "CDS Annotation definition",
    creationPath: "ddic/ddla/sources",
    validationPath: "ddic/ddla/sources/validation",
    rootName: "ddla:ddlaSource",
    nameSpace: 'xmlns:ddla="http://www.sap.com/adt/ddic/ddlasources"',
    parent: "package",
    maxLen: 30,
  },
  {
    alias: "package",
    typeId: "DEVC/K",
    label: "Package",
    creationPath: "packages",
    validationPath: "packages/validation",
    rootName: "pak:package",
    nameSpace: 'xmlns:pak="http://www.sap.com/adt/packages"',
    parent: "package", // super package
    maxLen: 30,
  },
  {
    alias: "table",
    typeId: "TABL/DT",
    label: "Table",
    creationPath: "ddic/tables",
    validationPath: "ddic/tables/validation",
    rootName: "blue:blueSource",
    nameSpace: 'xmlns:blue="http://www.sap.com/wbobj/blue"',
    parent: "package",
    maxLen: 16,
  },
  {
    alias: "service-def",
    typeId: "SRVD/SRV",
    label: "Service definition",
    creationPath: "ddic/srvd/sources",
    validationPath: "ddic/srvd/sources/validation",
    rootName: "srvd:srvdSource",
    nameSpace: 'xmlns:srvd="http://www.sap.com/adt/ddic/srvdsources"',
    extra: 'srvd:srvdSourceType="S"',
    parent: "package",
    maxLen: 30,
  },
  {
    alias: "auth-field",
    typeId: "AUTH",
    label: "Authorization field",
    creationPath: "aps/iam/auth",
    validationPath: "aps/iam/auth/validation",
    rootName: "auth:auth",
    nameSpace: 'xmlns:auth="http://www.sap.com/iam/auth"',
    parent: "package",
    maxLen: 10,
  },
  {
    alias: "auth-object",
    typeId: "SUSO/B",
    label: "Authorization object",
    creationPath: "aps/iam/suso",
    validationPath: "aps/iam/suso/validation",
    rootName: "susob:suso",
    nameSpace: 'xmlns:susob="http://www.sap.com/iam/suso"',
    parent: "package",
    maxLen: 10,
  },
  {
    alias: "dtel",
    typeId: "DTEL/DE",
    label: "Data Element",
    creationPath: "ddic/dataelements",
    validationPath: "ddic/dataelements/validation",
    rootName: "blue:wbobj",
    nameSpace: 'xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel"',
    parent: "package",
    maxLen: 30,
  },
  {
    alias: "service-binding",
    typeId: "SRVB/SVB",
    label: "Service binding",
    creationPath: "businessservices/bindings",
    validationPath: "businessservices/bindings/validation",
    rootName: "srvb:serviceBinding",
    nameSpace: 'xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings"',
    parent: "package",
    maxLen: 26,
  },
  {
    alias: "msag",
    typeId: "MSAG/N",
    label: "Message class",
    creationPath: "messageclass",
    validationPath: "messageclass/validation",
    rootName: "mc:messageClass",
    nameSpace: 'xmlns:mc="http://www.sap.com/adt/MessageClass"',
    parent: "package",
    maxLen: 20,
  },
];

const byAlias = new Map(TYPES.map((t) => [t.alias, t]));
const byTypeId = new Map(TYPES.map((t) => [t.typeId, t]));

function lookup(aliasOrTypeId) {
  const key = String(aliasOrTypeId || "").trim();
  return byAlias.get(key) || byTypeId.get(key) || null;
}

function list() {
  return TYPES.slice();
}

// Replicates the sprintf("%s") of the TS source - we only ever use %s once.
function applyParent(template, parentName) {
  return template.replace("%s", encodeURIComponent(String(parentName || "").toLowerCase()));
}

// URL of the create endpoint (object name is in the body, not the URL).
function creationUrl(type, parentName) {
  return "/sap/bc/adt/" + applyParent(type.creationPath, parentName);
}

// Where the resulting object lives (used for source/lock/activate/delete).
function objectUrl(type, name, parentName) {
  return creationUrl(type, parentName) + "/" + encodeURIComponent(name);
}

// Convention used by the existing TS API - `setObjectSource` PUTs to ../source/main.
function sourceUrl(type, name, parentName, includeName = "main") {
  return objectUrl(type, name, parentName) + "/source/" + encodeURIComponent(includeName);
}

const encEntity = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// --- body builders, ported from objectcreator.ts ----------------------------

function bodyPackage(type, opts) {
  const responsible = opts.responsible
    ? `adtcore:responsible="${encEntity(opts.responsible)}"`
    : "";
  const compname = opts.swcomp ? `pak:name="${encEntity(opts.swcomp)}"` : "";
  const description = `adtcore:description="${encEntity(opts.description || "")}"`;
  const superp = opts.parentName ? `adtcore:name="${encEntity(opts.parentName)}"` : "";
  const pkgname = `adtcore:name="${encEntity(opts.name)}"`;
  const pkgtype = opts.packageType ? `pak:packageType="${encEntity(opts.packageType)}"` : "";
  const layer = encEntity(opts.transportLayer || "");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<pak:package ${type.nameSpace} xmlns:adtcore="http://www.sap.com/adt/core" ${description}\n` +
    `  ${pkgname} adtcore:type="${type.typeId}" adtcore:version="active" ${responsible}>\n` +
    `  <pak:attributes ${pkgtype}/>\n` +
    `  <pak:superPackage ${superp}/>\n` +
    `  <pak:applicationComponent/>\n` +
    `  <pak:transport>\n` +
    `    <pak:softwareComponent ${compname}/>\n` +
    `    <pak:transportLayer pak:name="${layer}"/>\n` +
    `  </pak:transport>\n` +
    `  <pak:translation/>\n` +
    `  <pak:useAccesses/>\n` +
    `  <pak:packageInterfaces/>\n` +
    `  <pak:subPackages/>\n` +
    `</pak:package>`
  );
}

function bodyFuncMember(type, opts) {
  const responsible = opts.responsible
    ? `adtcore:responsible="${encEntity(opts.responsible)}"`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<${type.rootName} ${type.nameSpace}\n` +
    `  xmlns:adtcore="http://www.sap.com/adt/core"\n` +
    `  adtcore:description="${encEntity(opts.description || "")}"\n` +
    `  adtcore:name="${encEntity(opts.name)}" adtcore:type="${type.typeId}" ${responsible}>\n` +
    `  <adtcore:containerRef adtcore:name="${encEntity(opts.parentName)}"\n` +
    `    adtcore:type="FUGR/F"\n` +
    `    adtcore:uri="${encEntity(opts.parentPath)}" />\n` +
    `</${type.rootName}>`
  );
}

function bodyServiceBinding(type, opts) {
  const responsible = opts.responsible
    ? `adtcore:responsible="${encEntity(opts.responsible)}"`
    : "";
  const inner =
    `<adtcore:packageRef adtcore:name="${encEntity(opts.parentName)}"/>\n` +
    `<srvb:services srvb:name="${encEntity(opts.name)}">\n` +
    `  <srvb:content srvb:version="0001">\n` +
    `    <srvb:serviceDefinition adtcore:name="${encEntity(opts.service || "")}"/>\n` +
    `  </srvb:content>\n` +
    `</srvb:services>\n` +
    `<srvb:binding srvb:category="${encEntity(opts.category || "0")}" srvb:type="${encEntity(
      opts.bindingType || "ODATA"
    )}" srvb:version="V2">\n` +
    `  <srvb:implementation adtcore:name=""/>\n` +
    `</srvb:binding>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<${type.rootName} ${type.nameSpace}\n` +
    `  xmlns:adtcore="http://www.sap.com/adt/core"\n` +
    `  adtcore:description="${encEntity(opts.description || "")}"\n` +
    `  adtcore:name="${encEntity(opts.name)}" adtcore:type="${type.typeId}"\n` +
    `  ${responsible} ${type.extra || ""}>\n` +
    `  ${inner}\n` +
    `</${type.rootName}>`
  );
}

function bodySimple(type, opts) {
  const responsible = opts.responsible
    ? `adtcore:responsible="${encEntity(opts.responsible)}"`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<${type.rootName} ${type.nameSpace}\n` +
    `  xmlns:adtcore="http://www.sap.com/adt/core"\n` +
    `  adtcore:description="${encEntity(opts.description || "")}"\n` +
    `  adtcore:name="${encEntity(opts.name)}" adtcore:type="${type.typeId}"\n` +
    `  ${responsible} ${type.extra || ""}>\n` +
    `  <adtcore:packageRef adtcore:name="${encEntity(opts.parentName)}"/>\n` +
    `</${type.rootName}>`
  );
}

function buildBody(type, opts) {
  switch (type.typeId) {
    case "DEVC/K":
      return bodyPackage(type, opts);
    case "FUGR/FF":
    case "FUGR/I":
      return bodyFuncMember(type, opts);
    case "SRVB/SVB":
      return bodyServiceBinding(type, opts);
    default:
      return bodySimple(type, opts);
  }
}

// Validation query string (matches what objectcreator.ts sends as `qs`).
function validationQuery(type, opts) {
  const q = new URLSearchParams();
  q.set("objname", String(opts.name).toUpperCase());
  q.set("description", opts.description || "");
  q.set("objtype", type.typeId);
  if (type.parent === "fgroup") {
    if (!opts.parentName) throw new Error(`${type.label} requires --group <fgroup>`);
    q.set("fugrname", String(opts.parentName).toUpperCase());
  } else if (type.typeId === "DEVC/K") {
    if (opts.parentName) q.set("packagename", String(opts.parentName).toUpperCase());
    if (opts.swcomp) q.set("swcomp", opts.swcomp);
    if (opts.transportLayer) q.set("transportLayer", opts.transportLayer);
    if (opts.packageType) q.set("packagetype", opts.packageType);
  } else {
    if (!opts.parentName) throw new Error(`${type.label} requires --package <pkg>`);
    q.set("packagename", String(opts.parentName).toUpperCase());
  }
  return q;
}

module.exports = {
  TYPES,
  lookup,
  list,
  creationUrl,
  objectUrl,
  sourceUrl,
  buildBody,
  validationQuery,
  encEntity,
  applyParent,
};
