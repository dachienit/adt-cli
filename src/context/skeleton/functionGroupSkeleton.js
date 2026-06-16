"use strict";

// Build a compact JSON skeleton for one function group:
//   {
//     name, description,
//     functionModules: [{ name, description, parameters: [...], raising: [...] }],
//     includes:        [{ name, description }],
//   }
//
// Function module signatures live at the top of the FM source (between
// FUNCTION ... and the body). For Phase 3 MVP we parse them with a robust
// regex over the raw source — abaplint exposes FunctionModuleDefinition for
// some configurations but signatures via regex are the most reliable path
// across abapGit-served sources. Signatures look like:
//
//   FUNCTION zfm_demo.
//   *"----------------------------------------------------------------------
//   *"*"Local Interface:
//   *"  IMPORTING
//   *"     VALUE(IV_FOO) TYPE STRING
//   *"     REFERENCE(IV_BAR) TYPE I OPTIONAL DEFAULT 0
//   *"  EXPORTING
//   *"     VALUE(EV_OUT) TYPE STRING
//   *"  CHANGING
//   *"     REFERENCE(CV_FLAG) TYPE FLAG
//   *"  EXCEPTIONS
//   *"     NOT_FOUND
//   *"----------------------------------------------------------------------

function buildFunctionGroupSkeleton(fetched) {
  if (!fetched) return null;
  return {
    name: fetched.name,
    description: fetched.description || null,
    functionModules: (fetched.functionModules || []).map((fm) => ({
      name: fm.name,
      description: fm.description || null,
      ...parseFunctionSignature(fm.source || ""),
    })),
    includes: (fetched.includes || []).map((inc) => ({
      name: inc.name,
      description: inc.description || null,
    })),
  };
}

function parseFunctionSignature(source) {
  const result = { parameters: [], raising: [], exceptions: [] };
  if (!source) return result;

  // Slice out the comment block between FUNCTION and the first non-comment line.
  const match = source.match(
    /FUNCTION\s+[\w]+[^.]*\.\s*([\s\S]*?)(?:^[^\*].*?$|\nENDFUNCTION)/im
  );
  const block = match ? match[1] : source;
  const lines = block.split(/\r?\n/);

  let section = null;
  for (const raw of lines) {
    const stripped = raw.replace(/^\*"\s?/, "").trim();
    if (!stripped) continue;

    // Section headers
    if (/^IMPORTING\b/i.test(stripped)) { section = "importing"; continue; }
    if (/^EXPORTING\b/i.test(stripped)) { section = "exporting"; continue; }
    if (/^CHANGING\b/i.test(stripped))  { section = "changing"; continue; }
    if (/^TABLES\b/i.test(stripped))    { section = "tables"; continue; }
    if (/^RAISING\b/i.test(stripped))   { section = "raising"; continue; }
    if (/^EXCEPTIONS\b/i.test(stripped)){ section = "exceptions"; continue; }
    if (/^Local Interface/i.test(stripped)) { section = null; continue; }
    if (/^[-=]{2,}$/.test(stripped))    { continue; }

    if (section === "raising") {
      const m = stripped.match(/^([A-Z][\w]*)/i);
      if (m) result.raising.push(m[1].toUpperCase());
      continue;
    }
    if (section === "exceptions") {
      const m = stripped.match(/^([A-Z][\w]*)/i);
      if (m) result.exceptions.push(m[1].toUpperCase());
      continue;
    }
    if (section && ["importing", "exporting", "changing", "tables"].includes(section)) {
      const parsed = parseParameterLine(stripped);
      if (parsed) result.parameters.push({ ...parsed, kind: section });
    }
  }
  return result;
}

// Parse one FM parameter line: "VALUE(IV_FOO) TYPE STRING OPTIONAL DEFAULT '...'" etc.
function parseParameterLine(line) {
  const m = line.match(
    /^(?:VALUE\(|REFERENCE\()?\s*([A-Z][\w]*)\s*\)?\s*(?:LIKE\s+([\w\/-]+)|TYPE\s+(?:REF\s+TO\s+)?([\w\/-]+))?(?:\s+(OPTIONAL))?(?:\s+DEFAULT\s+(.+?))?$/i
  );
  if (!m) return null;
  const name = m[1].toUpperCase();
  const type = m[2] || m[3] || null;
  const optional = !!m[4];
  let defaultValue = m[5] ? m[5].trim() : null;
  if (defaultValue) defaultValue = defaultValue.replace(/\s*\.+$/, "");
  return { name, type, optional, default: defaultValue };
}

module.exports = {
  buildFunctionGroupSkeleton,
  parseFunctionSignature,
  parseParameterLine,
};
