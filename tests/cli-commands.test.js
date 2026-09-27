"use strict";

// Runs the CLI as a real process (node src/cli.js ...) with isolated directories.
// Only commands that stop before contacting Forpsi are exercised.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { runCli, makeTempDir, writeJson, readJson } = require("./helpers.js");

test.describe("cli process", () => {
    test.it("prints help and exits 0", () => {
        for (const args of [["help"], ["--help"], ["-h"]]) {
            const res = runCli(args);
            assert.equal(res.status, 0, res.stderr);
            assert.match(res.stdout, /Usage: dns-updater <command>/);
            assert.match(res.stdout, /--conf-dir/);
        }
    });

    test.it("exits 2 on an unknown command or option", () => {
        const cmd = runCli(["frobnicate"]);
        assert.equal(cmd.status, 2);
        assert.match(cmd.stderr, /Unknown command: frobnicate/);

        const opt = runCli(["once", "--bogus"]);
        assert.equal(opt.status, 2);
        assert.match(opt.stderr, /Unknown option: --bogus/);
    });

    test.it("manages domains in conf/config.json", () => {
        const confDir = makeTempDir();
        const dataDir = makeTempDir();
        const configFile = path.join(confDir, "config.json");
        writeJson(configFile, { forpsi: { username: "u", password: "p" }, domains: [] });

        const add = runCli(["domains", "add", "Example.com", "home.example.com"], { confDir, dataDir });
        assert.equal(add.status, 0, add.stderr);
        assert.deepEqual(readJson(configFile).domains, ["example.com", "home.example.com"]);
        assert.deepEqual(readJson(configFile).forpsi, { username: "u", password: "p" });

        const list = runCli(["domains", "list"], { confDir, dataDir });
        assert.equal(list.stdout.trim(), "example.com\nhome.example.com");

        const remove = runCli(["domains", "remove", "example.com"], { confDir, dataDir });
        assert.equal(remove.status, 0, remove.stderr);
        assert.deepEqual(readJson(configFile).domains, ["home.example.com"]);
    });

    test.it("--conf-dir overrides DNS_UPDATER_CONF_DIR", () => {
        const flagDir = makeTempDir();
        writeJson(path.join(flagDir, "config.json"), { domains: ["flag.com"] });
        const res = runCli(["domains", "list", "--conf-dir", flagDir]);
        assert.equal(res.stdout.trim(), "flag.com");
    });

    test.it("rejects an invalid domain", () => {
        const res = runCli(["domains", "add", "not a domain"]);
        assert.equal(res.status, 1);
        assert.match(res.stderr, /Invalid domain/);
    });

    test.it("once without domains fails with a hint and exit code 1", () => {
        const res = runCli(["once"]);
        assert.equal(res.status, 1);
        assert.match(res.stderr, /No domains configured\. Add them to .*config\.json/);
    });

    test.it("ip reports an unreachable IP service as an error", () => {
        const res = runCli(["ip"]);
        assert.equal(res.status, 1);
        assert.match(res.stderr, /^Error: /m);
    });
});
