"use strict";

const platform = require("./platform.js");
const https = require("node:https");
const { URL } = require("node:url");
const fs = require("node:fs");
const path = require("node:path");

const LOGIN_AJAX_URL = "https://admin.forpsi.hu/login-ajax.php";
const INDEX_URL = "https://admin.forpsi.hu/index.php";
const DOMAINS_LIST_URL = "https://admin.forpsi.hu/domain/domains-list.php";
const COOKIES_FILE_NAME = "forpsi_cookies.json";
const CREDENTIALS_FILE_NAME = "forpsi_credentials.json";

const getFilePath = function(filename) {
    return path.join(platform.getDataDir(), filename);
};

/**
 * Writes a file readable only by the current user (no-op permissions on Windows).
 */
const writePrivateFile = function(filePath, content) {
    fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch {}
};

/**
 * Encrypts and saves user credentials locally.
 */
const saveCredentials = function(username, password) {
    try {
        const filePath = getFilePath(CREDENTIALS_FILE_NAME);
        const safeStorage = platform.getSafeStorage();
        let storedPassword = password;
        let isEncrypted = false;

        if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
            storedPassword = safeStorage.encryptString(password).toString("base64");
            isEncrypted = true;
        } else {
            storedPassword = Buffer.from(password, "utf8").toString("base64");
        }

        const data = {
            username: username,
            password: storedPassword,
            isEncrypted: isEncrypted,
            savedAt: new Date().toISOString()
        };

        writePrivateFile(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (err) {
        console.error("[Auth] Error saving credentials:", err);
        return false;
    }
};

/**
 * Loads and decrypts saved credentials.
 */
const getSavedCredentials = function() {
    // Headless mode: credentials may come from the environment instead of disk
    if (!platform.isElectron && process.env.FORPSI_USERNAME && process.env.FORPSI_PASSWORD) {
        return {
            username: process.env.FORPSI_USERNAME,
            password: process.env.FORPSI_PASSWORD
        };
    }

    try {
        const filePath = getFilePath(CREDENTIALS_FILE_NAME);
        if (!fs.existsSync(filePath)) {
            return null;
        }

        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);
        if (!data || !data.username || !data.password) {
            return null;
        }

        const safeStorage = platform.getSafeStorage();
        let decryptedPassword = "";
        if (data.isEncrypted) {
            if (!safeStorage || !safeStorage.decryptString) {
                console.warn("[Auth] Saved credentials are encrypted with the desktop app's OS keychain and cannot be read here. Log in again or set FORPSI_USERNAME/FORPSI_PASSWORD.");
                return null;
            }
            decryptedPassword = safeStorage.decryptString(Buffer.from(data.password, "base64"));
        } else {
            decryptedPassword = Buffer.from(data.password, "base64").toString("utf8");
        }

        return {
            username: data.username,
            password: decryptedPassword
        };
    } catch (err) {
        console.error("[Auth] Error reading credentials:", err);
        return null;
    }
};

/**
 * Clears saved credentials from disk.
 */
const clearCredentials = function() {
    try {
        const filePath = getFilePath(CREDENTIALS_FILE_NAME);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        return true;
    } catch (err) {
        console.error("[Auth] Error clearing credentials:", err);
        return false;
    }
};

/**
 * Restores saved cookies from disk into the session partition.
 */
