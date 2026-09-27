# Code review fixes

Problems found in a full code review (after the DNS update safety work).

## 1. Unparsed record types defaulted to "A"

`parseDnsRecords` started every record as type `A` and only overrode it when the
selected option looked exactly like `<option value="X" selected>`. With
`selected="selected"`, `selected >` or another attribute first, CNAME/TXT/MX rows became
"A records": `record_save` would turn a CNAME into an A record and verification would
pass.

- [x] Read the selected option tolerantly (any attribute order, `selected="..."`),
      or a hidden `type` input.
- [x] Skip (and warn about) rows whose type cannot be read; never guess.

## 2. Desktop app ran overlapping syncs

`tickCountdown` called `doRefresh` every second until the refresh finished, and
`isSyncing` was only set after the auth check, so several `update-dns` runs could
overlap and each `record_add` a new A record.

- [x] Renderer: guard `doRefresh` against re-entry from the countdown; take the sync lock
      before any `await`; queue a sync requested while one runs; share one in-flight
      auth check.
- [x] `dns.updateAllDomains`: run calls one after another (module-level queue), so no
      caller can overlap updates.

## 3. HTML injection in the renderer

`renderDomains` put sync messages (which can hold scraped Forpsi values) and IPs into
`innerHTML`, in a window with `nodeIntegration`.

- [x] Build the domain rows with DOM APIs / `textContent`.

## 4. Desktop app did not validate the public IP

- [x] `dns.isValidIpv4()`; `updateDnsForDomain` refuses anything else before any request.
      The CLI uses it; the renderer checks the lookup result too.

## 5. Cookie handling

- [x] `res.resume()` on responses whose body is not read (socket leak with keep-alive).
- [x] Honour `Expires` / `Max-Age`: an expired Set-Cookie deletes the cookie instead of
      storing it (`jar.remove`).

## Tests

- [x] `tests/dns-parse.test.js`: type markup variants, unreadable type skipped,
      `isValidIpv4`, invalid IP rejected without network.
- [x] `tests/platform-auth.test.js`: Set-Cookie expiry parsing, deletion, memory jar
      `remove`.

## Not done

- With 2FA enabled, the unattended CLI still retries login every interval and gets
  "OTP required" each time.
- `pageMentionsDomain` stays a heuristic (see the DNS update safety plan).
- The renderer has no unit tests; only the Electron smoke test covers it (sync lock,
  queue and badge rendering were checked by review, not by a test).
- The `updateAllDomains` queue has no test: proving it needs a stubbed HTTP layer.
