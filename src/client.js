"use strict";

// Thin HTTP client around Node 18+ global fetch.
// Responsibilities:
//   * Build request URLs from a profile base URL.
//   * Inject Authorization header (basic / bearer).
//   * Track cookies across calls for stateful ADT scenarios.
//   * Manage CSRF token: fetch on demand and re-use until invalidated (HTTP 403).
//   * Honor sap-client / sap-language defaults from the profile.
//   * Verbose logging compatible with --verbose / --debug.
//
// The client is intentionally low-level. Each command file knows the SAP
// content types it needs and asks the client to apply them.

const https = require("https");
const log = require("./logger");
const xml = require("./xml");
const auth = require("./auth");
const config = require("./config"); //basic SSO add — persist/reuse the basicsso MYSAPSSO2 ticket on the profile

class AdtClient {
  constructor(profile, options = {}) {
    if (!profile) throw new Error("AdtClient: profile is required.");
    if (!profile.url && (profile.kind || "basic").toLowerCase() !== "destination") {
      throw new Error('AdtClient: profile.url is required (e.g. "https://host:port").');
    }
    this.profile = profile;
    this.cookies = new Map(); // name -> value
    this.csrfToken = null;
    this.insecure = profile.insecure === true || options.insecure === true;
    this.userAgent = options.userAgent || "adt-cli/0.1.0";
    // ADT session mode controls X-sap-adt-sessiontype.
    // "stateless" (default) is fine for reads; "stateful" is required for
    // lock/setSource/delete sequences so that the server keeps the lock
    // associated with our session.
    this.session = "stateless";
    if (this.insecure) {
      // Note: native fetch in Node 18+ honors NODE_TLS_REJECT_UNAUTHORIZED
      // as a process-wide knob; for a per-client agent we'd need undici.
      // To keep deps minimal we toggle the env flag while this client lives.
      this._restoreTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      this._agent = new https.Agent({ rejectUnauthorized: false });
    }

    this._loadedSso = null;
    if (
      (profile.kind || "").toLowerCase() === "basicsso" &&
      profile.ssoToken &&
      profile.name &&
      (!profile.ssoUser || profile.ssoUser === currentOsUser())
    ) {
      this.cookies.set("MYSAPSSO2", profile.ssoToken);
      this._loadedSso = profile.ssoToken;
      log.debug("Reusing stored SSO ticket (skipping SPNEGO unless rejected).");
    }
  }

  _persistSsoIfChanged() {
    if ((this.profile.kind || "").toLowerCase() !== "basicsso" || !this.profile.name) return;
    const tok = this.cookies.get("MYSAPSSO2");
    if (tok && tok !== this._loadedSso) {
      try {
        config.saveSsoTicket(this.profile.name, currentOsUser(), tok);
        this._loadedSso = tok;
        log.debug("SSO ticket saved to profile for reuse.");
      } catch (e) {
        log.debug(`Could not persist SSO ticket: ${e.message}`);
      }
    }
  }

  _doFetch(url, opts) {
    if (this._dispatcher) {
      return this._undici.fetch(url, { ...opts, dispatcher: this._dispatcher });
    }
    return fetch(url, opts);
  }

  setStateful(stateful) {
    this.session = stateful ? "stateful" : "stateless";
    return this;
  }

  // Build absolute URL from a path, preserving query strings and adding sap-client / sap-language.
  // Also folds in any "URL.queries.<name>" entries discovered on a destination.
  buildUrl(pathOrUrl) {
    let u;
    if (/^https?:\/\//i.test(pathOrUrl)) {
      u = new URL(pathOrUrl);
    } else {
      if (!this.profile.url) {
        throw new Error(
          "Profile has no url. For a destination profile, the URL is resolved on the first request - " +
            "make sure auth.headerFor() ran (or call client.send/request rather than buildUrl directly)."
        );
      }
      const base = this.profile.url.replace(/\/+$/, "");
      const p = pathOrUrl.startsWith("/") ? pathOrUrl : "/" + pathOrUrl;
      u = new URL(base + p);
    }
    if (this.profile.client && !u.searchParams.has("sap-client")) {
      u.searchParams.set("sap-client", this.profile.client);
    }
    if (this.profile.language && !u.searchParams.has("sap-language")) {
      u.searchParams.set("sap-language", this.profile.language);
    }
    // Destination-supplied URL.queries.<key> = value (lowest precedence).
    const dest = this.profile._destination;
    if (dest && dest.additionalQueries) {
      for (const [k, v] of Object.entries(dest.additionalQueries)) {
        if (!u.searchParams.has(k)) u.searchParams.set(k, String(v));
      }
    }
    return u;
  }

  cookieHeader() {
    if (this.cookies.size === 0) return null;
    const parts = [];
    for (const [k, v] of this.cookies.entries()) parts.push(`${k}=${v}`);
    return parts.join("; ");
  }