const restoreCookies = async function(partition) {
    try {
        const filePath = getFilePath(COOKIES_FILE_NAME);
        if (!fs.existsSync(filePath)) {
            return false;
        }

        const raw = fs.readFileSync(filePath, "utf8");
        const cookies = JSON.parse(raw);
        if (!Array.isArray(cookies) || cookies.length === 0) {
            return false;
        }

        const jar = platform.getCookieJar(partition);
        const thirtyDaysFromNow = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);

        for (const c of cookies) {
            try {
                const domain = c.domain ? (c.domain.startsWith(".") ? c.domain.slice(1) : c.domain) : "forpsi.hu";
                const cookieUrl = `https://${domain}${c.path || "/"}`;
                
                await jar.set({
                    url: cookieUrl,
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path || "/",
                    secure: c.secure !== false,
                    httpOnly: c.httpOnly || false,
                    expirationDate: c.expirationDate && c.expirationDate > Math.floor(Date.now() / 1000) ? c.expirationDate : thirtyDaysFromNow,
                    sameSite: c.sameSite || "unspecified"
                });
            } catch (err) {
                console.warn(`[Auth] Warning: Could not restore cookie ${c.name}:`, err.message);
            }
        }
        return true;
    } catch (err) {
        console.error("[Auth] Error restoring cookies:", err);
        return false;
    }
};

/**
 * Saves current partition cookies to persistent disk storage.
 */
const saveCookies = async function(partition) {
    try {
        const jar = platform.getCookieJar(partition);
        const allCookies = await jar.get().catch(() => []);
        
        const forpsiCookies = allCookies.filter(cookie => {
            const domain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
            return domain.includes("forpsi");
        });

        if (forpsiCookies.length === 0) {
            return false;
        }

        const thirtyDaysFromNow = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
        const persistCookies = forpsiCookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            expirationDate: c.expirationDate && c.expirationDate > Math.floor(Date.now() / 1000) ? c.expirationDate : thirtyDaysFromNow
        }));

        for (const c of persistCookies) {
            try {
                const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
                await jar.set({
                    url: `https://${domain}${c.path || "/"}`,
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path,
                    secure: c.secure,
                    httpOnly: c.httpOnly,
                    expirationDate: c.expirationDate,
                    sameSite: c.sameSite || "unspecified"
                });
            } catch {}
        }

        const filePath = getFilePath(COOKIES_FILE_NAME);
        writePrivateFile(filePath, JSON.stringify(persistCookies, null, 2));
        return true;
    } catch (err) {
        console.error("[Auth] Error saving cookies:", err);
        return false;
    }
};

/**
 * Parses Set-Cookie headers into cookie objects
 */
const parseSetCookieHeaders = function(rawHeaders) {
    if (!rawHeaders) return [];
    const setCookieList = Array.isArray(rawHeaders) ? rawHeaders : [rawHeaders];
    const parsed = [];
    
    for (const str of setCookieList) {
        if (!str) continue;
        const parts = str.split(";").map(p => p.trim());
        const [nameVal, ...attrs] = parts;
        const eqIdx = nameVal.indexOf("=");
        if (eqIdx === -1) continue;
        const name = nameVal.slice(0, eqIdx).trim();
        const value = nameVal.slice(eqIdx + 1).trim();
        
        let domain = ".forpsi.hu";
        let path = "/";
        let secure = true;
        let httpOnly = false;
        
        for (const attr of attrs) {
            const [k, v] = attr.split("=").map(s => s ? s.trim() : "");
            const lowerK = k.toLowerCase();
            if (lowerK === "domain" && v) domain = v;
            else if (lowerK === "path" && v) path = v;
            else if (lowerK === "secure") secure = true;
            else if (lowerK === "httponly") httpOnly = true;
        }

        parsed.push({ name, value, domain, path, secure, httpOnly });
    }
    return parsed;
};

/**
 * Performs direct programmatic login using Forpsi's login-ajax.php endpoint.
 */
