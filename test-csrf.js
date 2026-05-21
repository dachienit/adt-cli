const { fetch, ProxyAgent, setGlobalDispatcher } = require('undici');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 1. Cấu hình Proxy
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://rb-proxy-emea.bosch.com:8080';
if (proxyUrl) {
    console.log(`[Proxy] Sử dụng: ${proxyUrl}`);
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

// 2. Lấy Token từ file cache
const TOKEN_FILE = path.join(os.homedir(), '.adt-cli', 'btp_sso_token.json');
let token = null;
if (fs.existsSync(TOKEN_FILE)) {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    token = data.access_token;
    console.log(`[Token] Đã lấy token, độ dài: ${token.length} ký tự`);
} else {
    console.error("❌ Không tìm thấy file token! Hãy chạy adt-wrapper.js trước để lấy token.");
    process.exit(1);
}

// 3. Target URL
const url = "https://adt-cli-router.cfapps.ap11.hana.ondemand.com/sap/bc/adt/discovery?sap-client=011";

async function testCsrf() {
    const headers = {
        'Accept': 'application/atomsvc+xml',
        'x-csrf-token': 'fetch',
        'Authorization': `Bearer ${token}`,
        'X-Requested-With': 'XMLHttpRequest'
    };

    console.log(`\n▶ Đang gọi GET ${url}`);
    console.log(`▶ Headers gửi đi:`, JSON.stringify({ ...headers, 'Authorization': 'Bearer <redacted>' }, null, 2));

    try {
        const res = await fetch(url, { method: 'GET', headers });
        console.log(`\n◀ Status trả về: ${res.status} ${res.statusText}`);
        
        const resHeaders = {};
        res.headers.forEach((v, k) => resHeaders[k] = v);
        console.log(`◀ Headers trả về:`, JSON.stringify(resHeaders, null, 2));
        
        const body = await res.text();
        console.log(`\n◀ Body trả về:\n${body.substring(0, 1000)}`);
    } catch (e) {
        console.error("Lỗi:", e);
    }
}

testCsrf();