  storeSetCookies(headers) {
    // headers may be a Headers object (from fetch) or a plain object.
    let raw = [];
    if (headers && typeof headers.getSetCookie === "function") {
      raw = headers.getSetCookie();
    } else if (headers && typeof headers.raw === "function") {
      raw = headers.raw()["set-cookie"] || [];
    } else if (headers && headers["set-cookie"]) {
      raw = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"]];
    }
    for (const line of raw) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === "" || value === "deleted") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  // Ensure we have a CSRF token. SAP requires one for any non-idempotent request.
  async ensureCsrf(force = false) {
    if (this.csrfToken && !force) return this.csrfToken;
    log.step("Fetching CSRF token from /sap/bc/adt/discovery");
    const res = await this.request("GET", "/sap/bc/adt/discovery", {
      headers: {
        Accept: "application/atomsvc+xml",
        "x-csrf-token": "fetch",
      },
      _internalSkipCsrf: true,
    });
    const tok = res.headers.get ? res.headers.get("x-csrf-token") : res.headers["x-csrf-token"];
    if (!tok) {
      log.warn("Server returned no x-csrf-token. Some requests may fail.");
    } else {
      this.csrfToken = tok;
      log.debug(`CSRF token acquired (${tok.length} chars).`);
    }
    return this.csrfToken;
  }

  async authHeader() {
    return await auth.headerFor(this.profile);
  }

  async request(method, pathOrUrl, options = {}) {
    // For destination-kind profiles the URL is unknown until auth runs once
    // (the destination service is what tells us where the target lives).
    if (!this.profile.url) {
      const ah = await this.authHeader();
      // Authorization will be set below; just trigger materialization.
      if (ah) options = { ...options, _preResolvedAuth: ah };
    }
    const url = this.buildUrl(pathOrUrl);
    const isMutating = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());

    const headers = new Headers();
    headers.set("User-Agent", this.userAgent);
    headers.set("X-Requested-With", "XMLHttpRequest");
    // Default Accept follows the reference TS client (AdtHTTP.ts:313).
    // Some ADT endpoints emit niche MIME types (e.g. application/vnd.sap.as+xml)
    // and reject narrower Accept headers with HTTP 406.
    headers.set("Accept", options.headers?.Accept || options.accept || "*/*");

