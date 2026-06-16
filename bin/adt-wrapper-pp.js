#!/usr/bin/env node
"use strict";

// Standalone connectivity test for BTP PrincipalPropagation → Cloud Connector → on-prem ABAP.
//
// Usage:
//   node bin/adt-wrapper-pp.js --destination <DEST_NAME> [--test-path /sap/bc/adt/discovery]
//   ADT_SSO_TOKEN=<jwt> node bin/adt-wrapper-pp.js --destination <DEST_NAME>
//
// Requires (in adt-cli root):
//   xsuaa-key.json  — XSUAA service key (for user SSO)
//   conn-key.json   — Connectivity service key (proxy host + client_credentials)
//   dest-key.json   — Destination service key (API endpoint + client_credentials)
//
// Does NOT modify any existing file. Uses per-request undici dispatcher so the
// corporate proxy and the connectivity proxy are used independently per call type.

const fs   = require("fs");
const path = require("path");
const http = require("http");
const os   = require("os");
const { exec } = require("child_process");
const { fetch: undiciFetch, ProxyAgent } = require("undici");

// ── Constants ────────────────────────────────────────────────────────────────

const LOCAL_CALLBACK_PORT = 3099;
const TOKEN_CACHE_FILE    = path.join(os.homedir(), ".adt-cli", "btp_sso_token.json");
const CORP_PROXY_URL      = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
                            || "http://rb-proxy-emea.bosch.com:8080";

// ── Key file helpers ──────────────────────────────────────────────────────────

function readKey(filename) {
  const keyPath = path.join(__dirname, "..", filename);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Missing ${filename}. Download the service key to the adt-cli directory.`);
  }
  const raw = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  return raw.credentials || raw;
}

// ── Token cache ───────────────────────────────────────────────────────────────

function getValidToken(cacheFile) {
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (Date.now() < data.expiresAt) return data.access_token;
  } catch (_) {}
  return null;
}

function saveToken(cacheFile, tokenData) {
  const dir = path.dirname(cacheFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  tokenData.expiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;
  fs.writeFileSync(cacheFile, JSON.stringify(tokenData));
}

// ── Browser SSO (authorization_code grant) ────────────────────────────────────

function acquireTokenViaBrowser(creds, proxyDispatcher) {
  return new Promise((resolve, reject) => {
    let server;
    const app = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${LOCAL_CALLBACK_PORT}`);
      if (url.pathname !== "/mcp-callback") { res.writeHead(404); res.end(); return; }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400); res.end("No code received");
        server.close(); reject(new Error("No auth code received")); return;
      }

      try {
        const callbackUri = `http://localhost:${LOCAL_CALLBACK_PORT}/mcp-callback`;
        const auth = Buffer.from(`${creds.clientid}:${creds.clientsecret}`).toString("base64");
        const resp = await undiciFetch(`${creds.url}/oauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": `Basic ${auth}`,
          },
          body: new URLSearchParams({
            grant_type:   "authorization_code",
            code,
            redirect_uri: callbackUri,
          }).toString(),
          dispatcher: proxyDispatcher,
        });
        if (!resp.ok) throw new Error(await resp.text());
        const tokenData = await resp.json();
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html style=\"font-family:sans-serif;text-align:center;padding:50px\">" +
          "<h2 style=\"color:green\">&#x2705; BTP Login Successful!</h2>" +
          "<p>Return to your terminal.</p>" +
          "<script>setTimeout(()=>window.close(),2000)</script></html>"
        );
        server.close();
        resolve(tokenData);
      } catch (err) {
        res.writeHead(500); res.end(err.message);
        server.close(); reject(err);
      }
    });

    server = app.listen(LOCAL_CALLBACK_PORT, () => {
      const callbackUri = `http://localhost:${LOCAL_CALLBACK_PORT}/mcp-callback`;
      const authUrl =
        `${creds.url}/oauth/authorize` +
        `?response_type=code` +
        `&client_id=${encodeURIComponent(creds.clientid)}` +
        `&redirect_uri=${encodeURIComponent(callbackUri)}`;

      console.error("[PP-Wrapper] Opening browser for BTP SSO login...");
      const cmd = process.platform === "win32"
        ? `start "" "${authUrl}"`
        : process.platform === "darwin"
          ? `open "${authUrl}"`
          : `xdg-open "${authUrl}"`;
      exec(cmd);
    });
  });
}

// ── Generic client_credentials token fetch ────────────────────────────────────

