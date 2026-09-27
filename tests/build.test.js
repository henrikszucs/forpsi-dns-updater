"use strict";

// Checks the packaging whitelist so local secrets never end up in a build.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ROOT } = require("./helpers.js");
const { isIgnored } = require("../scripts/build.js");

const abs = (rel) => path.join(ROOT, ...rel.split("/"));

test.describe("build whitelist", () => {
    test.it("includes package.json, src/ and the example config", () => {
        for (const rel of ["package.json", "src", "src/main.js", "src/renderer/libs/idb/idb.js", "conf", "conf/config.example.json"]) {
            assert.equal(isIgnored(abs(rel)), false, rel);
        }
    });

    test.it("excludes the local config, docs, tooling and dependencies", () => {
        for (const rel of ["conf/config.json", "conf/other.json", "docs", "tests", "scripts", "deploy", ".claude", ".git", "node_modules", "README.md", "package-lock.json", "dist"]) {
            assert.equal(isIgnored(abs(rel)), true, rel);
        }
    });

    test.it("keeps the app root itself", () => {
        assert.equal(isIgnored(ROOT), false);
    });

    test.it("handles root-relative paths with a leading slash", () => {
        assert.equal(isIgnored("/src/cli.js"), false);
        assert.equal(isIgnored("/conf/config.json"), true);
    });
});