const performLogin = async function(partition, username, password, otpCode = "", options = {}) {
    const cleanUsername = (username || "").trim();
    const cleanPassword = password || "";

    if (!cleanUsername || !cleanPassword) {
        return { success: false, loggedIn: false, error: "Please enter both username and password." };
    }

    try {
        const jar = platform.getCookieJar(partition);
        console.log(`[Auth] Attempting login for: ${cleanUsername}`);

        // Step 1: Initial GET to obtain session and language cookies
        const initialCookies = await new Promise((resolve) => {
            const req = https.request({
                hostname: "admin.forpsi.hu",
                path: "/index.php",
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7"
                }
            }, (res) => {
                const setCookies = res.headers["set-cookie"] || [];
                const parsed = parseSetCookieHeaders(setCookies);
                resolve(parsed);
            });
            req.on("error", () => resolve([]));
            req.setTimeout(8000, () => { req.destroy(); resolve([]); });
            req.end();
        });

        // Set initial cookies into partition
        for (const c of initialCookies) {
            try {
                const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
                await jar.set({
                    url: `https://${domain}${c.path || "/"}`,
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path,
                    secure: c.secure,
                    httpOnly: c.httpOnly
                });
            } catch {}
        }

        const currentCookies = await jar.get().catch(() => []);
        const cookieHeader = currentCookies
            .filter(c => c.domain.includes("forpsi"))
            .map(c => `${c.name}=${c.value}`)
            .join("; ");

        // Step 2: POST to /login-ajax.php with both user_name & login_user_name formats
        const postParams = new URLSearchParams({
            login_action: "client_login",
            user_name: cleanUsername,
            password: cleanPassword,
            otp_code: otpCode || "",
            login_user_name: cleanUsername,
            login_password: cleanPassword,
            login_otp_code: otpCode || ""
        });
        const postData = postParams.toString();

        const ajaxResult = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: "admin.forpsi.hu",
                path: "/login-ajax.php",
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "X-Requested-With": "XMLHttpRequest",
                    "Content-Length": Buffer.byteLength(postData),
                    "Cookie": cookieHeader,
                    "Origin": "https://admin.forpsi.hu",
                    "Referer": "https://admin.forpsi.hu/index.php",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Accept-Language": "hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7"
                }
            }, (res) => {
                const newCookies = parseSetCookieHeaders(res.headers["set-cookie"] || []);
                let body = "";
                res.setEncoding("utf8");
                res.on("data", chunk => { body += chunk; });
                res.on("end", () => {
                    let json = null;
                    try {
                        json = JSON.parse(body);
                    } catch {}
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        cookies: newCookies,
                        json: json,
                        raw: body
                    });
                });
            });

            req.on("error", reject);
            req.setTimeout(12000, () => { req.destroy(new Error("Login request timed out.")); });
            req.write(postData);
            req.end();
        });

        // Set any new cookies into session
        if (ajaxResult.cookies && ajaxResult.cookies.length > 0) {
            for (const c of ajaxResult.cookies) {
                try {
                    const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
                    await jar.set({
                        url: `https://${domain}${c.path || "/"}`,
                        name: c.name,
                        value: c.value,
                        domain: c.domain,
                        path: c.path,
                        secure: c.secure,
                        httpOnly: c.httpOnly
                    });
                } catch {}
            }
        }

        console.log("[Auth] AJAX result:", ajaxResult.json || ajaxResult.raw);

        // Check if 2FA code is needed
        if (ajaxResult.json && ajaxResult.json.need_2fa) {
            return {
                success: false,
                loggedIn: false,
                need2FA: true,
                error: "Two-factor authentication code (OTP) required."
            };
        }

        // Check if explicit error returned
        if (ajaxResult.json && Array.isArray(ajaxResult.json.errors) && ajaxResult.json.errors.length > 0) {
            return {
                success: false,
                loggedIn: false,
                error: ajaxResult.json.errors.join(", ")
            };
        }

        // Step 3: Verify against domains-list.php
        const authStatus = await checkAuthStatus(partition);
        console.log("[Auth] Verification result:", authStatus);

        if (authStatus.loggedIn || (ajaxResult.json && ajaxResult.json.user)) {
            if (options.remember !== false) {
                saveCredentials(cleanUsername, cleanPassword);
            }
            await saveCookies(partition);
            return {
                success: true,
                loggedIn: true,
                username: cleanUsername
            };
        } else {
            return {
                success: false,
                loggedIn: false,
                error: "Invalid username or password. Please verify your credentials."
            };
        }
    } catch (err) {
        console.error("[Auth] Login error:", err);
        return {
            success: false,
            loggedIn: false,
            error: err.message || "An error occurred during login."
        };
    }
};

