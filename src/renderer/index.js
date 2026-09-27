"use strict";

import IDB from "./libs/idb/idb.js";

const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const { ipcRenderer } = require("electron");
const appPath = await ipcRenderer.invoke("api", "path-app");
const exePath = await ipcRenderer.invoke("api", "path-exe");
const AutoLaunch = require(path.join(appPath, "renderer", "libs/auto-launch/auto-launch.js"));

const IP_CHECK_URL = "https://api.ipify.org?format=json";
const DEFAULT_INTERVAL_MINUTES = 5;
const DOMAIN_DB_NAME = "dns_updater";
const DOMAIN_TABLE_NAME = "domains";
const DOMAIN_REGEX = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

// UI Elements - General
const elIp = document.getElementById("text-ip");
const elCountdown = document.getElementById("text-countdown");
const elInterval = document.getElementById("input-interval");
const elRefreshBtn = document.getElementById("btn-refresh");

// UI Elements - Header Auth
const elHeaderAuthBadge = document.getElementById("header-auth-badge");
const elHeaderAuthIcon = document.getElementById("header-auth-icon");
const elHeaderAuthText = document.getElementById("header-auth-text");
const elHeaderBtnLogout = document.getElementById("header-btn-logout");

// UI Elements - Auth Card
const elCardAuth = document.getElementById("card-auth");
const elIconAuthStatus = document.getElementById("icon-auth-status");
const elTextAuthStatus = document.getElementById("text-auth-status");
const elContainerLoginForm = document.getElementById("container-login-form");
const elContainerLoggedIn = document.getElementById("container-logged-in");
const elTextLoggedUser = document.getElementById("text-logged-user");

// UI Elements - Form Inputs
const elFieldUsername = document.getElementById("field-username");
const elFieldPassword = document.getElementById("field-password");
const elInputUsername = document.getElementById("input-username");
const elInputPassword = document.getElementById("input-password");
const elBtnLoginSubmit = document.getElementById("btn-login-submit");
const elTextAuthError = document.getElementById("text-auth-error");
const elBtnLogout = document.getElementById("btn-logout");
const elBtnRecheckAuth = document.getElementById("btn-recheck-auth");

// UI Elements - Domains
const elDomainField = document.getElementById("field-domain");
const elDomainInput = document.getElementById("input-domain");
const elDomainAddBtn = document.getElementById("btn-domain-add");
const elDomainList = document.getElementById("list-domains");
const elTextSyncStatus = document.getElementById("text-sync-status");

let nextRefreshAt = 0;
let domains = [];
let isUserLoggedIn = false;
let isSubmitting = false;
let isSyncing = false;

// Persistent IP & Sync State
let lastSyncedIp = localStorage.getItem("dns_last_synced_ip") || null;
let lastSyncedTime = localStorage.getItem("dns_last_synced_time") || null;
let domainSyncStatuses = {};
try {
    domainSyncStatuses = JSON.parse(localStorage.getItem("dns_domain_statuses") || "{}");
} catch {
    domainSyncStatuses = {};
}

