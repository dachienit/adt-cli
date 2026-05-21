#!/usr/bin/env node
"use strict";

// Ép toàn bộ native fetch của Node.js đi qua Corporate Proxy
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://rb-proxy-emea.bosch.com:8080';
if (proxyUrl) {
  try {
    const { setGlobalDispatcher, ProxyAgent } = require('undici');
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch (e) {}
}

// Tiny entry shim: hand off to the real CLI module.
// Keeps the bin file trivial so packagers/agents can wrap it without surprises.
require("../src/cli.js").run(process.argv).catch((err) => {
  // Fallback: cli.run already prints; re-raise non-zero exit if it leaks.
  // eslint-disable-next-line no-console
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
