# DNS update safety fixes

Three correctness problems in `src/electron/dns.js` found in a code review.

## 1. False "success" after a failed update

The verify step fell back to `html.includes(ip)` on the whole DNS page, so any other
record already holding the IP (or a longer IP containing it) made a failed save look
successful, and the CLI then cached the domain as synced.

- [x] Verify only the A record(s) for the target host: exactly one, holding the new IP.

## 2. Host name matching creates duplicate A records

Record names were compared literally (`home`, `""`, `@`). A name shown as an FQDN or
with a trailing dot did not match, so `record_add` created a second A record next to
the stale one.

- [x] `normalizeHostName()`: accept `@`, FQDN and trailing-dot forms.
- [x] More than one A record for the host: fail with a clear error instead of
      updating one of them.

## 3. Writing to the wrong domain

`getDomainsList` took the first `id=\d+` in a table row, which can belong to an
unrelated link (`client_id=`, orders), and nothing checked the DNS page before POSTing.

- [x] Extract `parseDomainsList(html)`; links to `domains-dns.php` / `domains-detail.php`
      win, table rows only count a query-string `id=` and are skipped when ambiguous.
- [x] Refuse to POST unless the DNS page mentions the root domain.

## Tests

- [x] `tests/dns-parse.test.js`: host normalisation, duplicate detection, verification,
      domain list parsing, page ownership check.

## Limits

All parsing is still tested against hand-written HTML only; the real Forpsi markup has
not been captured. The ownership check is a heuristic: a page that lists every account
domain (e.g. a domain switcher) would always pass it.
