"use strict";

// Packages the desktop app: downloads the Electron binaries for the target platform
// and copies the app next to them as an unpacked resources/app folder (no asar), so
// the bundled CLI can run it with ELECTRON_RUN_AS_NODE.
//
// Usage: node scripts/build.js [--platform win32|linux|darwin] [--arch x64|arm64]

const fs = require("node:fs");
const path = require("node:path");
const { packager } = require("@electron/packager");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist");

// Only these paths (relative to the repo root) go into resources/app
const INCLUDE = ["package.json", "src", "conf/config.example.json"];

const parseArgs = function(argv) {
    const opts = { platform: process.platform, arch: process.arch };
    for (let i = 0; i < argv.length; i++) {
        const [name, value] = argv[i].replace(/^--/, "").split(/=(.*)/s);
        if (name === "platform" || name === "arch") {
            opts[name] = value !== undefined ? value : argv[++i];
        } else {
            throw new Error(`Unknown option: ${argv[i]}`);
        }
    }
    return opts;
};

/**
 * Whitelist filter: keeps INCLUDE entries, their parents and their contents.
 */
const isIgnored = function(filePath) {
    let rel = filePath.startsWith(ROOT) ? path.relative(ROOT, filePath) : filePath.replace(/^[\\/]+/, "");
    rel = rel.split(path.sep).join("/");
    if (rel === "") {
        return false;
    }
    return !INCLUDE.some((inc) => rel === inc || rel.startsWith(inc + "/") || inc.startsWith(rel + "/"));
};

/**
 * Copies the platform's CLI launcher next to the executable.
 */
const copyLauncher = async function({ buildPath, platform }) {
    if (platform === "win32") {
        fs.copyFileSync(path.join(ROOT, "deploy", "dns-updater-cli.cmd"), path.join(buildPath, "dns-updater-cli.cmd"));
    }
};

const main = async function() {
    const opts = parseArgs(process.argv.slice(2));
    const appPaths = await packager({
        "dir": ROOT,
        "out": OUT_DIR,
        "platform": opts.platform,
        "arch": opts.arch,
        "executableName": "dns-updater",
        "asar": false,
        "prune": true,
        "overwrite": true,
        "ignore": isIgnored,
        "afterComplete": [copyLauncher]
    });
    for (const appPath of appPaths) {
        console.log(`Built: ${path.relative(ROOT, appPath)}`);
    }
};

// Run only when executed directly; tests require() this file for isIgnored
if (require.main === module) {
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}

module.exports = {
    isIgnored
};
