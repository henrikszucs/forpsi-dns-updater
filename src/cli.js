#!/usr/bin/env node
"use strict";

// Headless command-line entry point: runs the DNS updater without Electron or a
// desktop environment. Requires only Node.js (>= 18).

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const readline = require("node:readline");
const platform = require("./electron/platform.js");
const auth = require("./electron/auth.js");
const dns = require("./electron/dns.js");

const PARTITION = "persist:dns_provider_session";
const DEFAULT_IP_CHECK_URL = "https://api.ipify.org?format=json";
const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_CONF_DIR = path.resolve(__dirname, "..", "conf");
const CONFIG_FILE_NAME = "config.json";
const LEGACY_CONFIG_FILE_NAME = "cli_config.json";
const STATE_FILE_NAME = "cli_state.json";
const DOMAIN_REGEX = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

const USAGE = `DNS Updater - headless CLI

Usage: dns-updater <command> [options]

Commands:
  run                      Keep running: check the public IP every interval and
                           update DNS records when it changes (default command)
  once                     Run a single check/update cycle and exit (for cron);
                           exits with code 1 if any domain failed
  login                    Log in to Forpsi and save the credentials
  logout                   Delete saved credentials and session cookies
  status                   Show login state, public IP, domains and last sync
  ip                       Print the current public IP
  domains list             List configured domains
  domains add <d>...       Add domain(s) to keep pointed at this IP
  domains remove <d>...    Remove domain(s)
  help                     Show this help

Options:
  --conf-dir <dir>         Directory holding config.json (default: conf/ next to src/)
  --data-dir <dir>         Directory for saved login, session cookies and sync state
  --interval <minutes>     Check interval for "run" (default: ${DEFAULT_INTERVAL_MINUTES})
  --domain <domain>        Domain to update, repeatable (overrides the config)
  --force                  Update DNS even if the IP has not changed
  --username <name>        Username for "login" (prompted if omitted)
  --password <pass>        Password for "login" (prompted if omitted)
  --otp <code>             Two-factor code for "login"
  --verbose                Show detailed provider request logs

Config file (conf/config.json, see conf/config.example.json):
  forpsi.username, forpsi.password   Forpsi login
  domains                            Domains to keep pointed at this IP
  intervalMinutes                    Minutes between checks
  ipCheckUrl                         Public IP endpoint

Environment (overrides the config file):
  FORPSI_USERNAME, FORPSI_PASSWORD   Credentials
  DNS_UPDATER_CONF_DIR               Same as --conf-dir
  DNS_UPDATER_DATA_DIR               Same as --data-dir
  DNS_UPDATER_DOMAINS                Comma-separated domain list
  DNS_UPDATER_INTERVAL               Same as --interval
  DNS_UPDATER_IP_URL                 Public IP endpoint (JSON {"ip": ...} or plain text)
`;

//
// Output helpers
//

const rawLog = console.log.bind(console);
const rawError = console.error.bind(console);
const stamp = () => new Date().toISOString();

const log = (...args) => rawLog(`[${stamp()}]`, ...args);
const logError = (...args) => rawError(`[${stamp()}]`, ...args);

const setupConsole = function(verbose) {
    // auth.js / dns.js log every request via console.log; only show it when asked
    console.log = verbose ? log : function() {};
    console.info = console.log;
    console.warn = (...args) => rawError(`[${stamp()}] WARN`, ...args);
    console.error = (...args) => rawError(`[${stamp()}] ERROR`, ...args);
};

//
// Argument parsing
//

const parseArgs = function(argv) {
    const opts = { _: [], domain: [] };
    const valueFlags = ["conf-dir", "data-dir", "interval", "domain", "username", "password", "otp"];
    const boolFlags = ["force", "verbose", "help"];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "-h") {
            opts.help = true;
            continue;
        }
        if (!arg.startsWith("--")) {
            opts._.push(arg);
            continue;
        }
        let [name, value] = arg.slice(2).split(/=(.*)/s);
        if (boolFlags.includes(name)) {
            opts[name] = true;
        } else if (valueFlags.includes(name)) {
            if (value === undefined) {
                value = argv[++i];
                if (value === undefined) {
                    throw new Error(`Option --${name} requires a value.`);
                }
            }
            if (name === "domain") {
                opts.domain.push(value);
            } else {
                opts[name] = value;
            }
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    return opts;
};