    // Caller-provided headers win, except for Authorization which we always control
    // unless the caller explicitly sets it (e.g. raw request command).
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        if (v == null) continue;
        headers.set(k, String(v));
      }
    }

    if (!headers.has("Authorization")) {
      const ah = options._preResolvedAuth || (await this.authHeader());
      if (ah) headers.set("Authorization", ah);
    }

    // Destination-supplied URL.headers.<name> (lower precedence than caller).
    const dest = this.profile._destination;
    if (dest && dest.additionalHeaders) {
      for (const [k, v] of Object.entries(dest.additionalHeaders)) {
        if (!headers.has(k)) headers.set(k, String(v));
      }
    }

    // Honor the active session mode unless the caller has set it explicitly.
    if (!headers.has("X-sap-adt-sessiontype")) {
      headers.set("X-sap-adt-sessiontype", this.session);
    }

    if (isMutating && !options._internalSkipCsrf) {
      const tok = await this.ensureCsrf(false);
      if (tok && !headers.has("x-csrf-token")) headers.set("x-csrf-token", tok);
    }

    // Set cookie AFTER ensureCsrf might have populated it.
    const ck = this.cookieHeader();
    if (ck) headers.set("Cookie", ck);

    if (options.body != null && !headers.has("Content-Type")) {
      // Best-effort default - JSON body -> json, string -> text/plain.
      if (typeof options.body === "object" && !Buffer.isBuffer(options.body)) {
        headers.set("Content-Type", "application/json");
      } else {
        headers.set("Content-Type", "text/plain;charset=utf-8");
      }
    }

    let body = options.body;
    if (body != null && typeof body === "object" && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
    }

    log.http(`${method.toUpperCase()} ${url.pathname}${url.search}`);
    if (log.getLevel() >= 3) {
      const safe = {};
      for (const [k, v] of headers.entries()) {
        safe[k] = k.toLowerCase() === "authorization" ? "<redacted>" : v;
      }
      log.debug("> headers", safe);
      if (body) log.debug("> body", typeof body === "string" ? truncate(body, 400) : "<binary>");
    }

    const fetchOpts = {
      method: method.toUpperCase(),
      headers,
      body,
      redirect: "manual",
    };
    // Node's global fetch() has NO default timeout — a stalled server holds the
    // socket open until the OS kills it (can be tens of minutes). One slow
    // endpoint in a bulk operation (e.g. adt object pull) would then freeze the
    // whole pipeline. Default 60s; override per-call via options.timeoutMs.
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1000, options.timeoutMs)
      : 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetchOpts.signal = controller.signal;

    let res;
    try {
      res = await this._doFetch(url, fetchOpts); 
    } catch (e) {
      if (e && e.name === "AbortError") {
        const msg = `timeout after ${timeoutMs}ms at ${url.pathname}${url.search}`;
        log.err(`Network timeout: ${msg}`);
        throw new Error(msg);
      }
      const cause = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : "";
      log.err(`Network error: ${e.message}${cause ? ` (cause: ${cause})` : ""}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }

    this.storeSetCookies(res.headers);
    this._persistSsoIfChanged();
    if (
      res.status === 401 &&
      (this.profile.kind || "").toLowerCase() === "basicsso" &&
      !options._ssoRetried
    ) {
      const wa = res.headers.get("www-authenticate") || "";
      if (/negotiate/i.test(wa)) {
        this.cookies.delete("MYSAPSSO2");
        await this._performSpnego(url);
        return this.request(method, pathOrUrl, { ...options, _ssoRetried: true });
      }
    }

    // Refresh CSRF if rejected.
    if (res.status === 403 && isMutating && !options._internalSkipCsrf) {
      const reason = res.headers.get("x-csrf-token");
      if ((reason || "").toLowerCase() === "required") {
        log.warn("CSRF token rejected, refetching and retrying once.");
        this.csrfToken = null;
        await this.ensureCsrf(true);
        return this.request(method, pathOrUrl, { ...options, _csrfRetried: true });
      }
    }

    log.http(`<- ${res.status} ${res.statusText} (${res.headers.get("content-type") || "?"})`);
    if (log.getLevel() >= 3) {
      const respH = {};
      res.headers.forEach((v, k) => (respH[k] = v));
      log.debug("< headers", respH);
    }

    return res;
  }

  async _performSpnego(url) {
    const spn = this.profile.spn;
    if (!spn) throw new Error('basicsso profile needs "spn" (e.g. SAP/S1RSNCAD).');
    let kerberos;
    try {
      kerberos = require("kerberos");
    } catch (e) {
      throw new Error(`basicsso auth requires the "kerberos" package to be installed: ${e.message}`);
    }
    log.step(`SPNEGO handshake for ${spn}`);
    const client = await kerberos.initializeClient(spn, {});
    try {
      let challenge = ""; // empty on the first leg
      for (let leg = 0; leg < 6; leg++) {
        const token = await client.step(challenge);
        const headers = new Headers();
        headers.set("User-Agent", this.userAgent);
        headers.set("X-Requested-With", "XMLHttpRequest");
        headers.set("Accept", "application/atomsvc+xml");
        headers.set("Authorization", `Negotiate ${token}`);
        const ck = this.cookieHeader();
        if (ck) headers.set("Cookie", ck);
        const r = await this._doFetch(url, { method: "GET", headers, redirect: "manual" });
        this.storeSetCookies(r.headers);
        if (r.status !== 401) {
          log.ok(`SPNEGO established (HTTP ${r.status}).`);
          return;
        }
        const wa = r.headers.get("www-authenticate") || "";
        const m = wa.match(/Negotiate\s+([A-Za-z0-9+/=]+)/i);
        if (!m) {
          throw new Error(
            `SPNEGO rejected by ${url.host}: server fell back to "${wa || "Basic"}". ` +
              "Web-SSO (SPNEGO) is not enabled for this system, or it requires channel binding " +
              "(Extended Protection), which is unsupported."
          );
        }
        challenge = m[1]; // mutual-auth / multi-leg continuation token
      }
      throw new Error("SPNEGO handshake did not complete within 6 legs.");
    } finally {
      if (client && typeof client.cleanUp === "function") {
        try {
          await client.cleanUp();
        } catch (_) {
          // Ignore cleanup errors — the handshake result is what matters.
        }
      }
    }
  }

  // Convenience: read body as text + optional XML->JSON parse.
  async send(method, pathOrUrl, options = {}) {
    const res = await this.request(method, pathOrUrl, options);
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    let text = buf.toString("utf8");
    let parsed = null;
    if (ct.includes("xml") || (xml.looksLikeXml(text) && !ct.includes("json"))) {
      try {
        parsed = xml.parse(text);
      } catch (e) {
        log.debug(`XML parse failed: ${e.message}`);
      }
    } else if (ct.includes("json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* leave parsed null */
      }
    }

    const ok = res.status >= 200 && res.status < 300;
    if (!ok) {
      const silent =
        Array.isArray(options.silentStatuses) && options.silentStatuses.includes(res.status);
      if (!silent) {
        log.err(`HTTP ${res.status} ${res.statusText} from ${method.toUpperCase()} ${pathOrUrl}`);
        if (text) log.err(truncate(text, 600));
      } else {
        log.debug(`HTTP ${res.status} ${res.statusText} from ${method.toUpperCase()} ${pathOrUrl} (silenced)`);
      }
    }

    return {
      ok,
      status: res.status,
      statusText: res.statusText,
      headers: headersToObject(res.headers),
      contentType: ct,
      text,
      body: parsed != null ? parsed : text,
      raw: buf,
    };
  }
}

function currentOsUser() {
  const domain = process.env.USERDOMAIN || "";
  const user = process.env.USERNAME || process.env.USER || "";
  return domain ? `${domain}\\${user}` : user;
}

function headersToObject(h) {
  const o = {};
  h.forEach((v, k) => (o[k] = v));
  return o;
}

function truncate(s, n) {
  if (s == null) return s;
  s = String(s);
  return s.length <= n ? s : s.slice(0, n) + `...<+${s.length - n} bytes>`;
}

module.exports = { AdtClient };
