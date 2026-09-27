"use strict";

// Runtime abstraction so auth.js / dns.js work both inside the Electron GUI
// and under plain Node (headless CLI, see ../cli.js).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_NAME = "dns-updater";

// require("electron") only yields the API object inside a real Electron main
// process; under plain Node (or ELECTRON_RUN_AS_NODE) it throws or returns a path.
let electron = null;
try {
    const mod = require("electron");
    if (mod && typeof mod === "object" && mod.app) {
        electron = mod;
    }
} catch {}

const isElectron = electron !== null;

let dataDirOverride = null;

/**
 * Overrides the directory used for credentials/cookies/config (CLI --data-dir).
 */
const setDataDir = function(dir) {
    dataDirOverride = dir ? path.resolve(dir) : null;
};

/**
 * Directory holding persistent files. Under Node this mirrors Electron's
 * userData location so the GUI and CLI share cookies on the same machine.
 */
const getDataDir = function() {
    let dir = dataDirOverride || process.env.DNS_UPDATER_DATA_DIR || null;
    if (!dir && isElectron) {
        try {
            dir = electron.app.getPath("userData");
        } catch {}
    }
    if (!dir) {
        if (process.platform === "win32") {
            dir = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
        } else if (process.platform === "darwin") {
            dir = path.join(os.homedir(), "Library", "Application Support", APP_NAME);
        } else {
            dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), APP_NAME);
        }
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

/**
 * OS-keychain backed encryption (Electron safeStorage) or null when unavailable.
 */
const getSafeStorage = function() {
    if (!isElectron || !electron.safeStorage) {
        return null;
    }
    return electron.safeStorage;
};

/**
 * Minimal in-memory cookie store with the same surface as Electron's session.cookies.
 */
const createMemoryJar = function() {
    const store = new Map();
    const keyOf = (c) => `${c.domain}|${c.path}|${c.name}`;

    return {
        get: async function() {
            const now = Date.now() / 1000;
            const result = [];
            for (const [key, c] of store) {
                if (c.expirationDate && c.expirationDate < now) {
                    store.delete(key);
                    continue;
                }
                result.push({ ...c });
            }
            return result;
        },
        set: async function(details) {
            let domain = details.domain;
            if (!domain && details.url) {
                domain = new URL(details.url).hostname;
            }
            const cookie = {
                name: details.name,
                value: details.value,
                domain: domain || "",
                path: details.path || "/",
                secure: Boolean(details.secure),
                httpOnly: Boolean(details.httpOnly),
                sameSite: details.sameSite || "unspecified",
                expirationDate: details.expirationDate
            };
            store.set(keyOf(cookie), cookie);
        },
        clear: async function() {
            store.clear();
        }
    };
};

const memoryJars = new Map();

/**
 * Returns the cookie jar for a partition: Electron session cookies in the GUI,
 * a process-local memory jar under Node (persisted via auth.saveCookies).
 */
const getCookieJar = function(partition) {
    if (isElectron) {
        const ses = electron.session.fromPartition(partition);
        return {
            get: () => ses.cookies.get({}),
            set: (details) => ses.cookies.set(details),
            clear: () => ses.clearStorageData({
                storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"]
            })
        };
    }
    if (!memoryJars.has(partition)) {
        memoryJars.set(partition, createMemoryJar());
    }
    return memoryJars.get(partition);
};

module.exports = {
    isElectron,
    setDataDir,
    getDataDir,
    getSafeStorage,
    getCookieJar
};
