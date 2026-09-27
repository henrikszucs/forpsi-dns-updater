"use strict";

// Unit tests for the plain-Node runtime layer (data dir, cookie jar) and the
// credential/cookie persistence in auth.js. No network access.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTempDir, clearProgramEnv, readJson, fileMode } = require("./helpers.js");

clearProgramEnv();
const platform = require("../src/electron/platform.js");
const auth = require("../src/electron/auth.js");

let dataDir;
let partitionCounter = 0;
const newPartition = () => `test-partition-${++partitionCounter}`;

test.beforeEach(() => {
    clearProgramEnv();
    dataDir = makeTempDir();
    platform.setDataDir(dataDir);
});

test.describe("platform", () => {
    test.it("runs in plain-Node mode under the test runner", () => {
        assert.equal(platform.isElectron, false);
        assert.equal(platform.getSafeStorage(), null);
    });

    test.it("prefers setDataDir, then DNS_UPDATER_DATA_DIR, and creates the folder", () => {
        const envDir = path.join(makeTempDir(), "env-data");
        process.env.DNS_UPDATER_DATA_DIR = envDir;
        assert.equal(platform.getDataDir(), dataDir);

        platform.setDataDir(null);
        assert.equal(platform.getDataDir(), envDir);
        assert.ok(fs.existsSync(envDir));
    });

    test.it("keeps one cookie jar per partition", () => {
        const name = newPartition();
        assert.equal(platform.getCookieJar(name), platform.getCookieJar(name));
        assert.notEqual(platform.getCookieJar(name), platform.getCookieJar(newPartition()));
    });

    test.it("memory jar stores, replaces, expires and clears cookies", async () => {
        const jar = platform.getCookieJar(newPartition());
        const future = Date.now() / 1000 + 3600;

        await jar.set({ url: "https://admin.forpsi.hu/", name: "sid", value: "1", expirationDate: future });
        await jar.set({ url: "https://admin.forpsi.hu/", name: "sid", value: "2", expirationDate: future });
        await jar.set({ domain: ".forpsi.hu", name: "old", value: "x", expirationDate: 1 });

        const cookies = await jar.get();
        assert.equal(cookies.length, 1);
        assert.equal(cookies[0].domain, "admin.forpsi.hu");
        assert.equal(cookies[0].path, "/");
        assert.equal(cookies[0].value, "2");

        await jar.clear();
        assert.deepEqual(await jar.get(), []);
    });

    test.it("memory jar removes cookies by URL and name", async () => {
        const jar = platform.getCookieJar(newPartition());
        await jar.set({ domain: ".forpsi.hu", path: "/", name: "sid", value: "1" });
        await jar.set({ domain: ".forpsi.hu", path: "/", name: "lang", value: "hu" });
        await jar.set({ domain: "other.example", path: "/", name: "sid", value: "2" });

        await jar.remove("https://admin.forpsi.hu/", "sid");
        const left = (await jar.get()).map((c) => `${c.domain}:${c.name}`).sort();
        assert.deepEqual(left, [".forpsi.hu:lang", "other.example:sid"]);
    });
});

test.describe("credentials", () => {
    test.it("saves base64-encoded, owner-only, and reads them back", () => {
        assert.equal(auth.saveCredentials("user", "s3cret"), true);

        const file = path.join(dataDir, "forpsi_credentials.json");
        const stored = readJson(file);
        assert.equal(stored.username, "user");
        assert.equal(stored.isEncrypted, false);
        assert.notEqual(stored.password, "s3cret");
        if (process.platform !== "win32") {
            assert.equal(fileMode(file), 0o600);
        }

        assert.deepEqual(auth.getSavedCredentials(), { username: "user", password: "s3cret" });
    });

    test.it("prefers FORPSI_USERNAME/FORPSI_PASSWORD in headless mode", () => {
        auth.saveCredentials("user", "s3cret");
        process.env.FORPSI_USERNAME = "env-user";
        process.env.FORPSI_PASSWORD = "env-pass";
        assert.deepEqual(auth.getSavedCredentials(), { username: "env-user", password: "env-pass" });
    });

    test.it("cannot read keychain-encrypted credentials from the desktop app", () => {
        const file = path.join(dataDir, "forpsi_credentials.json");
        fs.writeFileSync(file, JSON.stringify({ username: "u", password: "AAAA", isEncrypted: true }));
        assert.equal(auth.getSavedCredentials(), null);
    });

    test.it("clearCredentials removes the file", () => {
        auth.saveCredentials("user", "s3cret");
        assert.equal(auth.clearCredentials(), true);
        assert.equal(auth.getSavedCredentials(), null);
    });
});

test.describe("Set-Cookie handling", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");

    test.it("reads Max-Age and Expires, Max-Age winning", () => {
        const [a, b, c] = auth.parseSetCookieHeaders([
            "sid=abc=def; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly",
            "lang=hu; Expires=Wed, 30 Sep 2026 12:00:00 GMT",
            "plain=1"
        ], now);
        assert.equal(a.value, "abc=def");
        assert.equal(a.httpOnly, true);
        assert.equal(a.expired, false);
        assert.equal(a.expirationDate, now / 1000 + 60);
        assert.equal(b.expirationDate, Date.parse("2026-09-30T12:00:00Z") / 1000);
        assert.equal(c.expired, false);
        assert.equal(c.expirationDate, undefined);
    });

    test.it("marks deleted cookies as expired", () => {
        const cookies = auth.parseSetCookieHeaders([
            "sid=deleted; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Path=/",
            "lang=x; Max-Age=0"
        ], now);
        assert.deepEqual(cookies.map((c) => c.expired), [true, true]);
    });

    test.it("an expired Set-Cookie deletes the stored cookie instead of storing it", async () => {
        const jar = platform.getCookieJar(newPartition());
        await auth.applySetCookies(jar, auth.parseSetCookieHeaders(["PHPSESSID=abc; Path=/", "lang=hu; Path=/"]));
        await auth.applySetCookies(jar, auth.parseSetCookieHeaders(["PHPSESSID=deleted; Max-Age=0; Path=/"]));
        assert.deepEqual((await jar.get()).map((c) => [c.name, c.value]), [["lang", "hu"]]);
    });
});

test.describe("cookies", () => {
    test.it("persists only Forpsi cookies and restores them into a fresh jar", async () => {
        const source = newPartition();
        const jar = platform.getCookieJar(source);
        await jar.set({ url: "https://admin.forpsi.hu/", name: "PHPSESSID", value: "abc", secure: true });
        await jar.set({ url: "https://tracker.example/", name: "ad", value: "zzz" });

        assert.equal(await auth.saveCookies(source), true);
        const file = path.join(dataDir, "forpsi_cookies.json");
        assert.deepEqual(readJson(file).map((c) => c.name), ["PHPSESSID"]);
        if (process.platform !== "win32") {
            assert.equal(fileMode(file), 0o600);
        }

        const target = newPartition();
        assert.equal(await auth.restoreCookies(target), true);
        const restored = await platform.getCookieJar(target).get();
        assert.deepEqual(restored.map((c) => [c.name, c.value]), [["PHPSESSID", "abc"]]);
    });

    test.it("does not write a file when there are no Forpsi cookies", async () => {
        assert.equal(await auth.saveCookies(newPartition()), false);
        assert.equal(fs.existsSync(path.join(dataDir, "forpsi_cookies.json")), false);
        assert.equal(await auth.restoreCookies(newPartition()), false);
    });
});
