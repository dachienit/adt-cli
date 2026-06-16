"use strict";

// Resolve a BTP destination by name and turn it into the bits AdtClient needs:
//   { url, authHeader, sapClient, language, additionalHeaders, additionalQueries, raw }
//
// Lookup order (mirrors @sap-cloud-sdk/connectivity behaviour):
//
//   1. process.env.destinations  (JSON array of simple objects; for local dev)
//   2. VCAP_SERVICES.destination (BTP destination service via XSUAA)
//   3. profile.serviceBindingJson (explicit override stored on the profile,
//      handy when you want to point at a different sub-account from the one
//      currently bound to the runtime)
//
// The destination service returns auth bytes that are good for ~12h, so we
// cache the resolved record in-memory keyed by (name, tenant or "provider")
// until 30 seconds before expiry.
//
// Reference: https://sap.github.io/cloud-sdk/docs/js/features/connectivity/destinations
//
// What we DON'T support yet (because the CLI doesn't need it):
//   - PrincipalPropagation / SAMLBearer / UserTokenExchange (need a user JWT
//     and a connectivity service binding for the on-prem cloud connector).
//   - mTLS / ClientCertificateAuthentication (CF instance identity).
// When one of those types is encountered we return the destination URL and
// any additional headers/queries, but no Authorization header, so the user
// can pipe in `--accept` / set ADT_BEARER themselves.

const log = require("./logger");

const cache = new Map(); // key -> { record, expiresAt }
const TOKEN_SAFETY_MS = 30 * 1000;

async function resolveDestination(name, opts = {}) {
  if (!name) throw new Error("destination name is required");
  const key = cacheKey(name, opts);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    log.debug(`destination cache hit for "${name}"`);
    return hit.record;
  }

  // 1. local env var (dev convenience, multi-tenant unsafe)
  const localEnv = readEnvDestination(name);
  if (localEnv) {
    const record = normalizeLocalEnvDestination(localEnv);
    cache.set(key, { record, expiresAt: Date.now() + 60 * 1000 });
    return record;
  }

  // 2./3. service-binding-driven lookup
  const binding =
    parseServiceBinding(opts.serviceBindingJson) ||
    findVcapDestinationBinding();
  if (!binding) {
    throw new Error(
      `Cannot resolve destination "${name}": no local env, no VCAP_SERVICES.destination ` +
        `binding and no profile.serviceBindingJson override. ` +
        `Set the "destinations" env var or run on BTP with a destination service binding.`
    );
  }

  const access = await fetchXsuaaToken(binding.credentials);
  
  const url = trim(binding.credentials.uri || binding.credentials.url) +
    `/destination-configuration/v1/destinations/${encodeURIComponent(name)}`;

  const headers = { Authorization: `Bearer ${access.token}` };
  if (opts.iss) headers["X-User-Token"] = "";
  if (opts.userJwt) headers["X-User-Token"] = opts.userJwt;
  if (opts.iss) headers["X-Tenant"] = subdomainFromIss(opts.iss);

  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Destination service returned HTTP ${res.status} ${res.statusText}: ` + truncate(text, 400)
    );
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Destination service response was not JSON: ${truncate(text, 200)}`);
  }
  const record = normalizeServiceDestination(json);
  // Cache for the shortest auth token TTL we got, falling back to 5 minutes.
  const ttlMs = (record.authTokenExpiresIn || 300) * 1000 - TOKEN_SAFETY_MS;
  cache.set(key, { record, expiresAt: Date.now() + ttlMs });
  return record;
}

// ---- env / VCAP discovery --------------------------------------------------

function readEnvDestination(name) {
  const raw = process.env.destinations;
  if (!raw) return null;
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    log.warn(`Could not parse process.env.destinations: ${e.message}`);
    return null;
  }
  if (!Array.isArray(arr)) return null;
  return arr.find((d) => d && d.name === name) || null;
}

function findVcapDestinationBinding() {
  const raw = process.env.VCAP_SERVICES;
  if (!raw) return null;
  let vcap;
  try {
    vcap = JSON.parse(raw);
  } catch (e) {
    log.warn(`Could not parse VCAP_SERVICES: ${e.message}`);
    return null;
  }
  const list = vcap.destination || vcap["destination-lite"] || [];
  return list[0] || null;
}

function parseServiceBinding(input) {
  if (!input) return null;
  if (typeof input === "object") return input;
  try {
    return JSON.parse(input);
  } catch (e) {
    log.warn(`profile.serviceBindingJson is not valid JSON: ${e.message}`);
    return null;
  }
}

// ---- token fetch -----------------------------------------------------------

async function fetchXsuaaToken(creds) {
  const tokenUrl =
    trim(creds.tokenurl || creds.url || creds.uri || "") ||
    null;
  // For destination-service bindings the XSUAA endpoint is in `uaa.url` or `tokenurl`.
  let url = creds.uaa && creds.uaa.url ? trim(creds.uaa.url) + "/oauth/token" : null;
  if (!url) url = creds.tokenurl || (tokenUrl ? tokenUrl + "/oauth/token" : null);
  if (!url) throw new Error("Destination binding has no XSUAA token URL.");
  const clientid = (creds.uaa && creds.uaa.clientid) || creds.clientid;
  const clientsecret = (creds.uaa && creds.uaa.clientsecret) || creds.clientsecret;
  if (!clientid) throw new Error("Destination binding has no clientid.");
  log.step(`Requesting XSUAA token from ${url}`);
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " +
        Buffer.from(`${clientid}:${clientsecret || ""}`, "utf8").toString("base64"),
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`XSUAA token endpoint returned HTTP ${res.status}: ${truncate(text, 400)}`);
  }
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error("XSUAA response had no access_token.");
  return { token: json.access_token, expiresIn: Number(json.expires_in) || 3600 };
}

