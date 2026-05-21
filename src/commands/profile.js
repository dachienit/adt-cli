"use strict";

// `adt auth profile` subcommands - manage saved profiles.

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
}

module.exports = { register };
