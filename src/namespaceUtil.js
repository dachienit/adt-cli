"use strict";

// Standalone namespace-prefix matcher. Lives outside pullConfig to avoid the
// circular dependency pullConfig → pullRegistry → fugrFetcher → pullConfig.
//
// Safe-by-default policy: an empty / missing prefix list returns FALSE
// ("không có config thì không pull về gì cả"). Caller decides whether to
// surface that as a `not-in-namespace` status or to pass a non-empty list.

function matchesNamespace(name, prefixes) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return false;
  const upper = String(name).toUpperCase();
  return prefixes.some((p) => upper.startsWith(String(p).toUpperCase()));
}

module.exports = { matchesNamespace };
