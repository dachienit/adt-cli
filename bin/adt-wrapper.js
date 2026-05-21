#!/usr/bin/env node

const { spawnSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { fetch: undiciFetch, ProxyAgent } = require('undici');
const config = require('../src/config');

// Read configuration directly from XSUAA Service Key (Bypass mcp-server completely)
const LOCAL_CALLBACK_PORT = 3099;
const TOKEN_FILE = path.join(os.homedir(), '.adt-cli', 'btp_sso_token.json');

const xsuaaKeyPath = path.join(__dirname, '..', 'xsuaa-key.json');
if (!fs.existsSync(xsuaaKeyPath)) {
  console.error("❌ [Wrapper] Missing xsuaa-key.json. Please download the Service Key for abap-mcp-xsuaa to the adt-cli directory.");
  process.exit(1);
}
const xsuaaKey = JSON.parse(fs.readFileSync(xsuaaKeyPath, 'utf8'));
const creds = xsuaaKey.credentials || xsuaaKey;
const XSUAA_URL = creds.url;
const CLIENT_ID = creds.clientid;
const CLIENT_SECRET = creds.clientsecret;

// Configure Corporate Proxy for Node.js fetch
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://rb-proxy-emea.bosch.com:8080';
const proxyDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

// 1. Read Token from local cache
function getValidToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (Date.now() < data.expiresAt) return data.access_token;
    } catch (e) {}
  }
  return null;
}

// 2. Save Token to local cache
function saveToken(tokenData) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Subtract 60 seconds as a buffer before the token actually expires
  tokenData.expiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData));
}

// 3. Browser flow for automatic SSO
async function acquireTokenViaBrowser() {
  return new Promise((resolve, reject) => {
    let server;
    const app = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${LOCAL_CALLBACK_PORT}`);
      if (url.pathname !== '/mcp-callback') { res.writeHead(404); res.end(); return; }
      
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400); res.end('No code received');
        server.close(); reject(new Error('No code received')); return;
      }

      try {
        const callbackUri = `http://localhost:${LOCAL_CALLBACK_PORT}/mcp-callback`;
        const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        
        const resp = await undiciFetch(`${XSUAA_URL}/oauth/token`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${auth}`
          },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUri }).toString(),
          dispatcher: proxyDispatcher
        });
        
        if (!resp.ok) throw new Error(await resp.text());
        
        const tokenData = await resp.json();
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html style="font-family:sans-serif;text-align:center;padding:50px"><h2 style="color:green">✅ BTP Login Successful!</h2><p>Return to your terminal.</p><script>setTimeout(()=>window.close(),2000)</script></html>');
        server.close(); resolve(tokenData);
      } catch (err) {
        res.writeHead(500); res.end(err.message);
        server.close(); reject(err);
      }
    });

    server = app.listen(LOCAL_CALLBACK_PORT, () => {
      const callbackUri = `http://localhost:${LOCAL_CALLBACK_PORT}/mcp-callback`;
      const authUrl = `${XSUAA_URL}/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(callbackUri)}`;
      console.error(`[Wrapper] Opening browser for BTP SSO login...`);
      const cmd = process.platform === 'win32' ? `start "" "${authUrl}"` : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
      exec(cmd);
    });
  });
}

(async () => {
  // Prioritize environment variable, then read from local cache
  let token = process.env.ADT_SSO_TOKEN || getValidToken();

  if (!token) {
    try {
      const tokenData = await acquireTokenViaBrowser();
      saveToken(tokenData);
      token = tokenData.access_token;
      console.error(`[Wrapper] Successfully fetched and cached SSO Token.`);
    } catch (err) {
      console.error(`❌ [Wrapper] SSO Login failed:`, err.message);
      process.exit(1);
    }
  }

/*   // Automatically update the active profile with the latest token.
  // This makes the profile self-contained, especially for the 'destination' kind.
  try {
    const currentConfig = config.load();
    const profileName = process.env.ADT_PROFILE || currentConfig.defaultProfile;
    if (profileName && currentConfig.profiles[profileName]) {
      console.error(`[Wrapper] Updating active profile "${profileName}" with the latest userJwt.`);
      config.updateProfile(profileName, { userJwt: token });
    }
  } catch (e) {
    console.error(`[Wrapper] Warning: Could not update profile with token: ${e.message}`);
  } */

  // Attach token and call the original adt command
  const env = { ...process.env, ADT_BEARER: token, ADT_USER_JWT: token };
  const args = process.argv.slice(2);
  const adtScript = path.join(__dirname, 'adt.js');

  const result = spawnSync(process.execPath, [adtScript, ...args], { stdio: 'inherit', env: env });
  process.exit(result.status !== null ? result.status : 1);
})();