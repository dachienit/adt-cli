#!/usr/bin/env node
"use strict";

// Tiny entry shim: hand off to the real CLI module.
// Keeps the bin file trivial so packagers/agents can wrap it without surprises.
require("../src/cli.js").run(process.argv).catch((err) => {
  // Fallback: cli.run already prints; re-raise non-zero exit if it leaks.
  // eslint-disable-next-line no-console
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