//
// Config & state files
//

let confDirOverride = null;

/**
 * Overrides the directory holding config.json (--conf-dir).
 */
const setConfDir = function(dir) {
    confDirOverride = dir ? path.resolve(dir) : null;
};

/**
 * Directory holding the user-editable config.json (--conf-dir > DNS_UPDATER_CONF_DIR > conf/).
 */
const getConfDir = function() {
    if (confDirOverride) {
        return confDirOverride;
    }
    if (process.env.DNS_UPDATER_CONF_DIR) {
        return path.resolve(process.env.DNS_UPDATER_CONF_DIR);
    }
    return DEFAULT_CONF_DIR;
};

const getConfigPath = () => path.join(getConfDir(), CONFIG_FILE_NAME);

const readJsonFile = function(filePath, fallback) {
    try {
        // File keys first so rewriting a hand-edited config keeps its key order
        const data = { ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
        for (const key of Object.keys(fallback)) {
            if (!(key in data)) {
                data[key] = fallback[key];
            }
        }
        return data;
    } catch (err) {
        if (err.code !== "ENOENT") {
            console.warn(`Could not read ${filePath}: ${err.message}`);
        }
        return { ...fallback };
    }
};

const readJson = (fileName, fallback) => readJsonFile(path.join(platform.getDataDir(), fileName), fallback);

const writeJson = function(fileName, data) {
    const filePath = path.join(platform.getDataDir(), fileName);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
};

const CONFIG_DEFAULTS = { domains: [], intervalMinutes: DEFAULT_INTERVAL_MINUTES };

/**
 * Reads conf/config.json, falling back to the old data-dir cli_config.json so
 * installs from before the conf/ folder keep working until the next save.
 */
const loadConfig = function() {
    const filePath = getConfigPath();
    if (!fs.existsSync(filePath)) {
        return readJson(LEGACY_CONFIG_FILE_NAME, CONFIG_DEFAULTS);
    }
    return readJsonFile(filePath, CONFIG_DEFAULTS);
};

/**
 * Writes conf/config.json (owner-only, as it may hold the Forpsi password).
 */
const saveConfig = function(config) {
    fs.mkdirSync(getConfDir(), { recursive: true });
    const filePath = getConfigPath();
    fs.writeFileSync(filePath, JSON.stringify(config, null, 4) + "\n", { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch {}
};

const loadState = () => readJson(STATE_FILE_NAME, { lastSyncedIp: null, lastSyncedTime: null, domains: {} });
const saveState = (state) => writeJson(STATE_FILE_NAME, state);

const normalizeDomain = function(raw) {
    const domain = String(raw || "").trim().toLowerCase();
    if (!DOMAIN_REGEX.test(domain)) {
        throw new Error(`Invalid domain: '${raw}'`);
    }
    return domain;
};

// Priority: --domain flags > DNS_UPDATER_DOMAINS > conf/config.json
const resolveDomains = function(opts) {
    let list = opts.domain;
    if (list.length === 0 && process.env.DNS_UPDATER_DOMAINS) {
        list = process.env.DNS_UPDATER_DOMAINS.split(/[\s,]+/).filter(Boolean);
    }
    if (list.length === 0) {
        list = loadConfig().domains || [];
    }
    return [...new Set(list.map(normalizeDomain))];
};

// Priority: --interval > DNS_UPDATER_INTERVAL > conf/config.json > default
const resolveIntervalMinutes = function(opts) {
    const candidates = [opts.interval, process.env.DNS_UPDATER_INTERVAL, loadConfig().intervalMinutes];
    for (const c of candidates) {
        const n = Number(c);
        if (c !== undefined && c !== null && c !== "" && Number.isFinite(n) && n > 0) {
            return Math.max(1, n);
        }
    }
    return DEFAULT_INTERVAL_MINUTES;
};

//
// Public IP
//

// Priority: DNS_UPDATER_IP_URL > conf/config.json > default
const resolveIpCheckUrl = () => process.env.DNS_UPDATER_IP_URL || loadConfig().ipCheckUrl || DEFAULT_IP_CHECK_URL;

const getPublicIp = function() {
    return new Promise((resolve, reject) => {
        const req = https.get(resolveIpCheckUrl(), { headers: { "Accept": "application/json" } }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`IP lookup failed (HTTP ${res.statusCode})`));
                }
                let ip = body.trim();
                try {
                    ip = String(JSON.parse(body).ip || "").trim();
                } catch {}
                if (!IPV4_REGEX.test(ip)) {
                    return reject(new Error(`IP lookup returned an invalid IPv4 address: '${ip}'`));
                }
                resolve(ip);
            });
        });
        req.on("error", reject);
        req.setTimeout(10000, () => { req.destroy(new Error("IP lookup timed out.")); });
    });
};

