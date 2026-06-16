#!/usr/bin/env node
"use strict";

 // Corporate Proxy
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://rb-proxy-emea.bosch.com:8080';
if (proxyUrl) {
  try {
    const { setGlobalDispatcher, ProxyAgent } = require('undici');
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch (e) {}
}

// Auto-inject ADT_BEARER + ADT_USER_JWT from SSO token cache when not already set.
// Mirrors what adt-wrapper-pp.js --exec does so that commands (including adt lint)
// work directly after the wrapper has cached a valid token.
if (!process.env.ADT_BEARER) {
  try {
    const _os   = require("os");
    const _fs   = require("fs");
    const _path = require("path");
    const _f    = _path.join(_os.homedir(), ".adt-cli", "btp_sso_token.json");
    const _td   = JSON.parse(_fs.readFileSync(_f, "utf8"));
    if (Date.now() < _td.expiresAt && _td.access_token) {
      process.env.ADT_BEARER   = _td.access_token;
      //IYH1HC add — wrapper sets both; adt.js was only setting ADT_BEARER
      if (!process.env.ADT_USER_JWT) process.env.ADT_USER_JWT = _td.access_token;
    }
  } catch (_) {}
}

//IYH1HC add
// Reconstruct `destinations` env var from the active profile's cached URL.
// adt-wrapper-pp.js --exec saves the AppRouter URL into the profile (profile.url)
// and sets env.destinations at spawn time. When adt.js is called directly (not via
// wrapper), that env var is missing, so destination-type profiles can't resolve their
// URL. We rebuild it here so all adt commands work without re-running the wrapper.
if (!process.env.destinations && process.env.ADT_BEARER) {
  try {
    const _config  = require("../src/config");
    const _cfg     = _config.load();
    const _pName   = process.env.ADT_PROFILE || _cfg.defaultProfile;
    const _profile = _config.getProfile(_pName);
    if (_profile && _profile.kind === "destination" && _profile.url && _profile.destinationName) {
      process.env.destinations = JSON.stringify([{
        name:             _profile.destinationName,
        url:              _profile.url,
        forwardAuthToken: true,
      }]);
    }
  } catch (_) {}
}

// Tiny entry shim: hand off to the real CLI module.
// Keeps the bin file trivial so packagers/agents can wrap it without surprises.
require("../src/cli.js").run(process.argv).catch((err) => {
  // Fallback: cli.run already prints; re-raise non-zero exit if it leaks.
  // eslint-disable-next-line no-console
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