// ---- normalisation ---------------------------------------------------------

function normalizeLocalEnvDestination(d) {
  // Per docs: { name, url, username, password, ... }
  const additionalHeaders = collectExtra(d, "URL.headers.");
  const additionalQueries = collectExtra(d, "URL.queries.");
  let authHeader = null;
  if (d.username || d.password) {
    authHeader =
      "Basic " + Buffer.from(`${d.username || ""}:${d.password || ""}`, "utf8").toString("base64");
  }
  return {
    name: d.name,
    url: trim(d.url),
    authType: d.authentication || (authHeader ? "BasicAuthentication" : "NoAuthentication"),
    authHeader,
    forwardAuthToken: truthy(d.forwardAuthToken), //IYH1HC add
    sapClient: d["sap-client"] || null,
    language: d.language || null,
    additionalHeaders,
    additionalQueries,
    raw: d,
    source: "env",
  };
}

function normalizeServiceDestination(payload) {
  const dc = payload.destinationConfiguration || {};
  const tokens = Array.isArray(payload.authTokens) ? payload.authTokens : [];
  const firstToken = tokens.find((t) => t && t.http_header && t.http_header.value) || null;
  let authHeader = null;
  let authTokenExpiresIn = null;
  if (firstToken) {
    authHeader = firstToken.http_header.value;
    authTokenExpiresIn = Number(firstToken.expires_in) || null;
  } else if (
    (dc.Authentication || "").toLowerCase() === "basicauthentication" &&
    (dc.User || dc.Username)
  ) {
    authHeader =
      "Basic " +
      Buffer.from(
        `${dc.User || dc.Username || ""}:${dc.Password || ""}`,
        "utf8"
      ).toString("base64");
  }
  const additionalHeaders = collectExtra(dc, "URL.headers.");
  const additionalQueries = collectExtra(dc, "URL.queries.");
  // forwardAuthToken / HTML5.ForwardAuthToken: when set the user JWT is
  // forwarded as Authorization to the target system instead of using the
  // destination's own authentication. Anything but the literal "true" is
  // treated as false (matches the SDK behaviour).
  const fwd =
    truthy(dc.forwardAuthToken) || truthy(dc["HTML5.ForwardAuthToken"]) || false;
  return {
    name: dc.Name,
    url: trim(dc.URL),
    authType: dc.Authentication || "NoAuthentication",
    authHeader,
    forwardAuthToken: fwd,
    sapClient: dc["sap-client"] || null,
    language: dc.Language || null,
    additionalHeaders,
    additionalQueries,
    authTokenExpiresIn,
    raw: payload,
    source: "destination-service",
  };
}

function truthy(v) {
  if (v === true) return true;
  if (v == null) return false;
  return String(v).toLowerCase() === "true";
}

function collectExtra(obj, prefix) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = obj[k];
  }
  return out;
}

function cacheKey(name, opts) {
  const tenant =
    opts.iss ? subdomainFromIss(opts.iss) : opts.userJwt ? "user-jwt" : "provider";
  return `${name}@${tenant}`;
}

function subdomainFromIss(iss) {
  try {
    const u = new URL(iss);
    return u.hostname.split(".")[0];
  } catch {
    return "default";
  }
}

function trim(s) {
  return String(s || "").replace(/\/+$/, "");
}

function truncate(s, n) {
  s = String(s || "");
  return s.length <= n ? s : s.slice(0, n) + `...<+${s.length - n}>`;
}

function clearCache() {
  cache.clear();
}

// Enumerate destinations via the destination service (no per-destination
// secrets - just metadata). Returns subaccount + instance destinations,
// with `subscriber` filled in when an `iss` is provided.
async function listFromService(opts = {}) {
  const binding =
    parseServiceBinding(opts.serviceBindingJson) || findVcapDestinationBinding();
  if (!binding) {
    throw new Error(
      "No VCAP_SERVICES.destination binding (and no serviceBindingJson override). " +
        "Cannot enumerate via the destination service."
    );
  }
  const access = await fetchXsuaaToken(binding.credentials);
  const base = trim(binding.credentials.uri || binding.credentials.url);
  const headers = { Authorization: `Bearer ${access.token}` };
  if (opts.userJwt) headers["X-User-Token"] = opts.userJwt;

  const out = { subaccount: [], instance: [] };
  for (const ep of [
    { key: "subaccount", path: "/destination-configuration/v1/subaccountDestinations" },
    { key: "instance", path: "/destination-configuration/v1/instanceDestinations" },
  ]) {
    const res = await fetch(base + ep.path, { method: "GET", headers });
    const text = await res.text();
    if (!res.ok) {
      log.warn(`Destination service ${ep.path} returned HTTP ${res.status}: ${truncate(text, 200)}`);
      continue;
    }
    let arr;
    try {
      arr = JSON.parse(text);
    } catch (e) {
      log.warn(`Could not parse ${ep.path} response: ${e.message}`);
      continue;
    }
    out[ep.key] = (Array.isArray(arr) ? arr : []).map((d) => ({
      Name: d.Name,
      Type: d.Type,
      URL: d.URL,
      Authentication: d.Authentication,
      ProxyType: d.ProxyType,
      Description: d.Description,
    }));
  }
  return out;
}

module.exports = {
  resolveDestination,
  listFromService,
  clearCache,
  // for tests / inspection
  _internal: { normalizeServiceDestination, normalizeLocalEnvDestination },
};
