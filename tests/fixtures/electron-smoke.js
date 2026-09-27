"use strict";

// Electron entry point for the desktop smoke test: starts the real app (src/main.js),
// waits for the window to load, then exits 0 and prints SMOKE_OK. Exits 1 with
// SMOKE_FAIL if the main process throws, the page fails to load, the renderer crashes
// or logs an uncaught error.

const path = require("node:path");
const { app } = require("electron");

// Isolated profile: separate single-instance lock, cookies and IndexedDB
if (process.env.DNS_UPDATER_DATA_DIR) {
    app.setPath("userData", process.env.DNS_UPDATER_DATA_DIR);
}

const SETTLE_MS = 3000;

const fail = function(reason) {
    console.error(`SMOKE_FAIL: ${reason}`);
    app.exit(1);
};

process.on("uncaughtException", (err) => fail(`main process: ${err.stack || err}`));
process.on("unhandledRejection", (err) => fail(`main process rejection: ${err && err.stack || err}`));

app.on("browser-window-created", function(event, win) {
    const contents = win.webContents;
    contents.on("did-fail-load", (e, code, description, url) => fail(`load failed for ${url}: ${description} (${code})`));
    contents.on("render-process-gone", (e, details) => fail(`renderer gone: ${details.reason}`));
    contents.on("console-message", function(...args) {
        // Electron >= 35 passes a single details object; older versions (event, level, message)
        const message = String(args[0] && args[0].message !== undefined ? args[0].message : args[2]);
        if (message.startsWith("Uncaught")) {
            fail(`renderer: ${message}`);
        }
    });
    contents.once("did-finish-load", function() {
        // Let the renderer's startup code run before declaring success
        setTimeout(function() {
            console.log("SMOKE_OK");
            app.exit(0);
        }, SETTLE_MS);
    });
});

require(path.join(__dirname, "..", "..", "src", "main.js"));
