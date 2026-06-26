"use strict";

// Top-level CLI dispatcher with a unified noun-verb hierarchy.
//
// Surface (depth = 2 for almost everything):
//
//   adt auth     login basic|oauth|test          | profile list|show|use|delete|path
//   adt system   discovery | core-discovery | graph | feeds | users | dumps
//                | object-types | type-structure
//   adt object   create <kind> | create-generic | create-types | validate <kind>
//                | structure | properties | source | set-source | versions
//                | lock | unlock | activate | inactive | delete
//   adt data     sql | ddic | ddic-meta
//   adt service  binding | odata-v2
//   adt cts      config-metadata | configurations | configuration
//                | save-configuration | list
//   adt trace    list | requests | hitlist | db | statements
//                | parameters | create | delete
//   adt atc      activate | run | worklist | check | customizing | users
//   adt debug    discovery | status | listen | settings | breakpoint set|delete
//   adt http     request|req | list | run

const { Command, Option } = require("commander");
const log = require("./logger");
const config = require("./config");
const { AdtClient } = require("./client");

const cmdLogin = require("./commands/login");
const cmdProfile = require("./commands/profile");
const cmdSystem = require("./commands/discovery");
const cmdObjectsRead = require("./commands/objects");
const cmdCreate = require("./commands/create");
const cmdData = require("./commands/data");
const cmdBindings = require("./commands/bindings");
const cmdCts = require("./commands/transports");
const cmdTrace = require("./commands/traces");
const cmdDebug = require("./commands/debugger");
const cmdRequest = require("./commands/request");
const cmdRunHttp = require("./commands/runHttp");
const cmdAtc = require("./commands/atc");
const cmdLint = require("./commands/lint");
const cmdPull = require("./commands/pull");
const cmdContext = require("./commands/context");

