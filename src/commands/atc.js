"use strict";

// `adt atc <verb>` - SAP ABAP Test Cockpit (ATC) commands.
//
// Three-step ATC flow this command tree exposes:
//
//   1. activate a check variant -> server returns a worklist id
//   2. run the worklist over one or more objects   -> server returns a run id
//   3. fetch the worklist for the run id           -> server returns findings
//
// And one convenience verb that does all three back-to-back:
//
//   adt atc check <objectUrl> [--variant DEFAULT] [--max 100]
//
// Endpoints used (mirrors src/api/atc.ts):
//   POST /sap/bc/adt/atc/worklists?checkVariant=<v>     (text/plain)
//   POST /sap/bc/adt/atc/runs?worklistId=<wlId>          (xml in/out)
//   GET  /sap/bc/adt/atc/worklists/<runId>               (atc.worklist.v1+xml)
//   GET  /sap/bc/adt/atc/customizing                     (atc.customizing-v1+xml)
//   GET  /sap/bc/adt/system/users                        (atom feed)

const objLib = require("../objLib");
const log = require("../logger");
const { renderJson, ensureOk } = require("../output");

function register(atc) {
  // -------- 1. activate a variant (returns the worklistId) --------------
  atc
    .command("activate")
    .description(
      "Activate an ATC check variant (returns the worklistId used by `atc run`)."
    )
    .argument(
      "<variant>",
      "ATC check variant id (e.g. DEFAULT, ABAPLINT_DEFAULT, S4_CLOUD_PLATFORM_CHECKS)"
    )
    .action(async function (variant) {
      const ctx = this.ctx;
      const url = `/sap/bc/adt/atc/worklists?checkVariant=${encodeURIComponent(variant)}`;
      log.step(`Activating ATC variant ${variant} -> POST /sap/bc/adt/atc/worklists`);
      const res = await ctx.getClient().send("POST", url, { accept: "text/plain" });
      ensureOk(res, "atc-activate");
      const worklistId = (res.text || "").trim();
      log.ok(`worklistId = ${worklistId}`);
      renderJson({ worklistId, variant });
    });

  // -------- 2. start the run --------------------------------------------
  atc
    .command("run")
    .description(
      "Run an activated worklist against one or more ADT object URLs. " +
        "Prints the worklist run id you can pass to `atc worklist`."
    )
    .argument("<worklistId>", "id returned by `adt atc activate <variant>`")
    .argument("<objectUrl...>", "ADT path or URL of the object(s) to check")
    .option("--max <n>", "maximum number of findings (verdicts) to keep", "100")
    .action(async function (worklistId, objectUrls, opts) {
      const ctx = this.ctx;
      const refs = objectUrls
        .map((u) => objLib.normalizeObjectUrl(u))
        .map((u) => `<adtcore:objectReference adtcore:uri="${escapeAttr(u)}"/>`)
        .join("\n        ");
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<atc:run maximumVerdicts="${escapeAttr(opts.max)}" xmlns:atc="http://www.sap.com/adt/atc">\n` +
        `  <objectSets xmlns:adtcore="http://www.sap.com/adt/core">\n` +
        `    <objectSet kind="inclusive">\n` +
        `      <adtcore:objectReferences>\n` +
        `        ${refs}\n` +
        `      </adtcore:objectReferences>\n` +
        `    </objectSet>\n` +
        `  </objectSets>\n` +
        `</atc:run>`;
      const url = `/sap/bc/adt/atc/runs?worklistId=${encodeURIComponent(worklistId)}`;
      log.step(`Running ATC -> POST /sap/bc/adt/atc/runs (${objectUrls.length} object(s))`);
      const res = await ctx.getClient().send("POST", url, {
        accept: "application/xml",
        headers: { "Content-Type": "application/xml" },
        body,
      });
      ensureOk(res, "atc-run");
      const summary = parseRunResult(res.body);
      renderJson(summary);
    });

  // -------- 3. fetch findings --------------------------------------------
  atc
    .command("worklist")
    .description(
      "Fetch the worklist (findings) for a run. The id is what `atc run` returned."
    )
    .argument("<runId>", "worklist/run id from `atc run`")
    .option("--include-exempted", "include exempted findings")
    .option("--object-set <name>", "restrict to a specific objectSet")
    .option("--timestamp <epoch>", "constrain by timestamp (rare)")
    .action(async function (runId, opts) {
      const ctx = this.ctx;
      const params = new URLSearchParams();
      if (opts.includeExempted) params.set("includeExemptedFindings", "true");
      if (opts.objectSet) params.set("usedObjectSet", opts.objectSet);
      if (opts.timestamp) params.set("timestamp", opts.timestamp);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const url = `/sap/bc/adt/atc/worklists/${encodeURIComponent(runId)}${qs}`;
      log.step(`Fetching worklist -> GET ${url}`);
      const res = await ctx.getClient().send("GET", url, {
        accept: "application/atc.worklist.v1+xml, application/xml",
      });
      ensureOk(res, "atc-worklist");
      const wl = parseWorklist(res.body);
      renderJson(wl);
      if (wl.summary.errors > 0 || wl.summary.warnings > 0) process.exitCode = 1;
    });

  // -------- 4. one-shot convenience verb --------------------------------
  atc
    .command("check")
    .description(
      "End-to-end: activate variant + run + fetch worklist for an object. " +
        "Exits non-zero if errors or warnings were reported."
    )
    .argument("<objectUrl...>", "ADT path or URL of the object(s) to check")
    .option("--variant <id>", "ATC check variant", "DEFAULT")
    .option("--max <n>", "maximum number of findings to keep", "100")
    .option("--include-exempted", "include exempted findings in the worklist")
    .action(async function (objectUrls, opts) {
      const ctx = this.ctx;
      const client = ctx.getClient();

      // 1. activate
      log.step(`Activating ATC variant ${opts.variant}`);
      const actUrl = `/sap/bc/adt/atc/worklists?checkVariant=${encodeURIComponent(opts.variant)}`;
      const actRes = await client.send("POST", actUrl, { accept: "text/plain" });
      ensureOk(actRes, "atc-activate");
      const worklistId = (actRes.text || "").trim();
      log.ok(`worklistId = ${worklistId}`);

      // 2. run
      const refs = objectUrls
        .map((u) => objLib.normalizeObjectUrl(u))
        .map((u) => `<adtcore:objectReference adtcore:uri="${escapeAttr(u)}"/>`)
        .join("\n        ");
      const body =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<atc:run maximumVerdicts="${escapeAttr(opts.max)}" xmlns:atc="http://www.sap.com/adt/atc">\n` +
        `  <objectSets xmlns:adtcore="http://www.sap.com/adt/core">\n` +
        `    <objectSet kind="inclusive">\n` +
        `      <adtcore:objectReferences>\n` +
        `        ${refs}\n` +
        `      </adtcore:objectReferences>\n` +
        `    </objectSet>\n` +
        `  </objectSets>\n` +
        `</atc:run>`;
      const runUrl = `/sap/bc/adt/atc/runs?worklistId=${encodeURIComponent(worklistId)}`;
      log.step(`Running ATC over ${objectUrls.length} object(s)`);
      const runRes = await client.send("POST", runUrl, {
        accept: "application/xml",
        headers: { "Content-Type": "application/xml" },
        body,
      });
      ensureOk(runRes, "atc-run");
      const runSummary = parseRunResult(runRes.body);
      if (!runSummary.id) {
        log.debug("atc-run raw body", runRes.text);
        throw new Error(
          "atc-run succeeded but no worklistId was found in the response. " +
            "Re-run with --debug to dump the raw XML."
        );
      }
      log.ok(`Run id = ${runSummary.id}`);

      // 3. fetch worklist
      const params = new URLSearchParams();
      if (opts.includeExempted) params.set("includeExemptedFindings", "true");
      const qs = params.toString() ? `?${params.toString()}` : "";
      const wlUrl = `/sap/bc/adt/atc/worklists/${encodeURIComponent(runSummary.id)}${qs}`;
      log.step(`Fetching worklist -> GET ${wlUrl}`);
      const wlRes = await client.send("GET", wlUrl, {
        accept: "application/atc.worklist.v1+xml, application/xml",
      });
      ensureOk(wlRes, "atc-worklist");
      const wl = parseWorklist(wlRes.body);

      renderJson({
        variant: opts.variant,
        worklistId,
        runId: runSummary.id,
        ...wl,
      });
      if (wl.summary.errors > 0 || wl.summary.warnings > 0) process.exitCode = 1;
    });

  // -------- helpers ------------------------------------------------------
  atc
    .command("customizing")
    .description("Show the ATC customizing (properties + exemption reasons).")
    .action(async function () {
      const ctx = this.ctx;
      const res = await ctx.getClient().send("GET", "/sap/bc/adt/atc/customizing", {
        accept: "application/xml, application/vnd.sap.atc.customizing-v1+xml",
      });
      ensureOk(res, "atc-customizing");
      renderJson(parseCustomizing(res.body));
    });

  atc
    .command("users")
    .description("List ATC processors (the system user feed used by ATC contact change).")
    .action(async function () {
      const ctx = this.ctx;
      const res = await ctx.getClient().send("GET", "/sap/bc/adt/system/users", {
        accept: "application/atom+xml;type=feed",
      });
      ensureOk(res, "atc-users");
      renderJson(parseUsers(res.body));
    });
}

