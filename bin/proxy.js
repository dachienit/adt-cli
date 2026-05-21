/* const fs = require('fs');
const path = require('path');
const { setGlobalDispatcher, ProxyAgent, fetch: undiciFetch } = require('undici');

// 1. Cấu hình Bosch Proxy cho mọi request ra ngoài Internet (Lấy token BTP)
const boschProxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://rb-proxy-emea.bosch.com:8080';
const boschDispatcher = new ProxyAgent(boschProxyUrl);
setGlobalDispatcher(boschDispatcher); 

// 2. Hàm lấy token của Connectivity Service
let connToken = null;
async function getConnectivityToken() {
  if (connToken) return connToken;
  
  const connKeyPath = path.join(__dirname, '..', 'conn-key.json');
  if (!fs.existsSync(connKeyPath)) return null;

  const key = JSON.parse(fs.readFileSync(connKeyPath, 'utf8')).credentials;
  const auth = Buffer.from(`${key.clientid}:${key.clientsecret}`).toString('base64');
  
  const res = await undiciFetch(`${key.url}/oauth/token?grant_type=client_credentials`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}` },
    dispatcher: boschDispatcher
  });
  
  if (!res.ok) throw new Error('Không lấy được Connectivity Token: ' + res.status);
  const data = await res.json();
  connToken = data.access_token;
  return connToken;
}

// 3. Dispatcher trỏ vào đường hầm SSH (sẽ nối tới Connectivity Proxy)
const btpTunnelDispatcher = new ProxyAgent('http://localhost:20003');

// 4. Trạm thu phí: Ghi đè global fetch để rẽ nhánh request
const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const urlStr = url.toString();
  
  // Nếu đích đến là SAP On-Premise (không qua Internet)
  if (urlStr.includes('t4x-https-sso') || !urlStr.includes('hana.ondemand.com')) {
    const token = await getConnectivityToken();
    options.dispatcher = btpTunnelDispatcher;
    options.headers = { ...options.headers, 'Proxy-Authorization': `Bearer ${token}` };
  }
  return originalFetch(url, options);
}; */