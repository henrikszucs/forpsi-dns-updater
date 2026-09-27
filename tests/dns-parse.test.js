"use strict";

// Unit tests for the Forpsi HTML parsing in dns.js, using hand-written page snippets.

const test = require("node:test");
const assert = require("node:assert/strict");
const dns = require("../src/electron/dns.js");

/**
 * Builds a hidden edit row as it appears on domains-dns.php.
 */
const editRow = function({ id, type, name, ttl = "1800", rdata, textarea = false }) {
    const types = ["A", "AAAA", "CNAME", "MX", "TXT"]
        .map((t) => `<option value="${t}"${t === type ? " selected" : ""}>${t}</option>`)
        .join("");
    const value = textarea
        ? `<textarea name="rdata" rows="2">${rdata}</textarea>`
        : `<input type="text" name="rdata" value="${rdata}">`;
    return `
        <tr style="display: none;">
            <td colspan="5">
                <form method="post">
                    <input type="hidden" name="ak" value="record_save">
                    <input type="hidden" name="r_ID" value="${id}">
                    <select name="type">${types}</select>
                    <input type="text" name="name" value="${name}">
                    <input type="text" name="ttl" value="${ttl}">
                    ${value}
                    <input type="text" name="mx_priority" value="20">
                </form>
            </td>
        </tr>`;
};

const PAGE = `
    <table>
        <tr><td>home</td><td>A</td><td>1.2.3.4</td></tr>
        ${editRow({ id: "101", type: "A", name: "", rdata: "1.2.3.4" })}
        ${editRow({ id: "102", type: "A", name: "home", ttl: "300", rdata: "5.6.7.8" })}
        ${editRow({ id: "103", type: "CNAME", name: "www", rdata: "example.com.", textarea: true })}
        <tr style="display: none;">
            <td><form><input type="hidden" name="ak" value="record_add"></form></td>
        </tr>
    </table>`;

test.describe("parseDnsRecords", () => {
    test.it("parses every editable record", () => {
        const records = dns.parseDnsRecords(PAGE);
        assert.deepEqual(records.map((r) => [r.r_ID, r.type, r.name, r.ttl, r.rdata]), [
            ["101", "A", "", "1800", "1.2.3.4"],
            ["102", "A", "home", "300", "5.6.7.8"],
            ["103", "CNAME", "www", "1800", "example.com."]
        ]);
    });

    test.it("reads extra fields and falls back to defaults", () => {
        const [record] = dns.parseDnsRecords(PAGE);
        assert.equal(record.mx_priority, "20");
        assert.equal(record.srv_priority, "10");
        assert.equal(record.flags, "0");
    });

    test.it("returns nothing for pages without edit rows", () => {
        assert.deepEqual(dns.parseDnsRecords("<html><body>Login</body></html>"), []);
    });
});

test.describe("findDomainIdForName", () => {
    const domains = [
        { domain: "example.com", id: "1" },
        { domain: "example.co.uk", id: "2" },
        { domain: "co.uk", id: "3" }
    ];

    test.it("matches a root domain exactly", () => {
        assert.deepEqual(dns.findDomainIdForName(" Example.com ", domains), { domainId: "1", rootDomain: "example.com", host: "" });
    });

    test.it("splits a subdomain into root domain and host", () => {
        assert.deepEqual(dns.findDomainIdForName("a.b.example.com", domains), { domainId: "1", rootDomain: "example.com", host: "a.b" });
    });

    test.it("picks the longest matching root domain", () => {
        assert.deepEqual(dns.findDomainIdForName("home.example.co.uk", domains), { domainId: "2", rootDomain: "example.co.uk", host: "home" });
    });

    test.it("returns null for domains not in the account", () => {
        assert.equal(dns.findDomainIdForName("other.org", domains), null);
        assert.equal(dns.findDomainIdForName("notexample.com", domains), null);
    });
});