// --- parsers ----------------------------------------------------------------

function parseRunResult(body) {
  const root = pickByLocalName(body, "worklistRun");
  if (!root) return { id: "", timestamp: 0, infos: [], raw: body };
  const id = textByLocalName(root, "worklistId");
  const ts = textByLocalName(root, "worklistTimestamp");
  const infosNode = pickByLocalName(root, "infos") || {};
  const infos = toArray(pickByLocalName(infosNode, "info")).map(nodeAttrs);
  return {
    id: String(id || "").trim(),
    timestamp: ts ? Date.parse(ts) || 0 : 0,
    infos,
  };
}

function parseWorklist(body) {
  const root = pickByLocalName(body, "worklist");
  if (!root) return { summary: zeroSummary(), objects: [], raw: body };
  const attrs = nodeAttrs(root);
  const objSetsRoot = pickByLocalName(root, "objectSets") || {};
  const objectSets = toArray(pickByLocalName(objSetsRoot, "objectSet")).map(nodeAttrs);

  const objsRoot = pickByLocalName(root, "objects") || {};
  const objects = toArray(pickByLocalName(objsRoot, "object")).map((o) => {
    const oa = nodeAttrs(o);
    const fRoot = pickByLocalName(o, "findings") || {};
    const findings = toArray(pickByLocalName(fRoot, "finding")).map((f) => {
      const fa = nodeAttrs(f);
      const link = nodeAttrs(pickByLocalName(f, "link")) || {};
      return {
        priority: toInt(fa.priority),
        checkId: fa.checkId,
        checkTitle: fa.checkTitle,
        messageId: String(fa.messageId || ""),
        messageTitle: fa.messageTitle,
        location: fa.location,
        uri: fa.uri,
        exemptionApproval: fa.exemptionApproval,
        exemptionKind: fa.exemptionKind,
        quickfixInfo: fa.quickfixInfo,
        link: link.href ? link : undefined,
      };
    });
    return {
      uri: oa.uri,
      name: oa.name,
      type: oa.type,
      packageName: oa.packageName,
      author: oa.author,
      findings,
    };
  });

  const summary = summarize(objects);
  return {
    id: attrs.id,
    timestamp: attrs.timestamp ? Date.parse(attrs.timestamp) || 0 : 0,
    usedObjectSet: attrs.usedObjectSet,
    objectSetIsComplete: attrs.objectSetIsComplete === "true",
    objectSets,
    objects,
    summary,
  };
}

