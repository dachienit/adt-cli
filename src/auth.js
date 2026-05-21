"use strict";

// Authentication helpers.
// Supports two flows:
//   - "basic":  user + password     -> Authorization: Basic <base64(user:password)>
//   - "oauth":  refresh_token grant -> Authorization: Bearer <access_token>
//
// OAuth flow mirrors restcalls/cloud.http: POST {loginUrl}/oauth/token with
// grant_type=refresh_token, Authorization: Basic <clientId:clientSecret>.
// We cache the access_token in the profile and only refresh when expired.

const log = require("./logger");
const config = require("./config");
const destinations = require("./destinations");

function basicAuthHeader(user, password) {
  const tok = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
  return `Basic ${tok}`;
}

async function refreshAccessToken(profile) {
  if (!profile.loginUrl) throw new Error('Profile is OAuth but has no "loginUrl".');
  if (!profile.clientId) throw new Error('Profile is OAuth but has no "clientId".');
  if (!profile.refreshToken) throw new Error('Profile is OAuth but has no "refreshToken".');

  const tokenUrl = profile.loginUrl.replace(/\/+$/, "") + "/oauth/token";
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: profile.refreshToken,
  });
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: basicAuthHeader(profile.clientId, profile.clientSecret || ""),
  };

  log.step(`Refreshing OAuth token from ${tokenUrl}`);
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: params.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    log.err(`OAuth refresh failed (${res.status}): ${text}`);
    throw new Error(`OAuth refresh failed: ${res.status} ${res.statusText}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`OAuth response was not JSON: ${text.slice(0, 200)}`);
  }
  if (!json.access_token) throw new Error("OAuth response had no access_token.");

  const expSec = Number(json.expires_in) || 3600;
  const expiresAt = Date.now() + (expSec - 30) * 1000; // 30s safety margin

  // Persist updated tokens.
  config.updateProfile(profile.name, {
    accessToken: json.access_token,
    tokenExpiresAt: expiresAt,
    // Some IdPs rotate refresh tokens; honor that.
    ...(json.refresh_token ? { refreshToken: encodeRefresh(json.refresh_token) } : {}),
  });

  // Mutate the in-memory profile too so the caller sees the new values.
  profile.accessToken = json.access_token;
  profile.tokenExpiresAt = expiresAt;
  log.ok(`OAuth token refreshed; expires in ${expSec}s.`);
  return json.access_token;
}

// Encode a refresh token the way config.setProfile would.
// We bypass setProfile (which expects a profile patch) when called from refresh.
function encodeRefresh(rt) {
  return "b64:" + Buffer.from(String(rt), "utf8").toString("base64");
}

async function headerFor(profile) {
  if (!profile) return null;

  // Explicit env override beats everything (handy for CI / agents).
  //if (process.env.ADT_BEARER) return `bearer ${process.env.ADT_BEARER}`; IYH1HC comment
  if (process.env.ADT_BEARER) return `Bearer ${process.env.ADT_BEARER}`; // IYH1HC added
  if (process.env.ADT_BASIC) return `Basic ${process.env.ADT_BASIC}`;

  const kind = (profile.kind || "basic").toLowerCase();
  if (kind === "basic") {
    if (!profile.user) throw new Error('Basic profile needs "user".');
    if (profile.password == null) throw new Error('Basic profile needs "password".');
    return basicAuthHeader(profile.user, profile.password);
  }
  if (kind === "oauth") {
    const stillFresh = profile.accessToken && profile.tokenExpiresAt && profile.tokenExpiresAt > Date.now();
    if (!stillFresh) {
      await refreshAccessToken(profile);
    }
    return `bearer ${profile.accessToken}`;
  }
  if (kind === "destination") {
    if (!profile.destinationName)
      throw new Error('Destination profile needs "destinationName".');
    const rec = await destinations.resolveDestination(profile.destinationName, {
      iss: profile.iss,
      userJwt: profile.userJwt,
      serviceBindingJson: profile.serviceBindingJson,
    });
    // Materialize the resolved destination on the in-memory profile so the
    // AdtClient can build absolute URLs and apply additional headers/queries.
    if (!profile.url) profile.url = rec.url;
    if (!profile.client && rec.sapClient) profile.client = rec.sapClient;
    if (!profile.language && rec.language) profile.language = rec.language;
    profile._destination = rec;
    // forwardAuthToken: target system gets the user JWT as Authorization,
    // not the destination's own auth. Only meaningful with NoAuthentication
    // (per the SDK docs) but we still honour the property if it's set.
    if (rec.forwardAuthToken) {
      if (!profile.userJwt) {
        log.warn(
          `Destination "${rec.name}" has forwardAuthToken=true but no user JWT was supplied ` +
            "(--user-jwt or ADT_USER_JWT). Sending request without Authorization."
        );
        return null;
      }
      return `Bearer ${profile.userJwt}`;
    }
    return rec.authHeader || null;
  }
  throw new Error(`Unknown profile kind: ${profile.kind}`);
}

module.exports = { headerFor, basicAuthHeader, refreshAccessToken };