async function fetchClientCredentials(tokenUrl, clientId, clientSecret, proxyDispatcher) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const resp = await undiciFetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${auth}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    dispatcher: proxyDispatcher,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token request failed (${resp.status}): ${body}`);
  }
  return resp.json();
}

// ── Destination service resolution ────────────────────────────────────────────

async function resolveDestination(destCreds, destName, userJwt, xsuaaToken, proxyDispatcher) {
  const url =
    `${destCreds.uri}/destination-configuration/v1/destinations/` +
    encodeURIComponent(destName);

  const resp = await undiciFetch(url, {
    headers: {
      "Authorization": `Bearer ${xsuaaToken}`,
      "X-User-Token":  userJwt,
    },
    dispatcher: proxyDispatcher,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Destination service error (${resp.status}): ${body}`);
  }

  const payload = await resp.json();
  const config  = payload.destinationConfiguration || {};

  // For CC-PrincipalPropagation, authTokens is empty by design.
  // The SAML assertion is generated by Cloud Connector via SAP-Connectivity-Authentication header.
  return {
    virtualUrl: (config.URL || "").replace(/\/$/, ""),
    authType:   config.Authentication,
    sapClient:  config["sap-client"] || null,
  };
}

// ── Argument parsing ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    destination: null,
    routerUrl:   null,
    testPath:    "/sap/bc/adt/discovery",
    exec:        false,
  };
  for (let i = 0; i < args.length; i++) {
    if      (args[i] === "--destination" && args[i + 1]) opts.destination = args[++i];
    else if (args[i] === "--router-url"  && args[i + 1]) opts.routerUrl   = args[++i];
    else if (args[i] === "--test-path"   && args[i + 1]) opts.testPath    = args[++i];
    else if (args[i] === "--exec")                        opts.exec        = true;
  }
  if (!opts.destination && !opts.routerUrl && !opts.exec) {
    console.error(
      "Usage:\n" +
      "  # Test connectivity via AppRouter:\n" +
      "  node bin/adt-wrapper-pp.js --router-url <APPROUTER_URL> [--test-path <path>]\n\n" +
      "  # Run any adt-cli command (SSO + proxy injected automatically):\n" +
      "  node bin/adt-wrapper-pp.js --exec [adt-cli args...]\n" +
      "  node bin/adt-wrapper-pp.js --exec discovery\n" +
      "  node bin/adt-wrapper-pp.js --exec objects list --package '$TMP'\n\n" +
      "  # Direct mode (requires CF SSH tunnel for local use):\n" +
      "  node bin/adt-wrapper-pp.js --destination <DEST_NAME> [--test-path <path>]\n\n" +
      "Options:\n" +
      "  --exec         spawn adt.js with BTP SSO token + corporate proxy\n" +
      "  --router-url   AppRouter URL, e.g. https://adt-cli-router.cfapps.ap11.hana.ondemand.com\n" +
      "  --destination  BTP destination name (direct mode)\n" +
      "  --test-path    ADT path to probe, default /sap/bc/adt/discovery\n\n" +
      "Env vars:\n" +
      "  ADT_SSO_TOKEN  bypass browser login with an existing user JWT\n" +
      "  HTTPS_PROXY    override corporate proxy (default: rb-proxy-emea.bosch.com:8080)"
    );
    process.exit(1);
  }
  return opts;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const opts      = parseArgs(process.argv);
  const corpProxy = new ProxyAgent(CORP_PROXY_URL);

  // ── Step 1: Read XSUAA key (always needed for SSO) ────────────────────────
  console.error("[PP-Wrapper] Reading XSUAA service key...");
  let xsuaaCreds;
  try {
    xsuaaCreds = readKey("xsuaa-key.json");
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  // ── Step 2: User JWT via SSO ───────────────────────────────────────────────
  let userJwt = process.env.ADT_SSO_TOKEN || getValidToken(TOKEN_CACHE_FILE);
  if (!userJwt) {
    console.error("[PP-Wrapper] No cached SSO token — opening browser...");
    try {
      const tokenData = await acquireTokenViaBrowser(xsuaaCreds, corpProxy);
      saveToken(TOKEN_CACHE_FILE, tokenData);
      userJwt = tokenData.access_token;
      console.error("[PP-Wrapper] ✅ SSO login successful, token cached.");
    } catch (e) {
      console.error(`❌ SSO login failed: ${e.message}`);
      process.exit(1);
    }
  } else {
    console.error("[PP-Wrapper] ✅ Using cached SSO token.");
  }

  // ── Exec mode — spawn adt.js with SSO token + proxy ───────────────────────
  if (opts.exec) {
    const { spawnSync } = require("child_process");
    const config        = require("../src/config");
    const adtScript     = path.join(__dirname, "adt.js");
    const execIdx       = process.argv.indexOf("--exec");
    const adtArgs       = process.argv.slice(execIdx + 1);

    const cfg         = config.load();
    const profileName = process.env.ADT_PROFILE || cfg.defaultProfile;
    const profile     = config.getProfile(profileName);

    const env = { ...process.env, HTTPS_PROXY: CORP_PROXY_URL };

    if (profile && profile.kind === "destination" && opts.routerUrl) {
      const patch = {
        userJwt: userJwt,
        url:     opts.routerUrl.replace(/\/$/, ""),
      };
      const destKeyPath = path.join(__dirname, "..", "dest-key.json");
      if (fs.existsSync(destKeyPath)) {
        patch.serviceBindingJson = fs.readFileSync(destKeyPath, "utf8");
      }
      config.updateProfile(profileName, patch);
      env.destinations = JSON.stringify([{
        name:             profile.destinationName,
        url:              opts.routerUrl.replace(/\/$/, ""),
        forwardAuthToken: true,
      }]);
      console.error(`[PP-Wrapper] Exec (destination → AppRouter): node adt.js ${adtArgs.join(" ")}`);
    } else {
      console.error(`[PP-Wrapper] Exec (ADT_BEARER): node adt.js ${adtArgs.join(" ")}`);
    }

    // Attach token and call the original adt command
    env.ADT_BEARER   = userJwt;
    env.ADT_USER_JWT = userJwt;
    const result = spawnSync(process.execPath, [adtScript, ...adtArgs], { stdio: "inherit", env });
    process.exit(result.status !== null ? result.status : 1);
  }

  // ── AppRouter mode ─────────────────────────────────────────────────────────
  if (opts.routerUrl) {
    const routerUrl = opts.routerUrl.replace(/\/$/, "");
    const testUrl   = `${routerUrl}${opts.testPath}`;
    console.error(`[PP-Wrapper] Mode: AppRouter`);
    console.error(`[PP-Wrapper] → ${testUrl}`);

    try {
      const resp = await undiciFetch(testUrl, {
        headers: {
          "Authorization":    `Bearer ${userJwt}`,
          "Accept":           "application/atomsvc+xml",
          "x-csrf-token":     "fetch",
          "X-Requested-With": "XMLHttpRequest",
        },
        dispatcher: corpProxy,
      });

      const body = await resp.text();

      if (resp.ok) {
        console.log(`\n✅ HTTP ${resp.status} — PrincipalPropagation via AppRouter OK`);
        console.log(`   Router URL:   ${routerUrl}`);
        console.log(`   Test path:    ${opts.testPath}`);
        console.log(`   x-csrf-token: ${resp.headers.get("x-csrf-token") || "(none)"}`);
        console.log(`   content-type: ${resp.headers.get("content-type") || "(none)"}`);
        const preview = body.length <= 600 ? body : body.slice(0, 600) + "\n...[truncated]";
        console.log(`\n${preview}`);
      } else {
        console.error(`\n❌ HTTP ${resp.status} ${resp.statusText}`);
        console.error(body.slice(0, 800));
        if (resp.status === 401 || resp.status === 403) {
          console.error("\n💡 Auth error — check:");
          console.error("   - Is the AppRouter bound to abap-mcp-xsuaa with your user's tenant?");
          console.error("   - Does xs-app.json route /sap/bc/adt/* to T4X_011?");
          console.error("   - Is T4X_011 configured with Authentication: PrincipalPropagation?");
          console.error("   - Does the on-prem ABAP user match the BTP user attribute?");
        }
        process.exitCode = 2;
      }
    } catch (e) {
      console.error(`\n❌ Request failed: ${e.message}`);
      console.error("\n💡 Network error — check:");
      console.error(`   - Is ${routerUrl} reachable? (try opening it in a browser)`);
      console.error("   - Is your corporate proxy configured? (HTTPS_PROXY env var)");
      console.error("   - Is the adt-cli-router app running? (cf apps)");
      process.exitCode = 1;
    }
    return;
  }

  // ── Direct mode (requires connectivity proxy access) ───────────────────────
  console.error("[PP-Wrapper] Mode: Direct (via BTP Connectivity Service proxy)");

  let connCreds, destCreds;
  try {
    connCreds = readKey("conn-key.json");
    destCreds = readKey("dest-key.json");
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const proxyHost = connCreds.onpremise_proxy_host;
  const proxyPort = connCreds.onpremise_proxy_http_port;
  if (!proxyHost || !proxyPort) {
    console.error("❌ conn-key.json is missing onpremise_proxy_host or onpremise_proxy_http_port.");
    process.exit(1);
  }

  // ── Step 3: Connectivity Service token ────────────────────────────────────
  console.error("[PP-Wrapper] Fetching Connectivity Service token...");
  let connectivityToken;
  try {
    const td = await fetchClientCredentials(
      `${connCreds.url}/oauth/token`,
      connCreds.clientid,
      connCreds.clientsecret,
      corpProxy
    );
    connectivityToken = td.access_token;
    console.error("[PP-Wrapper] ✅ Connectivity token acquired.");
  } catch (e) {
    console.error(`❌ Connectivity token failed: ${e.message}`);
    process.exit(1);
  }

  // ── Step 4: Destination XSUAA token ───────────────────────────────────────
  console.error("[PP-Wrapper] Fetching Destination Service XSUAA token...");
  let destXsuaaToken;
  try {
    const td = await fetchClientCredentials(
      `${destCreds.url}/oauth/token`,
      destCreds.clientid,
      destCreds.clientsecret,
      corpProxy
    );
    destXsuaaToken = td.access_token;
    console.error("[PP-Wrapper] ✅ Destination XSUAA token acquired.");
  } catch (e) {
    console.error(`❌ Destination XSUAA token failed: ${e.message}`);
    process.exit(1);
  }

  // ── Step 5: Resolve destination with X-User-Token ─────────────────────────
  console.error(`[PP-Wrapper] Resolving destination "${opts.destination}" with X-User-Token...`);
  let dest;
  try {
    dest = await resolveDestination(destCreds, opts.destination, userJwt, destXsuaaToken, corpProxy);
    console.error(`[PP-Wrapper] ✅ Destination resolved: ${dest.virtualUrl} (authType: ${dest.authType})`);
  } catch (e) {
    console.error(`❌ Destination resolution failed: ${e.message}`);
    process.exit(1);
  }

  if (!dest.virtualUrl) {
    console.error("❌ Destination has no URL configured.");
    process.exit(2);
  }

  // ── Step 6: Test ABAP request via Connectivity proxy ──────────────────────
  const testUrl = `${dest.virtualUrl}${opts.testPath}`;
  console.error(`[PP-Wrapper] Testing via Connectivity proxy ${proxyHost}:${proxyPort}`);
  console.error(`[PP-Wrapper] → ${testUrl}`);

  const connProxy = new ProxyAgent({
    uri:   `http://${proxyHost}:${proxyPort}`,
    token: `Bearer ${connectivityToken}`,
  });

  const reqHeaders = {
    "SAP-Connectivity-Authentication": `Bearer ${userJwt}`,
    "Accept":           "application/atomsvc+xml",
    "x-csrf-token":     "fetch",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (dest.sapClient) reqHeaders["sap-client"] = dest.sapClient;

  try {
    const resp = await undiciFetch(testUrl, {
      headers:    reqHeaders,
      dispatcher: connProxy,
    });

    const body = await resp.text();

    if (resp.ok) {
      console.log(`\n✅ HTTP ${resp.status} — PrincipalPropagation flow OK`);
      console.log(`   URL:          ${testUrl}`);
      console.log(`   x-csrf-token: ${resp.headers.get("x-csrf-token") || "(none)"}`);
      console.log(`   content-type: ${resp.headers.get("content-type") || "(none)"}`);
      console.log(`   auth-type:    ${dest.authType}`);
      if (dest.sapClient) console.log(`   sap-client:   ${dest.sapClient}`);
      const preview = body.length <= 600 ? body : body.slice(0, 600) + "\n...[truncated]";
      console.log(`\n${preview}`);
    } else {
      console.error(`\n❌ HTTP ${resp.status} ${resp.statusText}`);
      console.error(body.slice(0, 800));
      if (resp.status === 401 || resp.status === 403) {
        console.error("\n💡 Auth error — check:");
        console.error("   - SubjectNameIdAttribute in destination matches user logon in on-prem ABAP");
        console.error("   - Trust config in Cloud Connector for BTP subaccount");
        console.error("   - ICF/ICM principal propagation profile active in ABAP system");
        console.error("   - User exists in on-prem with same ID as BTP user attribute");
      }
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`\n❌ Request failed: ${e.message}`);
    console.error("\n💡 Network/proxy error — check:");
    console.error(`   - Is ${proxyHost}:${proxyPort} reachable from your machine?`);
    console.error("   - Are you on the correct VPN / corporate network?");
    console.error("   - Does your corporate proxy allow connecting to SAP BTP connectivity endpoints?");
    console.error("   - If running locally: use CF SSH tunnel or --router-url mode instead");
    process.exitCode = 1;
  }
})();