//
// Prompts
//

const prompt = function(question, hidden = false) {
    const stdin = process.stdin;

    if (!hidden || !stdin.isTTY) {
        return new Promise((resolve) => {
            const rl = readline.createInterface({ input: stdin, output: process.stderr });
            rl.question(question, (answer) => {
                rl.close();
                resolve(answer);
            });
        });
    }

    return new Promise((resolve) => {
        process.stderr.write(question);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        let buf = "";
        const finish = function() {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener("data", onData);
            process.stderr.write("\n");
        };
        const onData = function(chunk) {
            for (const ch of chunk) {
                if (ch === "\r" || ch === "\n") {
                    finish();
                    return resolve(buf);
                } else if (ch === "\u0003") {
                    finish();
                    process.exit(130);
                } else if (ch === "\u007f" || ch === "\b") {
                    buf = buf.slice(0, -1);
                } else {
                    buf += ch;
                }
            }
        };
        stdin.on("data", onData);
    });
};

//
// Core sync
//

/**
 * Credentials to log in with. Priority: environment > conf/config.json > saved by "login".
 */
const resolveCredentials = function() {
    if (process.env.FORPSI_USERNAME && process.env.FORPSI_PASSWORD) {
        return { username: process.env.FORPSI_USERNAME, password: process.env.FORPSI_PASSWORD, source: "environment" };
    }
    const forpsi = loadConfig().forpsi || {};
    if (forpsi.username && forpsi.password) {
        return { username: forpsi.username, password: forpsi.password, source: "config" };
    }
    const saved = auth.getSavedCredentials();
    return saved ? { username: saved.username, password: saved.password, source: "saved" } : null;
};

/**
 * Reuses the saved session if still valid, otherwise logs in with the resolved credentials.
 */
const ensureLoggedIn = async function() {
    const status = await auth.checkAuthStatus(PARTITION);
    if (status.loggedIn) {
        return status;
    }
    const creds = resolveCredentials();
    if (!creds) {
        return { loggedIn: false, error: `Not logged in. Set forpsi.username/password in ${getConfigPath()}, set FORPSI_USERNAME/FORPSI_PASSWORD or run 'dns-updater login'.` };
    }
    log(`Session expired or missing, logging in as ${creds.username} (credentials from ${creds.source})...`);
    // Only re-save credentials that came from "login"; env/config ones stay where they are
    return auth.performLogin(PARTITION, creds.username, creds.password, "", { remember: creds.source === "saved" });
};

/**
 * One update cycle. Returns true when every domain is (now) pointed at the current IP.
 */
