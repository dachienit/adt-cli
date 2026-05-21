"use strict";

// `adt login` command tree.
// Two flows are supported, mirroring the patterns in restcalls/*.http:
//   * basic  - on-prem ABAP server with user + password.
//   * oauth  - BTP / Steampunk via refresh-token grant.
//
// We always *verify* credentials by hitting /sap/bc/adt/discovery once. This
// gives the user immediate feedback rather than failing later inside another
// command. Verbose output describes every step.

const fs = require("fs");
const { Command } = require("commander");
const log = require("../logger");
const config = require("../config");
const { AdtClient } = require("../client");
const auth = require("../auth");
const destinations = require("../destinations");
const readline = require("readline");

function register(login) {
  login.addHelpText(
    "after",
    "\nExamples:\n" +
      "  adt auth login basic --url https://abap:44300 --user DEVELOPER --password '****' --name dev\n" +
      "  adt auth login oauth --url https://abap.host --login-url https://uaa.host \\\n" +
      "                       --client-id sb-... --client-secret '****' --refresh-token '****' --name cloud\n" +
      "  adt auth login destination --destination MY_ABAP --name btp\n" +
      "      # Resolves the destination at runtime via the BTP destination\n" +
      "      # service (or process.env.destinations / VCAP_SERVICES).\n"
  );

  login
    .command("basic")
    .description("Save a Basic-auth profile and verify it against /sap/bc/adt/discovery.")
    .option("--name <name>", "profile name to create or update (overrides --profile/global)")
    .requiredOption("--url <url>", "ABAP base URL, e.g. https://host:44300")
    .requiredOption("--user <user>", "ABAP user, e.g. DEVELOPER")
    .option("--password <password>", "password (omit to be prompted)")
    .option("--client <client>", "sap-client (e.g. 100)")
    .option("--language <lang>", "sap-language (e.g. EN)")
    .option("--insecure", "skip TLS certificate verification")
    .option("--no-verify", "skip the discovery verification call")
    .action(async function (opts) {
      const name = resolveProfileName(this, opts.name);
      const password = opts.password || (await prompt("Password: ", true));
      log.step(`Saving profile "${name}" (basic) -> ${opts.url}`);
      config.setProfile(name, {
        kind: "basic",
        url: opts.url,
        user: opts.user,
        password,
        client: opts.client,
        language: opts.language,
        insecure: !!opts.insecure,
      });
      if (opts.verify === false) {
        log.ok("Profile saved (verification skipped).");
        return;
      }
      await verify(name, !!opts.insecure);
    });

  login
    .command("oauth")
    .description("Save an OAuth (refresh-token) profile for SAP BTP and verify it.")
    .option("--name <name>", "profile name to create or update (overrides --profile/global)")
    .requiredOption("--url <url>", "ABAP base URL (the system itself, not the UAA)")
    .requiredOption("--login-url <url>", "OAuth login/UAA URL, e.g. https://*.authentication.*.hana.ondemand.com")
    .requiredOption("--client-id <id>", "OAuth clientId (sb-...)")
    .option("--client-secret <secret>", "OAuth clientSecret (omit to be prompted)")
    .option("--refresh-token <token>", "refresh token (omit to be prompted)")
    .option("--client <client>", "sap-client")
    .option("--language <lang>", "sap-language")
    .option("--insecure", "skip TLS certificate verification")
    .option("--no-verify", "skip the discovery verification call")
    .action(async function (opts) {
      const name = resolveProfileName(this, opts.name);
      const clientSecret = opts.clientSecret || (await prompt("Client secret: ", true));
      const refreshToken = opts.refreshToken || (await prompt("Refresh token: ", true));
      log.step(`Saving profile "${name}" (oauth) -> ${opts.url}`);
      config.setProfile(name, {
        kind: "oauth",
        url: opts.url,
        loginUrl: opts.loginUrl,
        clientId: opts.clientId,
        clientSecret,
        refreshToken,
        client: opts.client,
        language: opts.language,
        accessToken: null,
        tokenExpiresAt: 0,
        insecure: !!opts.insecure,
      });
      if (opts.verify === false) {
        log.ok("Profile saved (verification skipped).");
        return;
      }
      const profile = config.getProfile(name);
      try {
        await auth.refreshAccessToken(profile);
      } catch (e) {
        log.err(`OAuth refresh failed: ${e.message}`);
        process.exitCode = 2;
        return;
      }
      await verify(name, !!opts.insecure);
    });

  login
    .command("destination")
    .description(
      "Save a profile that resolves its URL + auth from a BTP destination. " +
        "Lookup order: process.env.destinations -> profile.serviceBindingJson -> VCAP_SERVICES.destination."
    )
    .option("--name <name>", "profile name to create or update (overrides --profile/global)")
    .requiredOption("--destination <name>", "destination name as known by the destination service")
    .option("--service-binding <jsonOrPath>", "path to or inline JSON of a destination service binding (overrides VCAP_SERVICES)")
    .option("--iss <url>", "issuer URL of a subscriber tenant (used as X-Tenant for lookup)")
    .option("--user-jwt <token>", "user JWT to forward as X-User-Token (for principal-propagation flows)")
    .option("--client <client>", "sap-client (overrides destination property)")
    .option("--language <lang>", "sap-language (overrides destination property)")
    .option("--insecure", "skip TLS certificate verification on the resolved URL")
    .option("--no-verify", "skip the discovery verification call after saving")
    .action(async function (opts) {
      const name = resolveProfileName(this, opts.name);
      const serviceBindingJson = readMaybeFile(opts.serviceBinding);
      log.step(`Saving profile "${name}" (destination=${opts.destination})`);
      config.setProfile(name, {
        kind: "destination",
        destinationName: opts.destination,
        url: "", // resolved lazily on first request
        serviceBindingJson: serviceBindingJson || null,
        iss: opts.iss || null,
        userJwt: opts.userJwt || null,
        client: opts.client,
        language: opts.language,
        insecure: !!opts.insecure,
      });
      if (opts.verify === false) {
        log.ok("Profile saved (verification skipped).");
        return;
      }
      await verify(name, !!opts.insecure);
    });

  login
    .command("test")
    .description("Verify a saved profile by hitting /sap/bc/adt/discovery.")
    .option("--name <name>", "profile name (overrides --profile/global)")
    .action(async function (opts) {
      const name = resolveProfileName(this, opts.name);
      await verify(name);
    });

  // ---- adt auth destinations -------------------------------------------
  // A discovery / inspection group for the destination resolver.
  const destGroup = login.parent
    .command("destinations")
    .alias("dest")
    .description(
      "Inspect destinations available to this process (env, VCAP, BTP destination service)."
    );

  destGroup
    .command("show")
    .description("Resolve a destination by name and print the (sanitised) result.")
    .argument("<name>", "destination name")
    .option("--service-binding <jsonOrPath>", "override VCAP_SERVICES.destination with this binding")
    .option("--iss <url>", "subscriber issuer URL (for tenant scoped lookup)")
    .option("--user-jwt <token>", "JWT to forward as X-User-Token")
    .action(async function (name, opts) {
      const rec = await destinations.resolveDestination(name, {
        iss: opts.iss,
        userJwt: opts.userJwt,
        serviceBindingJson: readMaybeFile(opts.serviceBinding),
      });
      const sanitised = {
        name: rec.name,
        url: rec.url,
        authType: rec.authType,
        sapClient: rec.sapClient,
        language: rec.language,
        additionalHeaders: rec.additionalHeaders,
        additionalQueries: rec.additionalQueries,
        authHeader: rec.authHeader ? "<set>" : null,
        source: rec.source,
      };
      console.log(JSON.stringify(sanitised, null, 2));
    });

  destGroup
    .command("list")
    .description(
      "List local env destinations + service bindings + (when reachable) " +
        "all destinations enumerated via the destination service."
    )
    .option("--service-binding <jsonOrPath>", "use this binding instead of VCAP_SERVICES")
    .option("--no-remote", "do not call the destination service - only show local view")
    .option("--user-jwt <token>", "JWT to forward as X-User-Token (subscriber lookup)")
    .action(async function (opts) {
      const out = { local: [], serviceBindings: [], remote: null };
      try {
        const envArr = process.env.destinations ? JSON.parse(process.env.destinations) : [];
        out.local = (Array.isArray(envArr) ? envArr : []).map((d) => ({
          name: d.name,
          url: d.url,
          authentication:
            d.authentication || (d.username ? "BasicAuthentication" : "NoAuthentication"),
        }));
      } catch (e) {
        log.warn(`Could not parse process.env.destinations: ${e.message}`);
      }
      try {
        const vcap = process.env.VCAP_SERVICES ? JSON.parse(process.env.VCAP_SERVICES) : {};
        out.serviceBindings = []
          .concat(vcap.destination || [], vcap["destination-lite"] || [])
          .map((b) => ({
            name: b.name,
            label: b.label,
            tags: b.tags,
            uri: b.credentials && (b.credentials.uri || b.credentials.url),
          }));
      } catch (e) {
        log.warn(`Could not parse VCAP_SERVICES: ${e.message}`);
      }
      if (opts.remote !== false) {
        try {
          out.remote = await destinations.listFromService({
            serviceBindingJson: readMaybeFile(opts.serviceBinding),
            userJwt: opts.userJwt,
          });
        } catch (e) {
          out.remote = { error: e.message };
        }
      }
      console.log(JSON.stringify(out, null, 2));
    });

  destGroup
    .command("test")
    .description("Resolve a destination and run /sap/bc/adt/discovery against the resulting URL.")
    .argument("<name>", "destination name")
    .option("--service-binding <jsonOrPath>", "override VCAP_SERVICES.destination with this binding")
    .option("--iss <url>", "subscriber issuer URL")
    .option("--insecure", "skip TLS certificate verification on the resolved URL")
    .action(async function (name, opts) {
      const rec = await destinations.resolveDestination(name, {
        iss: opts.iss,
        serviceBindingJson: readMaybeFile(opts.serviceBinding),
      });
      log.ok(`Resolved "${name}" -> ${rec.url} (${rec.authType}, source=${rec.source})`);
      const tmpProfile = {
        name: `__destination:${name}__`,
        kind: "destination",
        destinationName: name,
        url: rec.url,
        client: rec.sapClient,
        language: rec.language,
        _destination: rec,
      };
      const client = new AdtClient(tmpProfile, { insecure: !!opts.insecure });
      const res = await client.send("GET", "/sap/bc/adt/discovery", {
        accept: "application/atomsvc+xml",
      });
      if (!res.ok) {
        log.err(`Verification failed: HTTP ${res.status} ${res.statusText}`);
        process.exitCode = 2;
        return;
      }
      log.ok(`Authentication OK via destination "${name}".`);
    });
}

