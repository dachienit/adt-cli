"use strict";

// `adt auth profile` subcommands - manage saved profiles.

const path = require("path");
const fs = require("fs");
const log = require("../logger");
const config = require("../config");
const { renderJson } = require("../output");

function register(profile) {
  profile
    .command("list")
    .alias("ls")
    .description("List all configured profiles and which is the default.")
    .action(() => {
      renderJson(config.listProfiles());
    });

  profile
    .command("show")
    .description("Show the resolved settings of a profile (secrets hidden).")
    .argument("[name]", "profile name (defaults to the default profile)")
    .action((name) => {
      const p = config.getProfile(name);
      if (!p) {
        log.err(`Profile "${name || "default"}" not found.`);
        process.exitCode = 1;
        return;
      }
      renderJson({
        ...p,
        password: p.password ? "<set>" : null,
        clientSecret: p.clientSecret ? "<set>" : null,
        refreshToken: p.refreshToken ? "<set>" : null,
        accessToken: p.accessToken ? "<set>" : null,
        ssoToken: p.ssoToken ? "<set>" : null,
      });
    });

  profile
    .command("use")
    .description("Make a profile the default.")
    .argument("<name>", "profile name")
    .action((name) => {
      config.setDefault(name);
      log.ok(`Default profile set to "${name}".`);
    });

  profile
    .command("delete")
    .alias("rm")
    .description("Delete a profile from the config.")
    .argument("<name>", "profile name")
    .action((name) => {
      config.deleteProfile(name);
      log.ok(`Profile "${name}" deleted.`);
    });

  profile
    .command("path")
    .description("Print the location of the config file.")
    .action(() => {
      console.log(config.CONFIG_FILE);
    });

  // Attach an abaplint config (json/jsonc) to a profile so that `adt lint`
  // commands automatically pick it up when no --config flag is passed.
  profile
    .command("set-lint-config")
    .description("Attach an abaplint config file (json/jsonc) to a profile.")
    .argument("<configPath>", "path to abaplint.json or abaplint.jsonc")
    .option("--name <profile>", "target profile (defaults to the current default)")
    .option("--clear", "remove the abaplintConfig field from the profile instead of setting it")
    .action((configPath, opts) => {
      const targetName = opts.name || config.load().defaultProfile;
      if (!targetName) {
        log.err("No default profile is configured and --name was not given.");
        process.exitCode = 1;
        return;
      }
      if (opts.clear) {
        config.updateProfile(targetName, { abaplintConfig: null });
        log.ok(`Cleared abaplintConfig on profile "${targetName}".`);
        return;
      }
      const abs = path.resolve(configPath);
      if (!fs.existsSync(abs)) {
        log.err(`Config file not found: ${abs}`);
        process.exitCode = 1;
        return;
      }
      config.updateProfile(targetName, { abaplintConfig: abs });
      log.ok(`Saved abaplintConfig=${abs} on profile "${targetName}".`);
    });
}

module.exports = { register };
