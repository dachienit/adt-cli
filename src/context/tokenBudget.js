"use strict";

// Token estimation + adaptive degradation for context bundles.
//
// Two design decisions worth surfacing:
//
//  1. Estimator: prefer `gpt-tokenizer` (pure JS, supports o200k_base) when
//     available, fall back to a chars/4 heuristic otherwise. The heuristic
//     OVERESTIMATES ABAP slightly (real ratio is ~3.5 chars/token for
//     keyword-heavy ABAP), which is the safe direction for budget capping.
//     The plan calls for `gpt-tokenizer` as a hard dep; it's loaded lazily
//     so this module works in environments where it isn't installed yet.
//
//  2. Soft cap = window * 0.7, leaving ~30% headroom for the LLM prompt
//     scaffolding + reasoning + output. Override via `--max-tokens`.
//
// Models table is intentionally short and additive. Add new model ids as the
// LLM Farm exposes them; the default fallback (128k window) covers anything
// not listed.

let _tokenizer;
function _loadTokenizer() {
  if (_tokenizer !== undefined) return _tokenizer;
  try {
    // gpt-tokenizer default export uses cl100k_base; we want o200k_base
    // which works for both modern OpenAI and (approximately) Claude models.
    _tokenizer = require("gpt-tokenizer/encoding/o200k_base");
  } catch (_) {
    _tokenizer = null;
  }
  return _tokenizer;
}

const MODELS = {
  "claude-opus-4-7":   { window: 200_000, encoder: "o200k_base" },
  "claude-opus-4-6":   { window: 200_000, encoder: "o200k_base" },
  "claude-sonnet-4-6": { window: 200_000, encoder: "o200k_base" },
  "claude-haiku-4-5":  { window: 200_000, encoder: "o200k_base" },
  "gpt-5":             { window: 256_000, encoder: "o200k_base" },
  "gpt-5-nano":        { window: 128_000, encoder: "o200k_base" },
  "gpt-4o":            { window: 128_000, encoder: "o200k_base" },
  "deepseek-v3":       { window: 128_000, encoder: "o200k_base" },
  default:             { window: 128_000, encoder: "o200k_base" },
};

const SOFT_CAP_RATIO = 0.7;

function getModelInfo(modelId) {
  if (!modelId) return MODELS.default;
  return MODELS[modelId] || MODELS[String(modelId).toLowerCase()] || MODELS.default;
}

function softCapFor(modelId, override) {
  if (override != null && Number.isFinite(Number(override))) {
    return Math.max(0, Number(override));
  }
  const info = getModelInfo(modelId);
  return Math.floor(info.window * SOFT_CAP_RATIO);
}

function estimate(text) {
  if (text == null || text === "") return 0;
  const tk = _loadTokenizer();
  if (tk && typeof tk.encode === "function") {
    try {
      return tk.encode(String(text)).length;
    } catch (_) {
      /* fall through to heuristic */
    }
  }
  // Heuristic: 1 token ≈ 4 chars. Slight overestimate for ABAP, which is
  // safe for a soft cap. Document this in tokenBudget tests.
  return Math.ceil(String(text).length / 4);
}

function estimateObject(obj) {
  if (obj == null) return 0;
  return estimate(JSON.stringify(obj));
}

// Run adaptive degradation against a bundle plan and return the kept plan
// plus a degradations[] log entry for each section dropped.
//
// `plan` is the object the caller WANTS to write. Shape:
//   {
//     manifest, structure, dependencies, metrics,
//     ddic?, docs?, sources?: { [filename]: text },
//     contextMd,                  // computed AFTER degradation
//   }
//
// `budget` is the soft cap in tokens; `dropOrder` is the prioritized list
// of section names to drop while over budget. Defaults match the plan's
// Phase 3 degradation order.
const DEFAULT_DROP_ORDER = [
  "sources",        // raw ABAP source files (biggest by far)
  "docs",           // long-text documentation
  "whereUsedEdges", // inbound where-used edges (Phase 4)
  "metricsLowComplexity", // metrics entries with complexity <= 5
  "ddic",           // DDIC descriptors
  "metrics",        // entire metrics.json
];

function _measureSections(plan) {
  return {
    manifest: estimateObject(plan.manifest),
    structure: estimateObject(plan.structure),
    dependencies: estimateObject(plan.dependencies),
    metrics: estimateObject(plan.metrics),
    ddic: plan.ddic ? estimateObject(plan.ddic) : 0,
    docs: plan.docs ? estimateObject(plan.docs) : 0,
    sources: plan.sources
      ? Object.values(plan.sources).reduce((acc, t) => acc + estimate(t), 0)
      : 0,
  };
}

function degrade(plan, budget, dropOrder = DEFAULT_DROP_ORDER) {
  const degradations = [];
  let measurements = _measureSections(plan);
  let total = Object.values(measurements).reduce((a, b) => a + b, 0);

  if (!Number.isFinite(budget) || budget <= 0 || total <= budget) {
    return { plan, degradations, totalTokens: total, perSection: measurements };
  }

  for (const section of dropOrder) {
    if (total <= budget) break;

    if (section === "sources" && plan.sources && Object.keys(plan.sources).length > 0) {
      const droppedTokens = measurements.sources;
      const droppedCount = Object.keys(plan.sources).length;
      delete plan.sources;
      degradations.push({
        section: "sources",
        reason: "Raw ABAP sources dropped to fit budget.",
        detail: `${droppedCount} file(s), ~${droppedTokens} tokens`,
      });
    } else if (section === "docs" && plan.docs) {
      const droppedTokens = measurements.docs;
      delete plan.docs;
      degradations.push({
        section: "docs",
        reason: "Long-text documentation dropped to fit budget.",
        detail: `~${droppedTokens} tokens`,
      });
    } else if (section === "metricsLowComplexity" && plan.metrics && Array.isArray(plan.metrics.classes)) {
      const before = plan.metrics.classes.length;
      plan.metrics.classes = plan.metrics.classes.filter(
        (c) => (c.maxComplexity || 0) > 5 || c.isGodClass
      );
      const removed = before - plan.metrics.classes.length;
      if (removed > 0) {
        degradations.push({
          section: "metricsLowComplexity",
          reason: "Pruned metrics entries with max complexity ≤ 5.",
          detail: `removed ${removed} class(es)`,
        });
      }
    } else if (section === "ddic" && plan.ddic) {
      const droppedTokens = measurements.ddic;
      delete plan.ddic;
      degradations.push({
        section: "ddic",
        reason: "DDIC descriptors dropped to fit budget.",
        detail: `~${droppedTokens} tokens`,
      });
    } else if (section === "metrics" && plan.metrics) {
      const droppedTokens = measurements.metrics;
      delete plan.metrics;
      degradations.push({
        section: "metrics",
        reason: "Metrics dropped to fit budget.",
        detail: `~${droppedTokens} tokens`,
      });
    }
    // whereUsedEdges: handled in Phase 4 (no-op here).

    measurements = _measureSections(plan);
    total = Object.values(measurements).reduce((a, b) => a + b, 0);
  }

  return { plan, degradations, totalTokens: total, perSection: measurements };
}

function tokenizerName() {
  return _loadTokenizer() ? "gpt-tokenizer/o200k_base" : "heuristic-chars-per-4";
}

module.exports = {
  MODELS,
  SOFT_CAP_RATIO,
  DEFAULT_DROP_ORDER,
  getModelInfo,
  softCapFor,
  estimate,
  estimateObject,
  degrade,
  tokenizerName,
};