// Format ms as m:ss for the countdown text
const formatCountdown = function(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const getIntervalMs = function() {
    const minutes = Math.max(1, Number(elInterval.value) || DEFAULT_INTERVAL_MINUTES);
    return minutes * 60 * 1000;
};

const fetchCurrentIp = async function() {
    try {
        const res = await fetch(IP_CHECK_URL);
        const data = await res.json();
        elIp.textContent = data.ip;
        return data.ip;
    } catch (err) {
        elIp.textContent = "Unable to fetch IP";
        return null;
    }
};

const scheduleNextRefresh = function() {
    nextRefreshAt = Date.now() + getIntervalMs();
    elCountdown.textContent = formatCountdown(nextRefreshAt - Date.now());
};

// Database helper
const withDomainsTable = async function(fn) {
    await IDB.TableSet(DOMAIN_DB_NAME, DOMAIN_TABLE_NAME);
    const db = await IDB.DatabaseGet(DOMAIN_DB_NAME);
    const table = IDB.TableGet(db, DOMAIN_TABLE_NAME);
    const result = await fn(table);
    db.close();
    return result;
};

const renderDomains = function() {
    elDomainList.innerHTML = "";
    if (domains.length === 0) {
        elDomainList.innerHTML = `<p class="small-text">No domains added yet.</p>`;
        return;
    }
    for (const domain of domains) {
        const row = document.createElement("div");
        row.className = "row middle";

        const syncInfo = domainSyncStatuses[domain];
        let statusBadgeHtml = "";

        if (syncInfo) {
            if (syncInfo.status === "updating") {
                statusBadgeHtml = `<span class="chip small surface-variant"><i class="small">sync</i>Syncing...</span>`;
            } else if (syncInfo.status === "synced") {
                statusBadgeHtml = `<span class="chip small primary-container" title="${syncInfo.message || ''}"><i class="small">check</i>${syncInfo.ip}</span>`;
            } else if (syncInfo.status === "up_to_date") {
                statusBadgeHtml = `<span class="chip small surface-variant" title="${syncInfo.message || ''}"><i class="small">check</i>${syncInfo.ip}</span>`;
            } else if (syncInfo.status === "error") {
                statusBadgeHtml = `<span class="chip small error-container" title="${syncInfo.message || 'Error updating'}"><i class="small">error</i>Failed</span>`;
            }
        }

        row.innerHTML = `
            <i>language</i>
            <div class="max">
                <div>${domain}</div>
            </div>
            ${statusBadgeHtml}
            <button class="circle transparent" title="Delete domain">
                <i>delete</i>
            </button>
        `;
        row.querySelector("button").addEventListener("click", function() {
            removeDomain(domain);
        });
        elDomainList.appendChild(row);
    }
};

const loadDomains = async function() {
    domains = await withDomainsTable((table) => IDB.RowKeys(table));
    renderDomains();
};

const addDomain = async function() {
    const raw = elDomainInput.value.trim().toLowerCase();
    if (!raw || !DOMAIN_REGEX.test(raw)) {
        elDomainField.classList.add("invalid");
        return;
    }
    elDomainField.classList.remove("invalid");
    await withDomainsTable((table) => IDB.RowSet(table, [[raw, raw]]));
    elDomainInput.value = "";
    await loadDomains();
    
    // Immediate sync for newly added domain
    const ip = elIp.textContent;
    if (ip && !ip.includes("Unable") && !ip.includes("Loading")) {
        syncDnsRecords(ip, true);
    }
};

const removeDomain = async function(domain) {
    await withDomainsTable((table) => IDB.RowDel(table, [domain]));
    delete domainSyncStatuses[domain];
    localStorage.setItem("dns_domain_statuses", JSON.stringify(domainSyncStatuses));
    await loadDomains();
};

// Update Authentication UI State
const updateAuthUI = function(status) {
    isUserLoggedIn = Boolean(status && status.loggedIn);
    const username = (status && status.username) || (elInputUsername ? elInputUsername.value.trim() : "") || "user";

    if (isUserLoggedIn) {
        // Header
        if (elHeaderAuthBadge) {
            elHeaderAuthBadge.className = "chip small primary-container";
        }
        if (elHeaderAuthIcon) elHeaderAuthIcon.textContent = "check_circle";
        if (elHeaderAuthText) elHeaderAuthText.textContent = `Logged in (${username})`;
        if (elHeaderBtnLogout) elHeaderBtnLogout.classList.remove("hide");

        // Card
        if (elIconAuthStatus) {
            elIconAuthStatus.textContent = "verified_user";
            elIconAuthStatus.className = "extra primary-text";
        }
        if (elTextAuthStatus) {
            elTextAuthStatus.textContent = "Connected & authenticated to Forpsi (admin.forpsi.hu)";
        }
        if (elTextLoggedUser) elTextLoggedUser.textContent = username;

        // Toggle containers
        if (elContainerLoginForm) elContainerLoginForm.classList.add("hide");
        if (elContainerLoggedIn) elContainerLoggedIn.classList.remove("hide");
        if (elTextAuthError) elTextAuthError.classList.add("hide");

    } else {
        // Header
        if (elHeaderAuthBadge) {
            elHeaderAuthBadge.className = "chip small error-container";
        }
        if (elHeaderAuthIcon) elHeaderAuthIcon.textContent = "error";
        if (elHeaderAuthText) elHeaderAuthText.textContent = "Not logged in";
        if (elHeaderBtnLogout) elHeaderBtnLogout.classList.add("hide");

        // Card
        if (elIconAuthStatus) {
            elIconAuthStatus.textContent = "account_circle";
            elIconAuthStatus.className = "extra error-text";
        }
        if (elTextAuthStatus) {
            elTextAuthStatus.textContent = "Enter your Forpsi admin credentials to enable DNS automation.";
        }

        // Toggle containers
        if (elContainerLoginForm) elContainerLoginForm.classList.remove("hide");
        if (elContainerLoggedIn) elContainerLoggedIn.classList.add("hide");
    }
};

// Check current session or attempt auto-login
const checkAuth = async function() {
    try {
        if (elHeaderAuthText) elHeaderAuthText.textContent = "Checking...";
        if (elHeaderAuthIcon) elHeaderAuthIcon.textContent = "sync";
        
        const status = await ipcRenderer.invoke("api", "auto-login");
        updateAuthUI(status);
        return status;
    } catch (err) {
        updateAuthUI({ loggedIn: false, error: err.message });
        return { loggedIn: false, error: err.message };
    }
};

// Submit username & password to log in directly
const handleLoginSubmit = async function() {
    if (isSubmitting) return;

    const username = elInputUsername.value.trim();
    const password = elInputPassword.value;

    let hasError = false;
    if (!username) {
        elFieldUsername.classList.add("invalid");
        hasError = true;
    } else {
        elFieldUsername.classList.remove("invalid");
    }

    if (!password) {
        elFieldPassword.classList.add("invalid");
        hasError = true;
    } else {
        elFieldPassword.classList.remove("invalid");
    }

    if (hasError) return;

    isSubmitting = true;
    elBtnLoginSubmit.disabled = true;
    elBtnLoginSubmit.innerHTML = `<i>sync</i><span>Logging in...</span>`;
    elTextAuthError.classList.add("hide");

    try {
        const result = await ipcRenderer.invoke("api", "login", username, password);
        
        if (result && result.loggedIn) {
            updateAuthUI(result);
            elInputPassword.value = "";
            // Force DNS sync on fresh login
            const ip = elIp.textContent;
            if (ip && !ip.includes("Unable") && !ip.includes("Loading")) {
                syncDnsRecords(ip, true);
            }
        } else {
            const errorMsg = (result && result.error) || "Login failed. Please check your username and password.";
            elTextAuthError.textContent = errorMsg;
            elTextAuthError.classList.remove("hide");
            updateAuthUI({ loggedIn: false });
        }
    } catch (err) {
        elTextAuthError.textContent = `Login error: ${err.message}`;
        elTextAuthError.classList.remove("hide");
        updateAuthUI({ loggedIn: false });
    } finally {
        isSubmitting = false;
        elBtnLoginSubmit.disabled = false;
        elBtnLoginSubmit.innerHTML = `<i>login</i><span>Login to Forpsi</span>`;
    }
};

// Logout handler
const handleLogout = async function() {
    try {
        await ipcRenderer.invoke("api", "logout");
        elInputPassword.value = "";
        lastSyncedIp = null;
        localStorage.removeItem("dns_last_synced_ip");
        localStorage.removeItem("dns_last_synced_time");
        domainSyncStatuses = {};
        localStorage.removeItem("dns_domain_statuses");
        updateAuthUI({ loggedIn: false });
        renderDomains();
        if (elTextSyncStatus) elTextSyncStatus.textContent = "DNS Sync: Logged out.";
    } catch (err) {
        console.error("Logout error:", err);
    }
};

/**
 * Checks if all configured domains already have a successful sync to targetIp
 */
const areAllDomainsSynced = function(targetIp) {
    if (!targetIp || domains.length === 0) return false;
    for (const d of domains) {
        const info = domainSyncStatuses[d];
        if (!info || (info.status !== "synced" && info.status !== "up_to_date") || info.ip !== targetIp) {
            return false;
        }
    }
    return true;
};

/**
 * Synchronize DNS records on Forpsi only when the IP has changed or force sync is requested.
 */
const syncDnsRecords = async function(currentIp, force = false) {
    if (isSyncing) return;
    if (!currentIp || currentIp.includes("Unable") || currentIp.includes("Loading")) {
        if (elTextSyncStatus) elTextSyncStatus.textContent = "DNS Sync: Waiting for valid public IP...";
        return;
    }

    if (domains.length === 0) {
        if (elTextSyncStatus) elTextSyncStatus.textContent = "DNS Sync: No domains added yet.";
        return;
    }

    // Check if IP is unchanged and all domains are already synced to this IP
    const isIpUnchanged = (currentIp === lastSyncedIp) && areAllDomainsSynced(currentIp);

    if (!force && isIpUnchanged) {
        const timeStr = lastSyncedTime ? new Date(lastSyncedTime).toLocaleTimeString() : "recently";
        console.log(`[DNS Sync] Public IP (${currentIp}) is unchanged. Skipping Forpsi login and DNS modifications.`);
        if (elTextSyncStatus) {
            elTextSyncStatus.textContent = `IP unchanged (${currentIp}) — DNS is up to date (last synced: ${timeStr}).`;
        }
        return;
    }

    console.log(`[DNS Sync] IP change or sync required (previous: ${lastSyncedIp} -> current: ${currentIp}, force: ${force}). Connecting to Forpsi...`);

    // Verify authentication before attempting update
    await checkAuth();

    if (!isUserLoggedIn) {
        if (elTextSyncStatus) elTextSyncStatus.textContent = "DNS Sync: Skipped (Not logged in to Forpsi).";
        return;
    }

    isSyncing = true;
    if (elTextSyncStatus) elTextSyncStatus.textContent = `DNS Sync: Synchronizing ${domains.length} domain(s) to ${currentIp}...`;

    for (const d of domains) {
        domainSyncStatuses[d] = { status: "updating" };
    }
    renderDomains();

    try {
        const results = await ipcRenderer.invoke("api", "update-dns", domains, currentIp);
        console.log("[DNS Sync] Results:", results);

        let successCount = 0;
        for (const res of results) {
            if (res.success) {
                successCount++;
                domainSyncStatuses[res.domain] = {
                    status: res.updated ? "synced" : "up_to_date",
                    ip: res.ip,
                    message: res.message,
                    time: new Date().toLocaleTimeString()
                };
            } else {
                domainSyncStatuses[res.domain] = {
                    status: "error",
                    ip: res.ip,
                    message: res.error || "Update failed",
                    time: new Date().toLocaleTimeString()
                };
            }
        }

        const now = new Date();
        const timeStr = now.toLocaleTimeString();

        if (successCount > 0) {
            lastSyncedIp = currentIp;
            lastSyncedTime = now.toISOString();
            localStorage.setItem("dns_last_synced_ip", currentIp);
            localStorage.setItem("dns_last_synced_time", lastSyncedTime);
            localStorage.setItem("dns_domain_statuses", JSON.stringify(domainSyncStatuses));
        }

        if (elTextSyncStatus) {
            elTextSyncStatus.textContent = `Last sync: ${timeStr} (${successCount}/${domains.length} domain(s) successfully synchronized to ${currentIp})`;
        }
    } catch (err) {
        console.error("[DNS Sync] Error:", err);
        if (elTextSyncStatus) elTextSyncStatus.textContent = `DNS Sync error: ${err.message}`;
    } finally {
        isSyncing = false;
        renderDomains();
    }
};

const doRefresh = async function(force = false) {
    const ip = await fetchCurrentIp();
    if (ip) {
        await syncDnsRecords(ip, force);
    }
    scheduleNextRefresh();
};

const tickCountdown = function() {
    const remaining = nextRefreshAt - Date.now();
    if (remaining <= 0) {
        doRefresh(false);
        return;
    }
    elCountdown.textContent = formatCountdown(remaining);
};

const main = async function() {
    // Theme colors
    globalThis.ui("theme", "#006e1c");

    await new Promise((resolve) => {
        setTimeout(() => {
            const mode = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
            globalThis.ui("mode", mode);
            resolve();
        }, 1);
    });

    // Set tray
    ipcRenderer.send("api", "set-tray", true);

    // Pre-fill username if saved credentials exist
    try {
        const saved = await ipcRenderer.invoke("api", "get-saved-credentials");
        if (saved && saved.username) {
            elInputUsername.value = saved.username;
        }
    } catch {}

    // Event listeners
    elBtnLoginSubmit.addEventListener("click", handleLoginSubmit);
    
    elInputUsername.addEventListener("keydown", function(event) {
        if (event.key === "Enter") {
            elInputPassword.focus();
        }
    });

    elInputPassword.addEventListener("keydown", function(event) {
        if (event.key === "Enter") {
            handleLoginSubmit();
        }
    });

    if (elBtnLogout) elBtnLogout.addEventListener("click", handleLogout);
    if (elHeaderBtnLogout) elHeaderBtnLogout.addEventListener("click", handleLogout);
    if (elBtnRecheckAuth) elBtnRecheckAuth.addEventListener("click", () => checkAuth());

    // Manual Refresh button: force sync on click
    elRefreshBtn.addEventListener("click", () => doRefresh(true));
    elInterval.addEventListener("change", scheduleNextRefresh);
    elDomainAddBtn.addEventListener("click", addDomain);
    elDomainInput.addEventListener("keydown", function(event) {
        if (event.key === "Enter") {
            addDomain();
        }
    });

    await loadDomains();
    await checkAuth();
    
    // Initial check on launch
    const initialIp = await fetchCurrentIp();
    if (initialIp) {
        // Sync if IP changed or first run
        await syncDnsRecords(initialIp, false);
    }
    scheduleNextRefresh();
    setInterval(tickCountdown, 1000);
};

main();