function readMaybeFile(input) {
  if (!input) return null;
  // Accept either inline JSON or a path to a JSON file.
  const trimmed = String(input).trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  try {
    return fs.readFileSync(trimmed, "utf8");
  } catch (e) {
    throw new Error(`Could not read service-binding file "${trimmed}": ${e.message}`);
  }
}

function resolveProfileName(cmd, explicit) {
  if (explicit) return explicit;
  // Read the global --profile from the root program.
  let p = cmd;
  while (p.parent) p = p.parent;
  const globals = p.opts();
  return globals.profile || process.env.ADT_PROFILE || "default";
}

async function verify(profileName, insecure) {
  const profile = config.getProfile(profileName);
  if (!profile) throw new Error(`Profile "${profileName}" not found.`);
  log.step(`Verifying profile "${profileName}" via /sap/bc/adt/discovery ...`);
  const client = new AdtClient(profile, { insecure });
  const res = await client.send("GET", "/sap/bc/adt/discovery", {
    accept: "application/atomsvc+xml",
  });
  if (!res.ok) {
    log.err(`Verification failed: HTTP ${res.status} ${res.statusText}`);
    process.exitCode = 2;
    return;
  }
  log.ok(`Authentication OK. ${profile.kind} as ${profile.user || profile.clientId}.`);
}

function prompt(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    if (hidden) {
      const out = process.stderr;
      out.write(question);
      const stdin = process.stdin;
      stdin.setRawMode && stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      let input = "";
      const onData = (ch) => {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          stdin.setRawMode && stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          out.write("\n");
          rl.close();
          resolve(input);
        } else if (ch === "\u0003") {
          process.exit(130);
        } else if (ch === "\u007f") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            out.write("\b \b");
          }
        } else {
          input += ch;
          out.write("*");
        }
      };
      stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

module.exports = { register };