async function run(argv) {
  const program = new Command();

  program
    .name("adt")
    .description(
      "Verbose CLI for SAP ABAP Development Tools (ADT) HTTP services.\n\n" +
        "Commands are organized by domain (noun) and action (verb):\n" +
        "  adt auth      - credentials and profiles\n" +
        "  adt system    - discovery, server metadata, dumps, users\n" +
        "  adt object    - create / read / edit / activate / delete repository objects\n" +
        "  adt data      - SQL and DDIC data preview\n" +
        "  adt service   - business service bindings\n" +
        "  adt cts       - change & transport system\n" +
        "  adt trace     - ABAP runtime traces\n" +
        "  adt atc       - ABAP Test Cockpit (variants, runs, worklists)\n" +
        "  adt debug     - debugger control\n" +
        "  adt http      - generic request and .http file runner\n" +
        "  adt lint      - offline static analysis (abaplint): object / file / package\n" +
        "  adt context   - build LLM-ready context bundles from ABAP packages\n\n" +
        "Quick start:\n" +
        "  adt auth login basic --url https://abap:44300 --user DEVELOPER --password '****' --name dev\n" +
        "  adt system discovery\n" +
        "  adt object source programs/programs/zroman\n" +
        "  adt data sql 'SELECT * FROM /DMO/BOOKING' --rows 5\n" +
        "  adt object create program ZHELLO --package $YMU_PKG --source-file zhello.abap --activate"
    )
    .version(require("../package.json").version)
    .addOption(new Option("-p, --profile <name>", "named profile to use").env("ADT_PROFILE"))
    .option("-v, --verbose", "verbose logging (HTTP method/url/status)")
    .option("--debug", "debug logging (also dumps headers + body previews)")
    .option("-q, --quiet", "errors only")
    .option("--insecure", "skip TLS certificate verification")
    .option("--json", "force result output as JSON (default if response was XML)")
    .option("--raw", "print raw response body without parsing")
    .option("--output <file>", "write result body to a file instead of stdout")
    .option("--accept <mime>", "override Accept header on the request")
    // ---- BTP destination resolver (only for kind=destination profiles) ----
    .addOption(
      new Option(
        "--user-jwt <token>",
        "JWT to forward to the destination service (X-User-Token) " +
          "and, when destination has forwardAuthToken=true, to the target system."
      ).env("ADT_USER_JWT")
    )
    .addOption(
      new Option(
        "--iss <url>",
        "subscriber issuer URL for tenant-scoped destination lookup"
      ).env("ADT_ISS")
    );

  // Resolve global options before subcommand actions run.
  program.hook("preAction", (thisCmd, actionCmd) => {
    const opts = thisCmd.opts();
    if (opts.quiet) log.setLevel(0);
    else if (opts.debug) log.setLevel(3);
    else if (opts.verbose) log.setLevel(2);
    else log.setLevel(1);
    actionCmd.ctx = buildContext(opts);
  });

  // -------- groups --------------------------------------------------------
  const auth = program.command("auth").description("Credentials and profile management.");
  cmdLogin.register(auth.command("login").description("Configure credentials for an ABAP system."));
  cmdProfile.register(auth.command("profile").description("Manage stored ABAP system profiles."));

  const system = program
    .command("system")
    .description("Server discovery, metadata, dumps, users.");
  cmdSystem.register(system);

  const object = program
    .command("object")
    .description("Create / read / edit / activate / delete repository objects.");
  // Nested: adt object create <kind> ...
  cmdCreate.register(object);
  // Flat verbs on the object group: structure, source, set-source, properties,
  // versions, lock, unlock, activate, inactive, delete, validate.
  cmdObjectsRead.register(object);
  cmdPull.register(object);

  const data = program.command("data").description("SQL and DDIC data preview.");
  cmdData.register(data);

  const service = program.command("service").description("Business service bindings.");
  cmdBindings.register(service);

  const cts = program.command("cts").description("Change & transport system.");
  cmdCts.register(cts);

  const trace = program.command("trace").description("ABAP runtime traces.");
  cmdTrace.register(trace);

  const atc = program
    .command("atc")
    .description("ABAP Test Cockpit: variant activation, runs, worklists.");
  cmdAtc.register(atc);

  const debug = program.command("debug").description("ABAP debugger control endpoints.");
  cmdDebug.register(debug);

  const http = program
    .command("http")
    .description("Generic HTTP request and .http file runner.");
  cmdRequest.register(http);
  cmdRunHttp.register(http);

  const lint = program
    .command("lint")
    .description("Offline static analysis via abaplint (object / file / package).");
  cmdLint.register(lint);

  const context = program
    .command("context")
    .description("Build LLM-ready context bundles from ABAP packages.");
  cmdContext.register(context);

  program.showHelpAfterError("(use --help for command help)");
  program.exitOverride();

  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (
      e &&
      e.code &&
      (e.code.startsWith("commander.help") || e.code.startsWith("commander.version"))
    ) {
      process.exit(e.exitCode || 0);
    }
    if (e && e.code === "commander.unknownCommand") {
      log.err(e.message);
      process.exit(1);
    }
    log.err(e && e.message ? e.message : String(e));
    if (log.getLevel() >= 3 && e && e.stack) log.debug(e.stack);
    process.exit(1);
  }
}

function buildContext(globalOpts) {
  return {
    globalOpts,
    getClient() {
      const profileName = globalOpts.profile || process.env.ADT_PROFILE;
      const profile = config.getProfile(profileName);
      if (!profile) {
        const hint = profileName
          ? `Profile "${profileName}" was not found.`
          : "No default profile is configured.";
        throw new Error(`${hint} Run "adt auth login" to create one.`);
      }
      // Per-invocation overrides for the destination resolver. Env / CLI flags
      // win over what was saved on the profile - useful for short-lived JWTs.
      if (globalOpts.userJwt) profile.userJwt = globalOpts.userJwt;
      if (globalOpts.iss) profile.iss = globalOpts.iss;
      log.info(
        `Using profile "${profile.name}" (${profile.kind || "basic"})` +
          (profile.url ? ` -> ${profile.url}` : "") +
          (profile.kind === "destination"
            ? ` [destination=${profile.destinationName}]`
            : "")
      );
      return new AdtClient(profile, { insecure: globalOpts.insecure });
    },
    getProfile() {
      const name = globalOpts.profile || process.env.ADT_PROFILE;
      const p = config.getProfile(name);
      if (!p) throw new Error(`No profile available (--profile or ADT_PROFILE).`);
      return p;
    },
  };
}

module.exports = { run };
