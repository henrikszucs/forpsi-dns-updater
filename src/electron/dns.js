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

    const html = res.html;
    const domainsMap = new Map();

    // Pattern 1: Table rows containing domain names and id links
    const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
        const rowHtml = match[0];
        const idMatch = rowHtml.match(/id=(\d+)/i);
        const domainMatch = rowHtml.match(/>\s*([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\s*</i);
        if (idMatch && domainMatch) {
            const domain = domainMatch[1].toLowerCase();
            const id = idMatch[1];
            if (!domainsMap.has(domain)) {
                domainsMap.set(domain, id);
            }
        }
    }

    // Pattern 2: Direct links to domains-detail.php?id= or domains-dns.php?id=
    const linkRegex = /href=["'](?:https?:\/\/[^\/]+)?\/domain\/domains-(?:dns|detail)\.php\?id=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = linkRegex.exec(html)) !== null) {
        const id = match[1];
        const rawText = match[2].replace(/<[^>]+>/g, "").trim().toLowerCase();
        const domainMatch = rawText.match(/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/i);
        if (domainMatch) {
            domainsMap.set(domainMatch[0], id);
        }
    }

    const result = [];
    for (const [domain, id] of domainsMap.entries()) {
        result.push({ domain, id });
    }

    console.log(`[DNS] Found ${result.length} domain(s) in Forpsi account:`, result);
    return result;
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

        // Selected type
        const typeSelectMatch = rowContent.match(/<select\s+name="type"[^>]*>([\s\S]*?)<\/select>/i);
        let type = "A";
        if (typeSelectMatch) {
            const optMatch = typeSelectMatch[1].match(/<option\s+value="([^"]+)"\s+selected>/i) ||
                             typeSelectMatch[1].match(/<option\s+selected\s+value="([^"]+)">/i);
            if (optMatch) type = optMatch[1];
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
    const cleanIp = currentIp.trim();

    console.log(`[DNS] Starting DNS update for '${cleanDomain}' to IP: ${cleanIp}`);

    // Step 1: Resolve domain ID
    const availableDomains = await getDomainsList(partition);
    const domainInfo = findDomainIdForName(cleanDomain, availableDomains);

    if (!domainInfo) {
        throw new Error(`Domain '${cleanDomain}' was not found in your Forpsi domain list.`);
    }

    const { domainId, rootDomain, host } = domainInfo;
    const targetHost = host === "@" ? "" : host;
    console.log(`[DNS] Resolved '${cleanDomain}' -> Domain ID: ${domainId} (Root: ${rootDomain}, Host: '${targetHost}')`);

    // Step 2: Fetch current DNS page
    const dnsUrl = `${DOMAINS_DNS_BASE_URL}?id=${domainId}&new=1`;
    console.log(`[DNS] Loading DNS records from: ${dnsUrl}`);
    const dnsRes = await requestWithCookies(partition, dnsUrl);

    if (dnsRes.statusCode !== 200 || !dnsRes.html) {
        throw new Error(`Failed to load DNS page for ${cleanDomain} (HTTP ${dnsRes.statusCode})`);
    }

    // Step 3: Parse existing DNS records
    const records = parseDnsRecords(dnsRes.html);
    console.log(`[DNS] Parsed ${records.length} existing DNS record(s):`, records);

    // Look for matching A record
    const matchingRecord = records.find(r => {
        if (r.type !== "A") return false;
        const rName = r.name.toLowerCase();
        return rName === targetHost.toLowerCase() ||
               rName === "" && targetHost === "" ||
               rName === "@" && targetHost === "";
    });

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
    const verifiedRecord = updatedRecords.find(r => {
        if (r.type !== "A") return false;
        const rName = r.name.toLowerCase();
        return rName === targetHost.toLowerCase() ||
               rName === "" && targetHost === "" ||
               rName === "@" && targetHost === "";
    });

    if (verifiedRecord && verifiedRecord.rdata === cleanIp) {
        console.log(`[DNS] Verification successful! A-record for '${cleanDomain}' is confirmed set to ${cleanIp}.`);
        return {
            success: true,
            domain: cleanDomain,
            domainId: domainId,
            ip: cleanIp,
            updated: true,
            message: `Successfully updated A record on Forpsi to ${cleanIp}.`
        };
    } else {
        // Check if the IP exists anywhere in the DNS table
        if (verifyRes.html && verifyRes.html.includes(cleanIp)) {
            return {
                success: true,
                domain: cleanDomain,
                domainId: domainId,
                ip: cleanIp,
                updated: true,
                message: `DNS A record updated to ${cleanIp}.`
            };
        }

        throw new Error(`Verification failed: Forpsi DNS table does not show IP ${cleanIp}. Current: '${verifiedRecord ? verifiedRecord.rdata : "Not found"}'`);
    }
};

/**
 * Updates DNS A records for all configured domains in the list.
 */
const updateAllDomains = async function(partition, domainNames, currentIp) {
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
    parseDnsRecords
};
