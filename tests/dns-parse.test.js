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

    test.it("reads the selected type in any markup form", () => {
        const variants = [
            '<option value="CNAME" selected="selected">CNAME</option>',
            '<option value="CNAME" selected >CNAME</option>',
            '<option class="x" value="CNAME" selected>CNAME</option>',
            "<option selected value='cname'>CNAME</option>"
        ];
        for (const option of variants) {
            const html = editRow({ id: "1", type: "A", name: "home", rdata: "x." })
                .replace(/<select name="type">[\s\S]*?<\/select>/, `<select class="t" name="type"><option value="A">A</option>${option}</select>`);
            const records = dns.parseDnsRecords(html);
            assert.deepEqual(records.map((r) => r.type), ["CNAME"], option);
            assert.deepEqual(dns.findARecords(records, "home", "example.com"), [], option);
        }
    });

    test.it("reads the type from a hidden input", () => {
        const html = editRow({ id: "1", type: "A", name: "home", rdata: "1.2.3.4" })
            .replace(/<select name="type">[\s\S]*?<\/select>/, '<input type="hidden" name="type" value="a">');
        assert.deepEqual(dns.parseDnsRecords(html).map((r) => r.type), ["A"]);
    });

    test.it("skips records whose type cannot be read instead of assuming A", () => {
        const noSelected = editRow({ id: "1", type: "none", name: "home", rdata: "x." });
        const noField = editRow({ id: "2", type: "A", name: "home", rdata: "x." })
            .replace(/<select name="type">[\s\S]*?<\/select>/, "");
        const valueOnly = editRow({ id: "3", type: "A", name: "home", rdata: "x." })
            .replace(/<option value="A" selected>/, '<option value="A" data-x="selected">');
        assert.deepEqual(dns.parseDnsRecords(noSelected + noField + valueOnly), []);
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

test.describe("normalizeHostName", () => {
    test.it("maps root domain forms to an empty host", () => {
        for (const name of ["", "@", "example.com", "example.com.", " Example.COM "]) {
            assert.equal(dns.normalizeHostName(name, "example.com"), "", name);
        }
    });

    test.it("strips the root domain and trailing dot from subdomains", () => {
        for (const name of ["home", "home.", "home.example.com", "HOME.example.com."]) {
            assert.equal(dns.normalizeHostName(name, "example.com"), "home", name);
        }
        assert.equal(dns.normalizeHostName("a.b.example.com", "example.com"), "a.b");
    });

    test.it("does not strip look-alike domains", () => {
        assert.equal(dns.normalizeHostName("home.notexample.com", "example.com"), "home.notexample.com");
    });
});

test.describe("findARecords", () => {
    const records = [
        { r_ID: "1", type: "A", name: "@", rdata: "1.1.1.1" },
        { r_ID: "2", type: "A", name: "home.example.com.", rdata: "2.2.2.2" },
        { r_ID: "3", type: "AAAA", name: "home", rdata: "::1" },
        { r_ID: "4", type: "CNAME", name: "www", rdata: "example.com." }
    ];

    test.it("matches FQDN and @ record names", () => {
        assert.deepEqual(dns.findARecords(records, "", "example.com").map((r) => r.r_ID), ["1"]);
        assert.deepEqual(dns.findARecords(records, "home", "example.com").map((r) => r.r_ID), ["2"]);
    });

    test.it("returns every duplicate A record for the host", () => {
        const dupes = [...records, { r_ID: "5", type: "A", name: "home", rdata: "3.3.3.3" }];
        assert.deepEqual(dns.findARecords(dupes, "home", "example.com").map((r) => r.r_ID), ["2", "5"]);
    });

    test.it("ignores other types and hosts", () => {
        assert.deepEqual(dns.findARecords(records, "www", "example.com"), []);
    });
});

test.describe("findVerifyProblem", () => {
    const ip = "1.2.3.4";

    test.it("accepts a single A record holding the IP", () => {
        const records = dns.parseDnsRecords(editRow({ id: "1", type: "A", name: "home", rdata: ip }));
        assert.equal(dns.findVerifyProblem(records, "home", "example.com", ip), null);
    });

    test.it("fails when only another record holds the IP", () => {
        const html = editRow({ id: "1", type: "A", name: "", rdata: ip }) +
                     editRow({ id: "2", type: "A", name: "home", rdata: "9.9.9.9" });
        const problem = dns.findVerifyProblem(dns.parseDnsRecords(html), "home", "example.com", ip);
        assert.match(problem, /9\.9\.9\.9/);
    });

    test.it("does not accept an IP that merely contains the expected one", () => {
        const records = dns.parseDnsRecords(editRow({ id: "1", type: "A", name: "home", rdata: "11.2.3.45" }));
        assert.notEqual(dns.findVerifyProblem(records, "home", "example.com", ip), null);
    });

    test.it("fails when the record is missing or duplicated", () => {
        assert.match(dns.findVerifyProblem([], "home", "example.com", ip), /no A record/);
        const html = editRow({ id: "1", type: "A", name: "home", rdata: ip }) +
                     editRow({ id: "2", type: "A", name: "home.example.com.", rdata: "5.5.5.5" });
        assert.match(dns.findVerifyProblem(dns.parseDnsRecords(html), "home", "example.com", ip), /2 A records/);
    });
});

test.describe("parseDomainsList", () => {
    test.it("prefers domain page links over other ids in the row", () => {
        const html = `
            <table>
                <tr>
                    <td><a href="/client/orders.php?client_id=999&id=555">Renew</a></td>
                    <td><a href="/domain/domains-detail.php?id=42">example.com</a></td>
                </tr>
                <tr>
                    <td>other.hu</td>
                    <td><a href="domains-dns.php?lang=hu&amp;id=43">DNS</a></td>
                    <td><a href="/order.php?id=777">Renew</a></td>
                </tr>
            </table>`;
        assert.deepEqual(dns.parseDomainsList(html), [
            { domain: "example.com", id: "42" },
            { domain: "other.hu", id: "43" }
        ]);
    });

    test.it("does not read ids from parameters like client_id", () => {
        const html = `<tr><td>example.com</td><td><a href="/x.php?client_id=999">x</a></td></tr>`;
        assert.deepEqual(dns.parseDomainsList(html), []);
    });

    test.it("skips rows with ambiguous ids", () => {
        const html = `<tr><td>example.com</td><td><a href="/a.php?id=1">a</a><a href="/b.php?id=2">b</a></td></tr>`;
        assert.deepEqual(dns.parseDomainsList(html), []);
    });

    test.it("uses a single plain id in a row", () => {
        const html = `<tr><td>example.com</td><td><a href="/a.php?id=7">a</a></td></tr>`;
        assert.deepEqual(dns.parseDomainsList(html), [{ domain: "example.com", id: "7" }]);
    });
});

test.describe("isValidIpv4", () => {
    test.it("accepts dotted-quad addresses only", () => {
        for (const ip of ["1.2.3.4", "0.0.0.0", "255.255.255.255", "10.0.0.1"]) {
            assert.equal(dns.isValidIpv4(ip), true, ip);
        }
        for (const ip of ["", "256.1.1.1", "1.2.3", "1.2.3.4.5", " 1.2.3.4", "::1", "1.2.3.4\n", "<b>", undefined, null]) {
            assert.equal(dns.isValidIpv4(ip), false, String(ip));
        }
    });

    test.it("updateAllDomains rejects an invalid IP before any request", async () => {
        const results = await dns.updateAllDomains("test-partition", ["example.com", "home.example.com"], "not-an-ip");
        assert.deepEqual(results.map((r) => r.success), [false, false]);
        assert.match(results[0].error, /not a valid IPv4 address/);
    });
});

test.describe("pageMentionsDomain", () => {
    test.it("finds the domain as a whole name", () => {
        assert.equal(dns.pageMentionsDomain("<h1>DNS: Example.com</h1>", "example.com"), true);
        assert.equal(dns.pageMentionsDomain("<td>www.example.com.</td>", "example.com"), true);
    });

    test.it("rejects look-alike names", () => {
        assert.equal(dns.pageMentionsDomain("<h1>notexample.com</h1>", "example.com"), false);
        assert.equal(dns.pageMentionsDomain("<h1>example.com.hu</h1>", "example.com"), false);
        assert.equal(dns.pageMentionsDomain("<h1>examplexcom</h1>", "example.com"), false);
    });
});
