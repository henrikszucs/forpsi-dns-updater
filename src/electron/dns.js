"use strict";

const platform = require("./platform.js");
const https = require("node:https");
const { URL } = require("node:url");
const auth = require("./auth.js");

const DOMAINS_LIST_URL = "https://admin.forpsi.hu/domain/domains-list.php";
const DOMAINS_DNS_BASE_URL = "https://admin.forpsi.hu/domain/domains-dns.php";

/**
 * Helper to make authenticated HTTPS requests using partition session cookies.
 */
const requestWithCookies = async function(partition, targetUrl, options = {}) {
    const jar = platform.getCookieJar(partition);
    let allCookies = await jar.get().catch(() => []);
    
    if (allCookies.length === 0) {
        await auth.restoreCookies(partition);
        allCookies = await jar.get().catch(() => []);
    }

    const parsedUrl = new URL(targetUrl);
    const forpsiCookies = allCookies.filter(cookie => {
        const domain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
        return parsedUrl.hostname.endsWith(domain) || parsedUrl.hostname === domain;
    });

    const cookieHeader = forpsiCookies.map(c => `${c.name}=${c.value}`).join("; ");
    const postBody = options.body || null;

    const reqHeaders = {
        "Cookie": cookieHeader,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Connection": "close",
        ...(options.headers || {})
    };

    if (postBody) {
        reqHeaders["Content-Type"] = reqHeaders["Content-Type"] || "application/x-www-form-urlencoded";
        reqHeaders["Content-Length"] = Buffer.byteLength(postBody);
        reqHeaders["Origin"] = parsedUrl.origin;
        reqHeaders["Referer"] = targetUrl;
    }

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || (postBody ? "POST" : "GET"),
            headers: reqHeaders
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectUrl = new URL(res.headers.location, targetUrl).toString();
                res.resume();
                return resolve({
                    statusCode: res.statusCode,
                    finalUrl: redirectUrl,
                    isRedirect: true,
                    headers: res.headers,
                    html: ""
                });
            }

            let html = "";
            res.setEncoding("utf8");
            res.on("data", chunk => { html += chunk; });
            res.on("end", () => {
                resolve({
                    statusCode: res.statusCode,
                    finalUrl: targetUrl,
                    isRedirect: false,
                    headers: res.headers,
                    html: html
                });
            });
        });

        req.on("error", reject);
        req.setTimeout(15000, () => { req.destroy(new Error("Request timeout.")); });
        if (postBody) req.write(postBody);
        req.end();
    });
};

const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/**
 * True for a dotted-quad IPv4 address (the only value written into A records).
 */
const isValidIpv4 = function(ip) {
    return typeof ip === "string" && IPV4_REGEX.test(ip);
};

const DOMAIN_NAME_PATTERN ="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+";

/**
 * Extracts { domain, id } pairs from the domains list page HTML.
 */