const syncOnce = async function(opts, force = false) {
    const domains = resolveDomains(opts);
    if (domains.length === 0) {
        logError(`No domains configured. Add them to ${getConfigPath()}, or use 'dns-updater domains add <domain>', --domain or DNS_UPDATER_DOMAINS.`);
        return false;
    }

    let ip;
    try {
        ip = await getPublicIp();
    } catch (err) {
        logError(`Could not determine public IP: ${err.message}`);
        return false;
    }

    const state = loadState();
    const allSynced = domains.every((d) => {
        const info = state.domains[d];
        return info && (info.status === "synced" || info.status === "up_to_date") && info.ip === ip;
    });

    if (!force && state.lastSyncedIp === ip && allSynced) {
        log(`IP unchanged (${ip}), DNS is up to date (last synced: ${state.lastSyncedTime || "unknown"}).`);
        return true;
    }

    log(`Synchronizing ${domains.length} domain(s) to ${ip} (previous: ${state.lastSyncedIp || "none"}${force ? ", forced" : ""})...`);

    const authStatus = await ensureLoggedIn();
    if (!authStatus.loggedIn) {
        logError(`Skipping DNS update: ${authStatus.error || "login failed."}`);
        return false;
    }

    const results = await dns.updateAllDomains(PARTITION, domains, ip);
    const now = new Date().toISOString();
    let successCount = 0;

    for (const res of results) {
        if (res.success) {
            successCount++;
            state.domains[res.domain] = {
                status: res.updated ? "synced" : "up_to_date",
                ip: res.ip,
                message: res.message,
                time: now
            };
            log(`  ${res.domain}: ${res.message}`);
        } else {
            state.domains[res.domain] = {
                status: "error",
                ip: res.ip,
                message: res.error || "Update failed",
                time: now
            };
            logError(`  ${res.domain}: FAILED - ${res.error || "Update failed"}`);
        }
    }

    if (successCount > 0) {
        state.lastSyncedIp = ip;
        state.lastSyncedTime = now;
    }
    saveState(state);

    log(`Sync finished: ${successCount}/${domains.length} domain(s) pointed at ${ip}.`);
    return successCount === domains.length;
};

//
// Commands
//

const cmdRun = async function(opts) {
    let stopping = false;
    let wake = null;
    let timer = null;

    const stop = function(signal) {
        if (stopping) {
            process.exit(130);
        }
        stopping = true;
        log(`Received ${signal}, shutting down...`);
        clearTimeout(timer);
        if (wake) wake();
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));

    log(`DNS Updater started (config: ${getConfigPath()}, data dir: ${platform.getDataDir()}).`);
    let force = Boolean(opts.force);

    while (!stopping) {
        try {
            await syncOnce(opts, force);
        } catch (err) {
            logError(`Sync error: ${err.message}`);
        }
        force = false;
        if (stopping) break;

        // Re-read each cycle so "domains add" / config edits apply without restart
        const minutes = resolveIntervalMinutes(opts);
        log(`Next check in ${minutes} minute(s).`);
        await new Promise((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, minutes * 60 * 1000);
        });
    }
    return 0;
};

const cmdOnce = async function(opts) {
    return (await syncOnce(opts, Boolean(opts.force))) ? 0 : 1;
};

const cmdLogin = async function(opts) {
    const username = opts.username || process.env.FORPSI_USERNAME || await prompt("Forpsi username: ");
    const password = opts.password || process.env.FORPSI_PASSWORD || await prompt("Forpsi password: ", true);

    let result = await auth.performLogin(PARTITION, username, password, opts.otp || "");
    if (!result.loggedIn && result.need2FA && !opts.otp) {
        const otp = await prompt("Two-factor code: ");
        result = await auth.performLogin(PARTITION, username, password, otp.trim());
    }

    if (!result.loggedIn) {
        rawError(`Login failed: ${result.error || "unknown error"}`);
        return 1;
    }
    rawLog(`Logged in as ${result.username}. Credentials and session saved to ${platform.getDataDir()}`);
    if (!platform.getSafeStorage()) {
        rawLog("Note: no OS keychain in headless mode; the password is stored base64-encoded in a file readable only by this user.");
    }
    return 0;
};

const cmdLogout = async function() {
    await auth.logout(PARTITION);
    const state = loadState();
    saveState({ ...state, lastSyncedIp: null, lastSyncedTime: null, domains: {} });
    rawLog("Logged out. Saved credentials and cookies removed.");
    return 0;
};

