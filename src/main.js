"use strict";

// import libs
const {
    app,
    Tray,
    Menu,
    MenuItem,
    BrowserWindow,
    ipcMain,
    protocol,
    net,
    session,
    screen,
    desktopCapturer,
    dialog
} = require("electron");
const path = require("node:path");
const url = require("node:url");
const os = require("node:os");
const cmd = require("node:child_process");
const auth = require("./electron/auth.js");
const dns = require("./electron/dns.js");
const partition = "persist:dns_provider_session";

//
// main app
//
const main = async function() {
    let winMain = null;
    
    // Lock
    const isGotLock = app.requestSingleInstanceLock();
    if (!isGotLock) {
        app.quit();
        return;
    }
    app.on("second-instance", function(event, commandLine, workingDirectory) {
        if (winMain) {
            if (winMain.isMinimized()) {
                winMain.restore();
            } else if (!winMain.isVisible()) {
                winMain.show();
            }
            winMain.focus();
        }
    });
    
    // Simulate web server at local://local.local
    protocol.registerSchemesAsPrivileged([
        {
            "scheme": "local",
            "privileges": {
                "standard": true,
                "secure": true,
                "bypassCSP": true,
                "allowServiceWorkers": true,
                "supportFetchAPI": true,
                "corsEnabled": true,
                "stream": true
            }
        }
    ]);
    
    // Wait for load
    await app.whenReady();

    // Restore saved cookies for provider partition
    await auth.restoreCookies(partition);

    // Simulate web server at local://local.local
    const ses = session.fromPartition(partition);
    ses.protocol.handle("local", function(req) {
        let { pathname } = new URL(req.url);
        if (pathname === "/" || pathname === "") {
            pathname = "index.html";
        }
        // NB, this does not check for paths that escape the bundle, e.g.
        // app://bundle/../../secret_file.txt
        const pathFull = url.pathToFileURL(path.join(__dirname, "renderer", pathname)).toString();
        return net.fetch(pathFull);
    });
    
    // Main window create "local://local.local/"
    const createMainWindow = function(url="local://local.local/") {
        const win = new BrowserWindow({
            "width": 800,
            "height": 600,
            "icon": path.join(__dirname, "icons/app-256.png"),
            "webPreferences": {
                "partition": partition,
                "contextIsolation": false,
                "nodeIntegration": true,
                "nodeIntegrationInWorker": false,
                "devTools": true
            }
        });
        
        win.loadURL(url);
        win.setMenu(null);
        win.on("close", function(event) {
            if (tray !== null) {
                event.preventDefault();
                win.hide();
            }
        });

        // Track Escape key timeout
        let escapeTimeout = null;

        // Note: remove "async" here to guarantee synchronous preventDefault()
        win.webContents.on("before-input-event", function(event, input) {
            
            // Developer tools shortcut
            if (input.type === "keyDown" && input.key === "F12") {
                if (win.webContents.isDevToolsOpened()) {
                    win.webContents.closeDevTools();
                } else {
                    win.webContents.openDevTools({
                        "mode": "right"
                    });
                }
            }
        });
        return win;
    };
    winMain = createMainWindow();
    app.on("activate", function() {
        if (BrowserWindow.getAllWindows().length === 0) {
            winMain = createMainWindow();
            //winMain.webContents.send("api", "log", "Logging");
        }
    });
    
    // Tray
    let menu = new Menu();
    const menuOpen = new MenuItem({
        "type": "normal",
        "label": "Open",
        "click": function() {
            if (winMain) {
                winMain.show();
            }
        }
    });
    menu.append(menuOpen);
    const menuClose = new MenuItem({
        "type": "normal",
        "label": "Close",
        "click": function() {
            if (winMain) {
                app.exit();
            }
        }
    });
    menu.append(menuClose);

    let tray = null;
    
    // Free when closed
    app.on("window-all-closed", function() {
        app.exit();
    });
    
    // External API
    const handleAPI = async function(handle, ...args) {
        if (handle === "path-exe") {
            return app.getPath("exe");
        } else if (handle === "path-app") {
            return __dirname;
        } else if (handle === "set-tray") {
            const isOn = args[0];
            if (isOn && tray === null) {
                tray = new Tray(path.join(__dirname, "icons/tray-32.png"));
                tray.on("click", function() {
                    if (winMain) {
                        winMain.show();
                    }
                });
                tray.setContextMenu(menu);
            } else if (!isOn && tray !== null) {
                tray.destroy();
                tray = null;
            }
                
        } else if (handle === "login") {
            const username = args[0];
            const password = args[1];
            const otpCode = args[2] || "";
            return await auth.performLogin(partition, username, password, otpCode);
        } else if (handle === "check-auth") {
            return await auth.checkAuthStatus(partition);
        } else if (handle === "auto-login") {
            return await auth.autoLoginIfSaved(partition);
        } else if (handle === "get-saved-credentials") {
            const creds = auth.getSavedCredentials();
            return creds ? { username: creds.username } : null;
        } else if (handle === "logout") {
            return await auth.logout(partition);
        } else if (handle === "get-forpsi-domains") {
            return await dns.getDomainsList(partition);
        } else if (handle === "update-dns") {
            const domainNames = args[0];
            const currentIp = args[1];
            return await dns.updateAllDomains(partition, domainNames, currentIp);
        } else if (handle === "set-tray-text") {
            if (tray === null) {
                return false;
            }
            let openLabel = args[0];
            let closeLabel = args[1];
            menu = new Menu();
            const menuOpen = new MenuItem({
                "type": "normal",
                "label": openLabel,
                "click": function() {
                    if (winMain) {
                        winMain.show();
                    }
                }
            });
            menu.append(menuOpen);
            const menuClose = new MenuItem({
                "type": "normal",
                "label": closeLabel,
                "click": function() {
                    if (winMain) {
                        app.exit();
                    }
                }
            });
            menu.append(menuClose);
            tray.setContextMenu(menu);
            return true;
        }
    };
    ipcMain.on("api", async function(event, ...args) {
        await handleAPI(...args);
    });
    ipcMain.handle("api", async function(event, ...args) {
        return await handleAPI(...args);
    });
}
main();