const parseDomainsList = function(html) {
    const domainsMap = new Map();
    let match;

    // Pattern 1: links to domains-dns.php / domains-detail.php whose text is the domain.
    // These name the domain ID unambiguously, so they win over pattern 2.
    const linkRegex = /href=["'][^"']*domains-(?:dns|detail)\.php\?(?:[^"']*?&(?:amp;)?)?id=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = linkRegex.exec(html)) !== null) {
        const id = match[1];
        const rawText = match[2].replace(/<[^>]+>/g, "").trim().toLowerCase();
        const domainMatch = rawText.match(new RegExp(DOMAIN_NAME_PATTERN, "i"));
        if (domainMatch && !domainsMap.has(domainMatch[0])) {
            domainsMap.set(domainMatch[0], id);
        }
    }

    // Pattern 2: table rows with a domain name cell. Only a query-string "id=" counts
    // (not client_id= etc.): prefer links to domains-*.php, otherwise the row must
    // hold a single distinct id, as other links in the row may point elsewhere.
    const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
    while ((match = rowRegex.exec(html)) !== null) {
        const rowHtml = match[0];
        const domainMatch = rowHtml.match(new RegExp(`>\\s*(${DOMAIN_NAME_PATTERN})\\s*<`, "i"));
        if (!domainMatch) continue;
        const domain = domainMatch[1].toLowerCase();
        if (domainsMap.has(domain)) continue;

        const pageIds = [...rowHtml.matchAll(/domains-[a-z]+\.php\?(?:[^"'\s>]*?&(?:amp;)?)?id=(\d+)/gi)].map(m => m[1]);
        const anyIds = [...rowHtml.matchAll(/[?&](?:amp;)?id=(\d+)/gi)].map(m => m[1]);
        const ids = [...new Set(pageIds.length > 0 ? pageIds : anyIds)];
        if (ids.length === 1) {
            domainsMap.set(domain, ids[0]);
        } else if (ids.length > 1) {
            console.warn(`[DNS] Skipping '${domain}' in domains list: ambiguous IDs ${ids.join(", ")}`);
        }
    }

    const result = [];
    for (const [domain, id] of domainsMap.entries()) {
        result.push({ domain, id });
    }
    return result;
};

/**
 * Parses the domains list page (https://admin.forpsi.hu/domain/domains-list.php)
 * to find all registered domains and their internal IDs.
 */
const getDomainsList = async function(partition) {
    console.log("[DNS] Fetching domains list from:", DOMAINS_LIST_URL);
    const res = await requestWithCookies(partition, DOMAINS_LIST_URL);

    if (res.statusCode !== 200 || !res.html) {
        throw new Error(`Failed to fetch domains list (HTTP ${res.statusCode})`);
    }

    const result = parseDomainsList(res.html);
    console.log(`[DNS] Found ${result.length} domain(s) in Forpsi account:`, result);
    return result;
};

/**
 * True when the DNS page HTML mentions rootDomain as a whole name
 * (not inside "notexample.com" or "example.com.hu").
 */
const pageMentionsDomain = function(html, rootDomain) {
    const escaped = rootDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-]|\\.[a-z0-9])`, "i").test(html);
};

/**
 * Normalizes a record host name to the relative form of the form's "name" field:
 * "" for the root domain, "home" for home.<rootDomain>. Accepts "@", FQDNs and trailing dots.
 */
const normalizeHostName = function(name, rootDomain) {
    let host = String(name || "").trim().toLowerCase().replace(/\.$/, "");
    const root = rootDomain.toLowerCase();
    if (host === "@" || host === root) {
        return "";
    }
    if (host.endsWith("." + root)) {
        host = host.slice(0, -(root.length + 1));
    }
    return host;
};

/**
 * All A records for the given host.
 */
const findARecords = function(records, host, rootDomain) {
    const target = normalizeHostName(host, rootDomain);
    return records.filter(r => r.type.toUpperCase() === "A" && normalizeHostName(r.name, rootDomain) === target);
};

/**
 * Checks the reloaded DNS records after a save: the host must have exactly one A record,
 * holding ip. Returns null when verified, otherwise the reason.
 */
const findVerifyProblem = function(records, host, rootDomain, ip) {
    const matches = findARecords(records, host, rootDomain);
    if (matches.length === 0) {
        return "no A record found";
    }
    if (matches.length > 1) {
        return `${matches.length} A records found (${matches.map(r => r.rdata).join(", ")})`;
    }
    if (matches[0].rdata !== ip) {
        return `A record holds '${matches[0].rdata}'`;
    }
    return null;
};

/**
 * Finds the domain ID for a given domain or subdomain.
 */
const findDomainIdForName = function(targetDomain, availableDomains) {
    const cleanTarget = targetDomain.trim().toLowerCase();

    // 1. Exact match
    const exact = availableDomains.find(d => d.domain === cleanTarget);
    if (exact) return { domainId: exact.id, rootDomain: exact.domain, host: "" };

    // 2. Subdomain match (e.g. "sub.example.com" on "example.com")
    let bestMatch = null;
    for (const d of availableDomains) {
        if (cleanTarget.endsWith("." + d.domain)) {
            if (!bestMatch || d.domain.length > bestMatch.rootDomain.length) {
                const subPart = cleanTarget.slice(0, cleanTarget.length - d.domain.length - 1);
                bestMatch = { domainId: d.id, rootDomain: d.domain, host: subPart };
            }
        }
    }

    return bestMatch;
};

/**
 * Reads the record type of an edit row: the selected option of the "type" select
 * (any attribute order, "selected" or selected="selected"), or a hidden "type" input.
 * Returns null unless exactly one type is found.
 */
const parseRecordType = function(rowContent) {
    const selectMatch = rowContent.match(/<select\b[^>]*\bname=["']type["'][^>]*>([\s\S]*?)<\/select>/i);
    if (selectMatch) {
        const selected = [];
        for (const opt of selectMatch[1].matchAll(/<option\b([^>]*)>/gi)) {
            const attrs = opt[1];
            // Look for the attribute name only outside quoted values
            if (!/\bselected\b/i.test(attrs.replace(/"[^"]*"|'[^']*'/g, ""))) {
                continue;
            }
            const valueMatch = attrs.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
            if (valueMatch) {
                selected.push(valueMatch[1].trim().toUpperCase());
            }
        }
        return selected.length === 1 && selected[0] ? selected[0] : null;
    }

    const inputMatch = rowContent.match(/<input\b[^>]*\bname=["']type["'][^>]*>/i);
    if (inputMatch) {
        const valueMatch = inputMatch[0].match(/\bvalue\s*=\s*["']([^"']*)["']/i);
        return valueMatch && valueMatch[1].trim() ? valueMatch[1].trim().toUpperCase() : null;
    }
    return null;
};

/**
 * Parses all DNS records and their edit rows from domains-dns.php HTML.
 */
const parseDnsRecords = function(html) {
    const records = [];

    // Each editable row has a hidden form row right after it with inputs:
    // ak=record_save, r_ID=<id>, type=<type>, name=<name>, ttl=<ttl>, rdata=<value>
    const editRows = [...html.matchAll(/<tr[^>]*style="display:\s*none;?"[^>]*>([\s\S]*?)<\/tr>/gi)];

    for (const m of editRows) {
        const rowContent = m[1];
        if (!rowContent.includes('name="ak"') || !rowContent.includes('record_save')) {
            continue;
        }

        const rIdMatch = rowContent.match(/name="r_ID"\s+value="(\d+)"/i) || rowContent.match(/value="(\d+)"\s+name="r_ID"/i);
        const r_ID = rIdMatch ? rIdMatch[1] : null;
        if (!r_ID) continue;

        // Record type: never guessed, a row whose type cannot be read is skipped
        const type = parseRecordType(rowContent);
        if (!type) {
            console.warn(`[DNS] Skipping record ${r_ID}: could not read its type.`);
            continue;
        }

        // Host name input
        const nameMatch = rowContent.match(/<input[^>]+name="name"[^>]+value="([^"]*)"/i) ||
                          rowContent.match(/<input[^>]+value="([^"]*)"[^>]+name="name"/i);
        const name = nameMatch ? nameMatch[1].trim() : "";

        // TTL input
        const ttlMatch = rowContent.match(/<input[^>]+name="ttl"[^>]+value="([^"]*)"/i) ||
                         rowContent.match(/<input[^>]+value="([^"]*)"[^>]+name="ttl"/i);
        const ttl = ttlMatch ? ttlMatch[1].trim() : "1800";

        // rdata textarea or input
        const rdataMatch = rowContent.match(/<textarea[^>]+name="rdata"[^>]*>([\s\S]*?)<\/textarea>/i) ||
                           rowContent.match(/<input[^>]+name="rdata"[^>]+value="([^"]*)"/i);
        const rdata = rdataMatch ? rdataMatch[1].trim() : "";

        // Priority / protocol / other fields
        const mxPriorityMatch = rowContent.match(/name="mx_priority"[^>]+value="([^"]*)"/i);
        const srvServiceMatch = rowContent.match(/name="srv_service"[^>]+value="([^"]*)"/i);
        const srvPriorityMatch = rowContent.match(/name="srv_priority"[^>]+value="([^"]*)"/i);
        const srvWeightMatch = rowContent.match(/name="srv_weight"[^>]+value="([^"]*)"/i);
        const srvPortMatch = rowContent.match(/name="srv_port"[^>]+value="([^"]*)"/i);
        const tlsaPortMatch = rowContent.match(/name="tlsa_port"[^>]+value="([^"]*)"/i);
        const flagsMatch = rowContent.match(/name="flags"[^>]+value="([^"]*)"/i);

        records.push({
            r_ID,
            type,
            name,
            ttl,
            rdata,
            mx_priority: mxPriorityMatch ? mxPriorityMatch[1] : "10",
            srv_service: srvServiceMatch ? srvServiceMatch[1] : "",
            srv_priority: srvPriorityMatch ? srvPriorityMatch[1] : "10",
            srv_weight: srvWeightMatch ? srvWeightMatch[1] : "",
            srv_port: srvPortMatch ? srvPortMatch[1] : "",
            tlsa_port: tlsaPortMatch ? tlsaPortMatch[1] : "",
            flags: flagsMatch ? flagsMatch[1] : "0"
        });
    }

    return records;
};

/**
 * Updates the DNS A record for a given domain on https://admin.forpsi.hu/domain/domains-dns.php?id=<id>&new=1
 */
const updateDnsForDomain = async function(partition, domainName, currentIp) {
    const cleanDomain = domainName.trim().toLowerCase();
    const cleanIp = String(currentIp || "").trim();
    if (!isValidIpv4(cleanIp)) {
        throw new Error(`Refusing to update '${cleanDomain}': '${cleanIp}' is not a valid IPv4 address.`);
    }

    console.log(`[DNS] Starting DNS update for '${cleanDomain}' to IP: ${cleanIp}`);

    // Step 1: Resolve domain ID
    const availableDomains = await getDomainsList(partition);
    const domainInfo = findDomainIdForName(cleanDomain, availableDomains);

    if (!domainInfo) {
        throw new Error(`Domain '${cleanDomain}' was not found in your Forpsi domain list.`);
    }

    const { domainId, rootDomain, host: targetHost } = domainInfo;
    console.log(`[DNS] Resolved '${cleanDomain}' -> Domain ID: ${domainId} (Root: ${rootDomain}, Host: '${targetHost}')`);

    // Step 2: Fetch current DNS page
    const dnsUrl = `${DOMAINS_DNS_BASE_URL}?id=${domainId}&new=1`;
    console.log(`[DNS] Loading DNS records from: ${dnsUrl}`);
    const dnsRes = await requestWithCookies(partition, dnsUrl);

    if (dnsRes.statusCode !== 200 || !dnsRes.html) {
        throw new Error(`Failed to load DNS page for ${cleanDomain} (HTTP ${dnsRes.statusCode})`);
    }

    // Guard against a wrongly parsed domain ID: never write to another domain's zone
    if (!pageMentionsDomain(dnsRes.html, rootDomain)) {
        throw new Error(`DNS page for domain ID ${domainId} does not mention '${rootDomain}'; refusing to change it.`);
    }

    // Step 3: Parse existing DNS records
    const records = parseDnsRecords(dnsRes.html);
    console.log(`[DNS] Parsed ${records.length} existing DNS record(s):`, records);

    // Look for matching A record; several would make round-robin DNS serve stale IPs
    const matches = findARecords(records, targetHost, rootDomain);
    if (matches.length > 1) {
        throw new Error(`Found ${matches.length} A records for '${cleanDomain}' (${matches.map(r => r.rdata).join(", ")}). Remove the extra ones in the Forpsi admin; only a single A record is kept updated.`);
    }
    const matchingRecord = matches[0] || null;

    let postParams = null;

    if (matchingRecord) {
        console.log(`[DNS] Found matching A-record (r_ID: ${matchingRecord.r_ID}, current IP: '${matchingRecord.rdata}')`);

        // If IP is already identical, no update is needed
        if (matchingRecord.rdata === cleanIp) {
            console.log(`[DNS] Record '${cleanDomain}' is already set to ${cleanIp}.`);
            return {
                success: true,
                domain: cleanDomain,
                domainId: domainId,
                ip: cleanIp,
                updated: false,
                message: `DNS A record is already set to ${cleanIp}.`
            };
        }

        // Prepare record_save POST
        postParams = new URLSearchParams({
            ak: "record_save",
            url: `/domain/domains-dns.php?id=${domainId}`,
            r_ID: matchingRecord.r_ID,
            type: "A",
            name: matchingRecord.name,
            ttl: matchingRecord.ttl || "1800",
            rdata: cleanIp,
            srv_service: matchingRecord.srv_service || "",
            srv_protocol: "_tcp",
            tlsa_port: matchingRecord.tlsa_port || "",
            tlsa_protocol: "_tcp",
            mx_priority: matchingRecord.mx_priority || "10",
            srv_priority: matchingRecord.srv_priority || "10",
            srv_weight: matchingRecord.srv_weight || "",
            srv_port: matchingRecord.srv_port || "",
            flags: matchingRecord.flags || "0",
            tag: "issue"
        });
    } else {
        console.log(`[DNS] No existing A-record found for host '${targetHost}'. Creating new A-record...`);
        // Prepare record_add POST
        postParams = new URLSearchParams({
            ak: "record_add",
            url: `/domain/domains-dns.php?id=${domainId}`,
            type: "A",
            name: targetHost,
            ttl: "1800",
            rdata: cleanIp,
            srv_service: "",
            srv_protocol: "_tcp",
            tlsa_port: "",
            tlsa_protocol: "_tcp",
            mx_priority: "10",
            srv_priority: "10",
            srv_weight: "",
            srv_port: "",
            flags: "0",
            tag: "issue"
        });
    }

    // Step 4: Submit the update
    const submitUrl = `https://admin.forpsi.hu/domain/domains-dns.php?id=${domainId}`;
    console.log(`[DNS] Submitting DNS update POST to: ${submitUrl}`);

    const postRes = await requestWithCookies(partition, submitUrl, {
        method: "POST",
        body: postParams.toString(),
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": dnsUrl
        }
    });

    console.log(`[DNS] Save response HTTP ${postRes.statusCode}`);

    // Step 5: Verification - fetch DNS page again to confirm the IP was updated in Forpsi
    console.log(`[DNS] Verifying updated record on Forpsi...`);
    const verifyRes = await requestWithCookies(partition, dnsUrl);
    const updatedRecords = parseDnsRecords(verifyRes.html || "");
    const problem = findVerifyProblem(updatedRecords, targetHost, rootDomain, cleanIp);
    if (problem) {
        throw new Error(`Verification failed for '${cleanDomain}' (expected ${cleanIp}): ${problem}.`);
    }

    console.log(`[DNS] Verification successful! A-record for '${cleanDomain}' is confirmed set to ${cleanIp}.`);
    return {
        success: true,
        domain: cleanDomain,
        domainId: domainId,
        ip: cleanIp,
        updated: true,
        message: `Successfully updated A record on Forpsi to ${cleanIp}.`
    };
};