function summarize(objects) {
  const out = zeroSummary();
  for (const o of objects) {
    for (const f of o.findings) {
      out.total++;
      if (f.priority === 1) out.errors++;
      else if (f.priority === 2) out.warnings++;
      else out.info++;
    }
  }
  return out;
}

function zeroSummary() {
  return { total: 0, errors: 0, warnings: 0, info: 0 };
}

function parseCustomizing(body) {
  const root = pickByLocalName(body, "customizing");
  if (!root) return { raw: body };
  const propsRoot = pickByLocalName(root, "properties") || {};
  const properties = toArray(pickByLocalName(propsRoot, "property")).map(nodeAttrs);

  const exRoot =
    pickByLocalName(root, "exemption") || pickByLocalName(root, "exemptions") || {};
  const reasonsRoot = pickByLocalName(exRoot, "reasons") || exRoot;
  const exemptions = toArray(pickByLocalName(reasonsRoot, "reason")).map(nodeAttrs);
  return { properties, exemptions };
}

function parseUsers(body) {
  const root = pickByLocalName(body, "feed");
  if (!root) return { raw: body };
  return toArray(pickByLocalName(root, "entry")).map((e) => {
    const id = textByLocalName(e, "id");
    const title = textByLocalName(e, "title");
    return {
      id: typeof id === "string" ? id : id?.["#text"] || "",
      title: typeof title === "string" ? title : title?.["#text"] || "",
    };
  });
}

// --- generic XML helpers (work with fast-xml-parser output) -----------------

// Match a key by its local name (after any "prefix:"). Useful when SAP returns
// XML with namespaces our parser does NOT strip - mirrors the
// removeNSPrefix:true that the reference TS API uses.
function pickByLocalName(obj, localName) {
  if (!obj || typeof obj !== "object") return null;
  if (obj[localName] != null) return obj[localName];
  for (const k of Object.keys(obj)) {
    if (!k || k.startsWith("@_") || k === "#text") continue;
    const idx = k.indexOf(":");
    const ln = idx === -1 ? k : k.slice(idx + 1);
    if (ln === localName) return obj[k];
  }
  return null;
}

function textByLocalName(node, localName) {
  const v = pickByLocalName(node, localName);
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && "#text" in v) return v["#text"];
  return "";
}

function nodeAttrs(node) {
  if (!node || typeof node !== "object") return {};
  const out = {};
  for (const k of Object.keys(node)) {
    if (k.startsWith("@_")) {
      const name = k.slice(2);
      const colon = name.indexOf(":");
      out[colon === -1 ? name : name.slice(colon + 1)] = node[k];
    }
  }
  return out;
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function escapeAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { register };
