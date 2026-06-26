"use strict";

// Generate `CONTEXT.md` — the human/LLM-readable index that sits at the root
// of every bundle. Two audiences:
//
//   1. A reviewing human who opens the folder in VS Code wants a one-pager
//      that explains what's here and how the parts fit together.
//   2. The downstream LLM, when given the bundle as tool-use context, reads
//      CONTEXT.md first to plan which sub-files to load. The "Recommended
//      reading order" section is its outline.
//
// We intentionally keep this file SHORT — long prose burns tokens for no
// extra information density. Tables and short bullets only.

const fs = require("fs");
const path = require("path");

function buildContextMd({ manifest, files, degradations, graph, metrics }) {
  const lines = [];
  lines.push(`# Package ${manifest.package}`);
  lines.push("");
  if (manifest.description) {
    lines.push(`> ${manifest.description}`);
    lines.push("");
  }

  // --- Identity table -----------------------------------------------------
  lines.push("## Identity");
  lines.push("");
  lines.push("| field | value |");
  lines.push("| --- | --- |");
  lines.push(`| package | ${manifest.package} |`);
  lines.push(`| parent | ${manifest.parent || "-"} |`);
  lines.push(`| software_component | ${manifest.softwareComponent || "-"} |`);
  lines.push(`| application_component | ${manifest.applicationComponent || "-"} |`);
  lines.push(`| transport_layer | ${manifest.transportLayer || "-"} |`);
  lines.push(`| package_type | ${manifest.packageType || "-"} |`);
  lines.push(`| master_language | ${manifest.masterLanguage || "-"} |`);
  lines.push(`| responsible | ${manifest.responsible || "-"} |`);
  lines.push(`| changed_by/at | ${manifest.changedBy || "-"} / ${manifest.changedAt || "-"} |`);
  lines.push(`| sub_packages | ${manifest.subPackages.length} |`);
  lines.push("");

  if (manifest.subPackages.length > 0) {
    lines.push("### Sub-packages");
    lines.push("");
    for (const s of manifest.subPackages) lines.push(`- ${s}`);
    lines.push("");
  }

  // --- Inventory ----------------------------------------------------------
  lines.push("## Inventory");
  lines.push("");
  lines.push(`Total objects: **${manifest.objectCount}**`);
  lines.push("");
  lines.push("| type | count |");
  lines.push("| --- | --- |");
  for (const [type, count] of Object.entries(manifest.objectsByType)) {
    lines.push(`| ${type} | ${count} |`);
  }
  lines.push("");

  // --- Files in this bundle ----------------------------------------------
  lines.push("## Files in this bundle");
  lines.push("");
  for (const f of files) {
    const tok = f.tokens != null ? ` (~${_fmtTok(f.tokens)} tok)` : "";
    lines.push(`- \`${f.name}\`${tok} — ${f.description}`);
  }
  lines.push("");

  if (graph && (graph.nodeCount != null || graph.edgeCount != null)) {
    lines.push("## Dependency summary");
    lines.push("");
    lines.push(`- nodes (internal + external): **${graph.nodeCount || 0}**`);
    lines.push(`- edges (outbound): **${graph.edgeCount || 0}**`);
    if (graph.edges && graph.edges.length > 0) {
      const byKind = {};
      for (const e of graph.edges) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      lines.push("- edge kinds:");
      for (const [k, n] of Object.entries(byKind).sort()) {
        lines.push(`  - ${k}: ${n}`);
      }
    }
    lines.push("");
  }

  if (metrics && Array.isArray(metrics) && metrics.length > 0) {
    const godClasses = metrics.filter((m) => m.isGodClass);
    const top = metrics
      .slice()
      .sort((a, b) => (b.maxComplexity || 0) - (a.maxComplexity || 0))
      .slice(0, 5);
    lines.push("## Metrics summary");
    lines.push("");
    lines.push(`- classes measured: **${metrics.length}**`);
    lines.push(`- god classes (>30 methods): **${godClasses.length}**`);
    if (top.length > 0) {
      lines.push("- top complexity hotspots:");
      for (const m of top) {
        lines.push(
          `  - ${m.name} — max complexity ${m.maxComplexity}, max method length ${m.maxMethodLength}`
        );
      }
    }
    lines.push("");
  }

  // --- Recommended reading order -----------------------------------------
  lines.push("## Recommended reading order for the LLM");
  lines.push("");
  lines.push("1. **CONTEXT.md** (this file) — orient on what the package is and what's in this bundle.");
  lines.push("2. **manifest.json** — full object inventory with adtcore metadata; pick which objects to focus on.");
  lines.push("3. **structure.json** — class / interface / program skeletons with method signatures, attributes, events.");
  lines.push("4. **dependencies.json** — follow call/inheritance/data-access edges to map information flow.");
  lines.push("5. **metrics.json** — identify complexity hotspots that warrant deeper investigation.");
  lines.push("6. Drill into specific sub-files only if the analysis step needs them (sources/, docs/, ddic.json, etc.).");
  lines.push("");

  // --- Omitted content / degradations ------------------------------------
  if (degradations && degradations.length > 0) {
    lines.push("## Omitted content");
    lines.push("");
    lines.push("The following content was dropped during budget-driven degradation:");
    lines.push("");
    for (const d of degradations) {
      lines.push(`- ${d.reason} (${d.detail || "no detail"})`);
    }
    lines.push("");
  }

  // --- Budget summary ----------------------------------------------------
  if (manifest.targetModel || manifest.tokenEstimate) {
    lines.push("## Token budget");
    lines.push("");
    if (manifest.targetModel) lines.push(`- target model: \`${manifest.targetModel}\``);
    if (manifest.softCap) lines.push(`- soft cap: ${_fmtTok(manifest.softCap)} tokens`);
    if (manifest.tokenEstimate && manifest.tokenEstimate.total != null) {
      lines.push(`- bundle estimate: **${_fmtTok(manifest.tokenEstimate.total)}** tokens`);
    }
    lines.push("");
  }

  lines.push(`_Generated at ${manifest.generatedAt} by adt-cli \`adt context build\`._`);
  lines.push("");
  return lines.join("\n");
}

function _fmtTok(n) {
  if (n == null) return "?";
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1) + "k";
}

function writeContextMd(outDir, payload) {
  const filePath = path.join(outDir, "CONTEXT.md");
  fs.writeFileSync(filePath, payload, "utf8");
  return filePath;
}

module.exports = { buildContextMd, writeContextMd };