// Tail of the running updateAllDomains calls; each waits for the previous one
let updateQueue = Promise.resolve();

/**
 * Updates DNS A records for all configured domains in the list. Calls run one after
 * another: overlapping runs could each record_add a new A record for the same host.
 */
const updateAllDomains = function(partition, domainNames, currentIp) {
    const run = updateQueue.then(() => updateAllDomainsNow(partition, domainNames, currentIp));
    updateQueue = run.catch(() => {});
    return run;
};

const updateAllDomainsNow = async function(partition, domainNames, currentIp) {
    if (!domainNames || domainNames.length === 0) {
        return [];
    }

    const results = [];
    for (const domain of domainNames) {
        try {
            const res = await updateDnsForDomain(partition, domain, currentIp);
            results.push(res);
        } catch (err) {
            console.error(`[DNS] Error updating domain '${domain}':`, err);
            results.push({
                success: false,
                domain: domain,
                ip: currentIp,
                error: err.message
            });
        }
    }

    return results;
};

module.exports = {
    getDomainsList,
    updateDnsForDomain,
    updateAllDomains,
    findDomainIdForName,
    isValidIpv4,
    parseDnsRecords,
    parseDomainsList,
    pageMentionsDomain,
    normalizeHostName,
    findARecords,
    findVerifyProblem
};
