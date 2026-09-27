"use strict";

// Unit tests for the CLI's argument parsing, config file handling and setting precedence.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, makeTempDir, clearProgramEnv, writeJson, readJson, fileMode } = require("./helpers.js");

clearProgramEnv();
const platform = require("../src/electron/platform.js");
const auth = require("../src/electron/auth.js");
const cli = require("../src/cli.js");

let confDir;
let dataDir;

test.beforeEach(() => {
    clearProgramEnv();
    confDir = makeTempDir();
    dataDir = makeTempDir();
    cli.setConfDir(confDir);
    platform.setDataDir(dataDir);
});

const configPath = () => path.join(confDir, "config.json");

test.describe("parseArgs", () => {
    test.it("collects positionals, value flags and boolean flags", () => {
        const opts = cli.parseArgs(["domains", "add", "a.com", "--interval", "7", "--force", "--verbose"]);
        assert.deepEqual(opts._, ["domains", "add", "a.com"]);
        assert.equal(opts.interval, "7");
        assert.equal(opts.force, true);
        assert.equal(opts.verbose, true);
    });

    test.it("accepts --name=value and repeated --domain", () => {
        const opts = cli.parseArgs(["once", "--domain=a.com", "--domain", "b.com", "--conf-dir=/tmp/c"]);
        assert.deepEqual(opts.domain, ["a.com", "b.com"]);
        assert.equal(opts["conf-dir"], "/tmp/c");
    });

    test.it("treats -h as help", () => {
        assert.equal(cli.parseArgs(["-h"]).help, true);
    });

    test.it("rejects unknown options and missing values", () => {
        assert.throws(() => cli.parseArgs(["--nope"]), /Unknown option/);
        assert.throws(() => cli.parseArgs(["--interval"]), /requires a value/);
    });
});

test.describe("normalizeDomain", () => {
    test.it("trims and lowercases valid domains", () => {
        assert.equal(cli.normalizeDomain("  Home.Example.COM "), "home.example.com");
    });

    test.it("rejects invalid domains", () => {
        for (const bad of ["", "localhost", "exa mple.com", "-bad.com", "a..com", "http://a.com"]) {
            assert.throws(() => cli.normalizeDomain(bad), /Invalid domain/, bad);
        }
    });
});

test.describe("conf directory", () => {
    test.it("prefers setConfDir, then DNS_UPDATER_CONF_DIR, then conf/ in the repo", () => {
        const envDir = makeTempDir();
        process.env.DNS_UPDATER_CONF_DIR = envDir;
        assert.equal(cli.getConfDir(), confDir);

        cli.setConfDir(null);
        assert.equal(cli.getConfDir(), envDir);

        delete process.env.DNS_UPDATER_CONF_DIR;
        assert.equal(cli.getConfDir(), path.join(ROOT, "conf"));
        assert.equal(cli.getConfigPath(), path.join(ROOT, "conf", "config.json"));
    });
});

test.describe("loadConfig / saveConfig", () => {
    test.it("returns defaults when no config exists", () => {
        assert.deepEqual(cli.loadConfig(), { domains: [], intervalMinutes: 5 });
    });

    test.it("reads conf/config.json and fills in missing defaults", () => {
        writeJson(configPath(), { domains: ["a.com"] });
        assert.deepEqual(cli.loadConfig(), { domains: ["a.com"], intervalMinutes: 5 });
    });

    test.it("falls back to the legacy cli_config.json in the data dir", () => {
        writeJson(path.join(dataDir, "cli_config.json"), { domains: ["old.com"], intervalMinutes: 9 });
        assert.deepEqual(cli.loadConfig().domains, ["old.com"]);

        writeJson(configPath(), { domains: ["new.com"] });
        assert.deepEqual(cli.loadConfig().domains, ["new.com"]);
    });

    test.it("ignores a broken config file instead of crashing", () => {
        fs.writeFileSync(configPath(), "{ not json");
        assert.deepEqual(cli.loadConfig(), { domains: [], intervalMinutes: 5 });
    });

    test.it("writes 4-space JSON, owner-only, keeping key order", () => {
        const nested = path.join(confDir, "sub");
        cli.setConfDir(nested);
        const config = { forpsi: { username: "u", password: "p" }, domains: ["a.com"], intervalMinutes: 3 };
        cli.saveConfig(config);

        const file = path.join(nested, "config.json");
        const text = fs.readFileSync(file, "utf8");
        assert.equal(text, JSON.stringify(config, null, 4) + "\n");
        assert.deepEqual(Object.keys(cli.loadConfig()), ["forpsi", "domains", "intervalMinutes"]);
        if (process.platform !== "win32") {
            assert.equal(fileMode(file), 0o600);
        }
    });

    test.it("the committed example config is valid and complete", () => {
        const example = readJson(path.join(ROOT, "conf", "config.example.json"));
        assert.deepEqual(Object.keys(example), ["forpsi", "domains", "intervalMinutes", "ipCheckUrl"]);
        assert.deepEqual(Object.keys(example.forpsi), ["username", "password"]);
        for (const domain of example.domains) {
            assert.equal(cli.normalizeDomain(domain), domain);
        }
    });
});

