"use strict";

// Shared test utilities. Nothing here talks to Forpsi or any other remote host.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(ROOT, "src", "cli.js");

// Connection refused immediately, so IP lookups fail fast without network access
const UNREACHABLE_URL = "https://127.0.0.1:9/";

const ENV_KEYS = [
    "FORPSI_USERNAME",
    "FORPSI_PASSWORD",
    "DNS_UPDATER_CONF_DIR",
    "DNS_UPDATER_DATA_DIR",
    "DNS_UPDATER_DOMAINS",
    "DNS_UPDATER_INTERVAL",
    "DNS_UPDATER_IP_URL"
];

/**
 * Creates an empty temporary directory, removed when the test process exits.
 */
const makeTempDir = function(prefix = "dns-updater-test-") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
};

/**
 * Removes every variable the program reads, so tests never pick up the developer's setup.
 */
const clearProgramEnv = function() {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
};

/**
 * Environment for child processes: the current one minus the program's variables, plus extra.
 */
const childEnv = function(extra = {}) {
    const env = { ...process.env };
    for (const key of ENV_KEYS) {
        delete env[key];
    }
    // Set by VS Code and other Electron hosts; would start Electron as plain Node
    delete env.ELECTRON_RUN_AS_NODE;
    return { ...env, DNS_UPDATER_IP_URL: UNREACHABLE_URL, ...extra };
};

/**
 * Runs the CLI with isolated config and data directories.
 */
const runCli = function(args, options = {}) {
    const confDir = options.confDir || makeTempDir();
    const dataDir = options.dataDir || makeTempDir();
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
        encoding: "utf8",
        timeout: 30000,
        env: childEnv({ DNS_UPDATER_CONF_DIR: confDir, DNS_UPDATER_DATA_DIR: dataDir, ...options.env })
    });
    return { ...result, confDir, dataDir };
};

const writeJson = function(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4));
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const fileMode = (filePath) => fs.statSync(filePath).mode & 0o777;

module.exports = {
    ROOT,
    CLI_PATH,
    UNREACHABLE_URL,
    makeTempDir,
    clearProgramEnv,
    childEnv,
    runCli,
    writeJson,
    readJson,
    fileMode
};