/**
 * Checks if the user is currently logged into Forpsi.
 */
const checkAuthStatus = async function(partition) {
    try {
        const jar = platform.getCookieJar(partition);
        let allCookies = await jar.get().catch(() => []);
        
        if (allCookies.length === 0) {
            await restoreCookies(partition);
            allCookies = await jar.get().catch(() => []);
        }

        const forpsiCookies = allCookies.filter(cookie => {
            const domain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
            return domain.includes("forpsi");
        });

        const cookieHeader = forpsiCookies.map(c => `${c.name}=${c.value}`).join("; ");

        const response = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: "admin.forpsi.hu",
                path: "/domain/domains-list.php",
                method: "GET",
                headers: {
                    "Cookie": cookieHeader,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7",
                    "Cache-Control": "no-cache",
                    "Pragma": "no-cache"
                }
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const loc = res.headers.location;
                    if (loc.includes("index.php") || loc.includes("login")) {
                        return resolve({ statusCode: res.statusCode, isRedirectToLogin: true, html: "" });
                    }
                }

                let html = "";
                res.setEncoding("utf8");
                res.on("data", chunk => { html += chunk; });
                res.on("end", () => {
                    resolve({ statusCode: res.statusCode, isRedirectToLogin: false, html: html });
                });
            });

            req.on("error", reject);
            req.setTimeout(10000, () => { req.destroy(new Error("Request timeout")); });
            req.end();
        });

        if (response.isRedirectToLogin) {
            return { loggedIn: false, statusCode: response.statusCode };
        }

        const html = response.html || "";
        const hasLoginForm = html.includes('name="login_action"') ||
                             html.includes("login_action") ||
                             html.includes('name="login_password"') ||
                             html.includes('id="login_password"') ||
                             html.includes('data-ga="admin-login"');

        const hasAdminIndicator = html.includes("domains-list") ||
                                  html.includes("admin-logout") ||
                                  html.includes("Domainek") ||
                                  html.includes("Domain lista") ||
                                  html.includes("logout");

        const isLoggedIn = !hasLoginForm && (hasAdminIndicator || response.statusCode === 200);

        if (isLoggedIn) {
            await saveCookies(partition);
        }

        const savedCreds = getSavedCredentials();

        return {
            loggedIn: isLoggedIn,
            username: savedCreds ? savedCreds.username : null,
            statusCode: response.statusCode
        };
    } catch (err) {
        console.error("[Auth] checkAuthStatus error:", err);
        return {
            loggedIn: false,
            error: err.message
        };
    }
};

/**
 * Attempts automatic login using saved credentials if available.
 */
const autoLoginIfSaved = async function(partition) {
    const creds = getSavedCredentials();
    if (!creds || !creds.username || !creds.password) {
        return { loggedIn: false, autoLoginAttempted: false };
    }

    const check = await checkAuthStatus(partition);
    if (check.loggedIn) {
        return check;
    }

    console.log("[Auth] Session expired or empty. Auto-logging in with saved credentials...");
    const loginResult = await performLogin(partition, creds.username, creds.password);
    return loginResult;
};

/**
 * Logs out, clears saved credentials, cookies, and partition storage.
 */
const logout = async function(partition) {
    try {
        clearCredentials();
        const cookiesPath = getFilePath(COOKIES_FILE_NAME);
        if (fs.existsSync(cookiesPath)) {
            try { fs.unlinkSync(cookiesPath); } catch {}
        }

        const jar = platform.getCookieJar(partition);
        await jar.clear();
        console.log("[Auth] Logged out and cleared credentials/cookies.");
        return { loggedIn: false };
    } catch (err) {
        return { loggedIn: false, error: err.message };
    }
};

module.exports = {
    performLogin,
    checkAuthStatus,
    autoLoginIfSaved,
    getSavedCredentials,
    saveCredentials,
    clearCredentials,
    logout,
    restoreCookies,
    saveCookies
};
