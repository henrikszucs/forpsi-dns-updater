"use strict";

// Checks that the program actually runs under Electron: the binary loads, the CLI works
// in ELECTRON_RUN_AS_NODE mode (as the Windows launcher uses it), and the desktop app
// opens its window without errors. Skipped when there is no display.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ROOT, CLI_PATH, makeTempDir, childEnv } = require("./helpers.js");

const electronPath = require("electron");
const SMOKE_SCRIPT = path.join(__dirname, "fixtures", "electron-smoke.js");

const LINUX_LIBS_HINT = "Install Electron's system libraries, e.g. on Debian/Ubuntu:\n" +
    "    sudo apt install libnss3 libnspr4 libgbm1 libgtk-3-0 libasound2t64";

const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/**
 * Fails with an install hint when Electron cannot start because of missing shared libraries.
 */
const assertNoMissingLibs = function(res) {
    const output = `${res.stdout || ""}${res.stderr || ""}`;
    const missing = output.match(/error while loading shared libraries: ([^\s:]+)/);
    if (missing) {
        assert.fail(`Electron cannot start: ${missing[1]} is missing.\n${LINUX_LIBS_HINT}`);
    }
};

test.describe("electron", () => {
    test.it("binary loads", () => {
        const res = spawnSync(electronPath, ["--version"], { encoding: "utf8", timeout: 30000 });
        assertNoMissingLibs(res);
        assert.equal(res.status, 0, res.stderr);
        assert.match(res.stdout, /^v\d+\.\d+\.\d+/);
    });

    test.it("runs the CLI as plain Node (ELECTRON_RUN_AS_NODE)", () => {
        const res = spawnSync(electronPath, [CLI_PATH, "help"], {
            encoding: "utf8",
            timeout: 30000,
            env: childEnv({ ELECTRON_RUN_AS_NODE: "1" })
        });
        assertNoMissingLibs(res);
        assert.equal(res.status, 0, res.stderr);
        assert.match(res.stdout, /Usage: dns-updater <command>/);
    });

    test.it("desktop app opens its window without errors", { skip: hasDisplay ? false : "no display (DISPLAY/WAYLAND_DISPLAY unset)" }, () => {
        const res = spawnSync(electronPath, [SMOKE_SCRIPT], {
            cwd: ROOT,
            encoding: "utf8",
            timeout: 60000,
            env: childEnv({ DNS_UPDATER_DATA_DIR: makeTempDir(), ELECTRON_ENABLE_LOGGING: "1" })
        });
        assertNoMissingLibs(res);
        const output = `${res.stdout}\n${res.stderr}`;
        assert.doesNotMatch(output, /SMOKE_FAIL/, output);
        assert.equal(res.status, 0, output);
        assert.match(res.stdout, /SMOKE_OK/);
    });
});
