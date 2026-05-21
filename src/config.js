"use strict";

// Profile + token storage in a per-user config dir.
//
// Layout (~/.adt-cli/config.json):
// {
//   "defaultProfile": "dev",
//   "profiles": {
//     "dev": {
//       "kind": "basic" | "oauth",
//       "url": "https://...",                   // ABAP server base URL
//       "client": "100",                         // (optional) sap-client
//       "language": "EN",                        // (optional) sap-language
//       "user": "DEVELOPER",                     // basic only
//       "password": "<encoded>",                 // basic only (obfuscated, not encrypted)
//       "loginUrl": "https://...uaa",            // oauth (BTP)
//       "clientId": "...",
//       "clientSecret": "<encoded>",
//       "refreshToken": "<encoded>",
//       "accessToken": "...",                    // cached
//       "tokenExpiresAt": 1735689600000,         // ms epoch
//       "ideId": "<uuid>",                       // for ADT debugger
//       "terminalId": "<uuid>",
//       "insecure": false                        // skip TLS verification
//     }
//   }
// }
//
// NOTE: Storage is plain JSON with simple base64 obfuscation for secrets.
// This is *not* encryption - treat as "don't shoulder-surf" only.
// For production, use a secret manager and pass tokens via env or --token.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const log = require("./logger");

const CONFIG_DIR = process.env.ADT_CLI_HOME || path.join(os.homedir(), ".adt-cli");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function load() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return { defaultProfile: null, profiles: {} };
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const cfg = JSON.parse(raw);
    if (!cfg.profiles) cfg.profiles = {};
    return cfg;
  } catch (e) {
    log.warn(`Could not parse ${CONFIG_FILE}: ${e.message}. Starting empty.`);
    return { defaultProfile: null, profiles: {} };
  }
}

function save(cfg) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function obf(s) {
  if (s == null) return s;
  return "b64:" + Buffer.from(String(s), "utf8").toString("base64");
}

function deobf(s) {
  if (s == null) return s;
  if (typeof s === "string" && s.startsWith("b64:")) {
    try {
      return Buffer.from(s.slice(4), "base64").toString("utf8");
    } catch {
      return s;
    }
  }
  return s;
}

function getProfile(name) {
  const cfg = load();
  const target = name || cfg.defaultProfile;
  if (!target) return null;
  const p = cfg.profiles[target];
  if (!p) return null;
  return {
    name: target,
    ...p,
    password: deobf(p.password),
    clientSecret: deobf(p.clientSecret),
    refreshToken: deobf(p.refreshToken),
  };
}

function setProfile(name, data) {
  const cfg = load();
  cfg.profiles[name] = {
    ...(cfg.profiles[name] || {}),
    ...data,
    password: data.password ? obf(data.password) : cfg.profiles[name]?.password,
    clientSecret: data.clientSecret ? obf(data.clientSecret) : cfg.profiles[name]?.clientSecret,
    refreshToken: data.refreshToken ? obf(data.refreshToken) : cfg.profiles[name]?.refreshToken,
  };
  if (!cfg.defaultProfile) cfg.defaultProfile = name;
  save(cfg);
}

function setDefault(name) {
  const cfg = load();
  if (!cfg.profiles[name]) {
    throw new Error(`Profile "${name}" does not exist.`);
  }
  cfg.defaultProfile = name;
  save(cfg);
}

function deleteProfile(name) {
  const cfg = load();
  delete cfg.profiles[name];
  if (cfg.defaultProfile === name) cfg.defaultProfile = null;
  save(cfg);
}

function listProfiles() {
  const cfg = load();
  return {
    defaultProfile: cfg.defaultProfile,
    profiles: Object.keys(cfg.profiles).map((n) => ({
      name: n,
      kind: cfg.profiles[n].kind,
      url: cfg.profiles[n].url,
      user: cfg.profiles[n].user || cfg.profiles[n].clientId,
    })),
  };
}

function updateProfile(name, patch) {
  const cfg = load();
  if (!cfg.profiles[name]) cfg.profiles[name] = {};
  cfg.profiles[name] = { ...cfg.profiles[name], ...patch };
  save(cfg);
}

function ensureIds(profile) {
  // Stable IDs are required for ADT debugger sessions.
  let changed = false;
  if (!profile.ideId) {
    profile.ideId = crypto.randomUUID().replace(/-/g, "").toUpperCase();
    changed = true;
  }
  if (!profile.terminalId) {
    profile.terminalId = crypto.randomUUID().replace(/-/g, "").toUpperCase();
    changed = true;
  }
  if (changed) {
    updateProfile(profile.name, { ideId: profile.ideId, terminalId: profile.terminalId });
  }
  return profile;
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  load,
  save,
  getProfile,
  setProfile,
  setDefault,
  deleteProfile,
  listProfiles,
  updateProfile,
  ensureIds,
};