const cmdStatus = async function(opts) {
    const [ip, authStatus] = await Promise.all([
        getPublicIp().catch((err) => `unavailable (${err.message})`),
        auth.checkAuthStatus(PARTITION)
    ]);
    const creds = resolveCredentials();
    const state = loadState();
    const domains = resolveDomains(opts);
    const configPath = getConfigPath();

    rawLog(`Config file:   ${configPath}${fs.existsSync(configPath) ? "" : " (missing, see conf/config.example.json)"}`);
    rawLog(`Data dir:      ${platform.getDataDir()}`);
    rawLog(`Session:       ${authStatus.loggedIn ? "logged in" : "not logged in"}${authStatus.error ? ` (${authStatus.error})` : ""}`);
    rawLog(`Credentials:   ${creds ? `${creds.username} (from ${creds.source})` : "none"}`);
    rawLog(`Public IP:     ${ip}`);
    rawLog(`Last synced:   ${state.lastSyncedIp ? `${state.lastSyncedIp} at ${state.lastSyncedTime}` : "never"}`);
    rawLog(`Interval:      ${resolveIntervalMinutes(opts)} minute(s)`);
    rawLog(`Domains (${domains.length}):`);
    for (const d of domains) {
        const info = state.domains[d];
        const detail = info ? `${info.status}${info.ip ? ` ${info.ip}` : ""} - ${info.message || ""} (${info.time})` : "not synced yet";
        rawLog(`  ${d}: ${detail}`);
    }
    return 0;
};

const cmdIp = async function() {
    rawLog(await getPublicIp());
    return 0;
};

const cmdDomains = async function(opts) {
    const [sub, ...args] = opts._.slice(1);
    const config = loadConfig();
    config.domains = config.domains || [];

    if (!sub || sub === "list" || sub === "ls") {
        if (config.domains.length === 0) {
            rawLog("No domains configured.");
        }
        for (const d of config.domains) {
            rawLog(d);
        }
        return 0;
    }

    if (args.length === 0) {
        throw new Error(`Usage: dns-updater domains ${sub} <domain>...`);
    }
    const names = args.map(normalizeDomain);

    if (sub === "add") {
        for (const d of names) {
            if (!config.domains.includes(d)) {
                config.domains.push(d);
            }
        }
        saveConfig(config);
        rawLog(`Domains: ${config.domains.join(", ")}`);
        return 0;
    }

    if (sub === "remove" || sub === "rm") {
        config.domains = config.domains.filter((d) => !names.includes(d));
        saveConfig(config);
        const state = loadState();
        for (const d of names) {
            delete state.domains[d];
        }
        saveState(state);
        rawLog(`Domains: ${config.domains.join(", ") || "(none)"}`);
        return 0;
    }

    throw new Error(`Unknown domains subcommand: ${sub}`);
};

const COMMANDS = {
    run: cmdRun,
    once: cmdOnce,
    login: cmdLogin,
    logout: cmdLogout,
    status: cmdStatus,
    ip: cmdIp,
    domains: cmdDomains
};

const main = async function() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        rawError(`${err.message}\n\n${USAGE}`);
        return 2;
    }

    const command = opts._[0] || "run";
    if (opts.help || command === "help") {
        rawLog(USAGE);
        return 0;
    }

    const handler = COMMANDS[command];
    if (!handler) {
        rawError(`Unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }

    setupConsole(Boolean(opts.verbose));
    if (opts["conf-dir"]) {
        setConfDir(opts["conf-dir"]);
    }
    if (opts["data-dir"]) {
        platform.setDataDir(opts["data-dir"]);
    }

    // Load persisted session cookies into the in-memory jar
    await auth.restoreCookies(PARTITION);
    return handler(opts);
};

// Run only when executed directly; tests require() this file for its helpers
if (require.main === module) {
    main().then(
        (code) => process.exit(code || 0),
        (err) => {
            rawError(`Error: ${err.message}`);
            process.exit(1);
        }
    );
}

module.exports = {
    parseArgs,
    setConfDir,
    getConfDir,
    getConfigPath,
    loadConfig,
    saveConfig,
    loadState,
    saveState,
    normalizeDomain,
    resolveDomains,
    resolveIntervalMinutes,
    resolveIpCheckUrl,
    resolveCredentials
};