test.describe("state file", () => {
    test.it("round-trips through the data dir", () => {
        assert.deepEqual(cli.loadState(), { lastSyncedIp: null, lastSyncedTime: null, domains: {} });
        cli.saveState({ lastSyncedIp: "1.2.3.4", lastSyncedTime: "t", domains: { "a.com": { status: "synced" } } });
        assert.equal(readJson(path.join(dataDir, "cli_state.json")).lastSyncedIp, "1.2.3.4");
        assert.equal(cli.loadState().domains["a.com"].status, "synced");
    });
});

test.describe("resolveDomains", () => {
    test.it("prefers --domain, then DNS_UPDATER_DOMAINS, then the config file", () => {
        writeJson(configPath(), { domains: ["conf.com"] });
        process.env.DNS_UPDATER_DOMAINS = "env1.com, env2.com";

        assert.deepEqual(cli.resolveDomains({ domain: ["flag.com"] }), ["flag.com"]);
        assert.deepEqual(cli.resolveDomains({ domain: [] }), ["env1.com", "env2.com"]);

        delete process.env.DNS_UPDATER_DOMAINS;
        assert.deepEqual(cli.resolveDomains({ domain: [] }), ["conf.com"]);
    });

    test.it("normalizes and removes duplicates", () => {
        assert.deepEqual(cli.resolveDomains({ domain: ["A.com", "a.com ", "b.com"] }), ["a.com", "b.com"]);
    });

    test.it("fails on an invalid configured domain", () => {
        writeJson(configPath(), { domains: ["not a domain"] });
        assert.throws(() => cli.resolveDomains({ domain: [] }), /Invalid domain/);
    });
});

test.describe("resolveIntervalMinutes", () => {
    test.it("prefers --interval, then DNS_UPDATER_INTERVAL, then config, then 5", () => {
        assert.equal(cli.resolveIntervalMinutes({}), 5);

        writeJson(configPath(), { intervalMinutes: 15 });
        assert.equal(cli.resolveIntervalMinutes({}), 15);

        process.env.DNS_UPDATER_INTERVAL = "10";
        assert.equal(cli.resolveIntervalMinutes({}), 10);
        assert.equal(cli.resolveIntervalMinutes({ interval: "2" }), 2);
    });

    test.it("skips invalid values and never goes below one minute", () => {
        process.env.DNS_UPDATER_INTERVAL = "abc";
        assert.equal(cli.resolveIntervalMinutes({ interval: "-3" }), 5);
        assert.equal(cli.resolveIntervalMinutes({ interval: "0.5" }), 1);
    });
});

test.describe("resolveIpCheckUrl", () => {
    test.it("prefers DNS_UPDATER_IP_URL, then config, then ipify", () => {
        assert.equal(cli.resolveIpCheckUrl(), "https://api.ipify.org?format=json");

        writeJson(configPath(), { ipCheckUrl: "https://conf.example/ip" });
        assert.equal(cli.resolveIpCheckUrl(), "https://conf.example/ip");

        process.env.DNS_UPDATER_IP_URL = "https://env.example/ip";
        assert.equal(cli.resolveIpCheckUrl(), "https://env.example/ip");
    });
});

test.describe("resolveCredentials", () => {
    test.it("returns null when nothing is configured", () => {
        assert.equal(cli.resolveCredentials(), null);
    });

    test.it("prefers environment, then config file, then credentials saved by login", () => {
        auth.saveCredentials("saved-user", "saved-pass");
        assert.deepEqual(cli.resolveCredentials(), { username: "saved-user", password: "saved-pass", source: "saved" });

        writeJson(configPath(), { forpsi: { username: "conf-user", password: "conf-pass" } });
        assert.deepEqual(cli.resolveCredentials(), { username: "conf-user", password: "conf-pass", source: "config" });

        process.env.FORPSI_USERNAME = "env-user";
        process.env.FORPSI_PASSWORD = "env-pass";
        assert.deepEqual(cli.resolveCredentials(), { username: "env-user", password: "env-pass", source: "environment" });
    });

    test.it("ignores incomplete environment or config credentials", () => {
        process.env.FORPSI_USERNAME = "env-user";
        writeJson(configPath(), { forpsi: { username: "conf-user", password: "" } });
        assert.equal(cli.resolveCredentials(), null);
    });
});
