# CLAUDE.md

This file guides Claude Code (claude.ai/code) when working in this repository.

## What this project is

Dynamic DNS updater for the **Forpsi** hosting provider (admin.forpsi.hu). Forpsi has no
API or CLI for DNS records, so the tool logs in to the Forpsi web admin like a browser,
scrapes the HTML pages, and submits the same form POSTs the web UI does. It watches the
machine's public IPv4 address and keeps the DNS **A records** of the configured domains
pointed at it.

It ships in two flavours that share the same core logic:

- **Desktop app** (Electron): window + tray icon, auto-launch on login.
- **Headless CLI** (plain Node.js 18+, no npm dependencies): for servers, cron and systemd.

## Repository layout

| Path | Role |
| --- | --- |
| `package.json` | Manifest (`main: src/main.js`, `bin: dns-updater -> src/cli.js`, Node >= 18, `electron` dev dependency) |
| `src/main.js` | Electron main process: single-instance lock, `local://local.local` protocol serving `src/renderer/`, main window, tray, IPC `api` handler |
| `src/cli.js` | Headless CLI entry point (`run`, `once`, `login`, `logout`, `status`, `ip`, `domains list/add/remove`) |
| `src/electron/platform.js` | Runtime abstraction so `auth.js`/`dns.js` run under both Electron and plain Node: data dir, `safeStorage`, cookie jar (Electron session vs. in-memory jar) |
| `src/electron/auth.js` | Forpsi login (`login-ajax.php`, optional 2FA/OTP), session check, credential storage, cookie persistence |
| `src/electron/dns.js` | Domain list scraping, DNS record parsing, A-record update/create and verification |
| `src/renderer/` | Desktop UI (`index.html`/`.js`/`.css`); vendored libs in `libs/` (BeerCSS, `idb`, `auto-launch`), do not reformat |
| `src/icons/` | App and tray icons |
| `deploy/` | `dns-updater.service` (systemd), `dns-updater.env.example`, `dns-updater-cli.cmd` (Windows launcher for a packaged build: `node` if present, else `dns-updater.exe` with `ELECTRON_RUN_AS_NODE=1`; CRLF line endings) |
| `scripts/build.js` | Desktop packaging, see "Build" |
| `tests/` | `node:test` suites, helpers and the Electron smoke fixture, see "Tests" |
| `dist/` | Git-ignored build output |
| `README.md` | Essentials: what it is, configure, run, how it works, security |
| `conf/` | User config: `config.json` (git-ignored, may hold the password) and the committed `config.example.json` |
| `docs/plans/active/`, `docs/plans/done/` | Implementation plans, see "Documentation and plans" |

`src/main.js` resolves `renderer/` and `icons/` via `__dirname` (not
`app.getAppPath()`, which is the repo root), and the `path-app` IPC handle returns
`src/`.

Keep `"name": "dns-updater"` in `package.json` and do **not** add a `productName`:
Electron derives its `userData` folder from it, and it must match `APP_NAME` in
`platform.js` so the desktop app and CLI share the same data directory.

## How it works

1. **Public IP**: fetched from `https://api.ipify.org?format=json` (override with
   `DNS_UPDATER_IP_URL`; JSON `{"ip": ...}` or plain text).
2. **Login** (`auth.performLogin`): POST to `https://admin.forpsi.hu/login-ajax.php`.
   If the response asks for 2FA, it returns `need2FA: true` and the caller retries with
   an OTP code. Session cookies are persisted to `forpsi_cookies.json`.
3. **Domain lookup** (`dns.getDomainsList`): scrapes `domain/domains-list.php` with
   regexes to map domain names to Forpsi internal IDs. Subdomains resolve to their root
   domain plus a host part (`findDomainIdForName`).
4. **Update** (`dns.updateDnsForDomain`): loads `domain/domains-dns.php?id=<id>&new=1`,
   refuses to continue unless the page mentions the root domain (`pageMentionsDomain`),
   parses the records (a row whose type cannot be read is skipped, never assumed
   to be A), then POSTs `ak=record_save` (existing A record) or
   `ak=record_add` (none yet). Skips the POST if the IP is already correct. Record names
   are compared via `normalizeHostName` (`@`, FQDN, trailing dot); more than one A
   record for the host is an error, never guessed. The IP must pass `isValidIpv4` before
   any request, and `updateAllDomains` calls are queued so updates never overlap.
5. **Verify**: reloads the DNS page and requires exactly one A record for the host,
   holding the new IP (`findVerifyProblem`). Never fall back to searching the page text.

All HTTP is done with `node:https` and a manual `Cookie` header (`requestWithCookies`),
with a browser-like User-Agent. HTML is parsed with regexes, so any Forpsi UI change
can break scraping; keep the parsers tolerant and log what was parsed.

### Desktop ↔ main process

The renderer runs with `nodeIntegration: true`, `contextIsolation: false` and talks to
the main process over a single IPC channel `"api"`:
`ipcRenderer.invoke("api", "<handle>", ...args)`. Handles in `main.js` include
`path-exe`, `path-app`, `set-tray`, `set-tray-text`, `login`, `check-auth`,
`auto-login`, `get-saved-credentials`, `logout`, `get-forpsi-domains`, `update-dns`.
The desktop app keeps its domain list in IndexedDB; the CLI reads `conf/config.json`.

### Config vs. data

Two separate places, don't mix them:

- **`conf/config.json`**: settings the user edits (CLI only). Keys: `forpsi.username`,
  `forpsi.password`, `domains`, `intervalMinutes`, `ipCheckUrl`, all optional. Located
  via `--conf-dir` > `DNS_UPDATER_CONF_DIR` > `conf/` next to `src/`
  (`getConfDir()` in `cli.js`). `domains add/remove` rewrite it with 4-space JSON,
  mode 600, keeping key order. If it is missing, the legacy data-dir `cli_config.json`
  is read instead. When adding a config key, update `conf/config.example.json`,
  `README.md` and the `USAGE` text.
- **Data directory**: files the program writes itself. `~/.config/dns-updater`
  (Linux), `%APPDATA%\dns-updater` (Windows), `~/Library/Application Support/dns-updater`
  (macOS), or `--data-dir` / `DNS_UPDATER_DATA_DIR`. Files: `forpsi_credentials.json`
  (from `login`; keychain-encrypted in the desktop app, only base64 in the CLI, mode
  600), `forpsi_cookies.json`, `cli_state.json`.

Precedence in the CLI: flags > environment variables > `conf/config.json` > defaults.
Credentials: `FORPSI_USERNAME`/`FORPSI_PASSWORD` > config file > saved by `login`
(`resolveCredentials()`); only `login`-saved credentials get re-saved after a re-login.

## Running

```sh
npm install
npm start                                    # desktop app (electron .)
npm run cli -- help                          # same as node src/cli.js help
cp conf/config.example.json conf/config.json # then edit credentials and domains
node src/cli.js once --verbose               # one cycle with request logs
node src/cli.js run --interval 5             # loop
node src/cli.js status --conf-dir /tmp/c --data-dir /tmp/d   # throwaway dirs when testing
```

When testing by hand, never run `once`/`run`/`login` against Forpsi with fake
credentials. `help`, `domains` and `ip` stay offline; `status` makes one read-only GET
to admin.forpsi.hu (`checkAuthStatus` always does).

On Linux, Electron needs system libraries:
`sudo apt install libnss3 libnspr4 libgbm1 libgtk-3-0 libasound2t64` (WSL has a display
via WSLg). The CLI needs nothing extra.

### Tests

`npm test` runs `node --test tests/*.test.js` (built-in runner, no test dependencies);
`npm run test:electron` runs only the Electron checks.

- `tests/helpers.js`: temp dirs, env isolation (`clearProgramEnv`, `childEnv`),
  `runCli()` to spawn the CLI with its own conf/data dirs. IP lookups point to an
  unreachable local URL.
- Unit tests `require()` modules directly: `src/cli.js` and `scripts/build.js` only
  run `main()` when `require.main === module` and export their helpers;
  `dns.js` exports its pure parsers/matchers (`parseDnsRecords`, `parseDomainsList`,
  `findDomainIdForName`, `normalizeHostName`, `findARecords`, `findVerifyProblem`,
  `pageMentionsDomain`, `isValidIpv4`) and `auth.js` its Set-Cookie handling
  (`parseSetCookieHeaders`, `applySetCookies`) for tests.
- `tests/electron.test.js`: binary loads, CLI under `ELECTRON_RUN_AS_NODE`, and the
  desktop smoke test via `tests/fixtures/electron-smoke.js` (starts `src/main.js`
  with an isolated `userData`, prints `SMOKE_OK` after the window loads, `SMOKE_FAIL`
  on crashes or uncaught renderer errors). Skipped without a display; fails with an
  apt hint when shared libraries are missing.
- Tests must never contact Forpsi: no `status`, `once` with domains, `run` or
  `login` in tests. Each test file runs in its own process, so module state
  (`setConfDir`, `platform.setDataDir`, `process.env`) is reset in `beforeEach`.
- Add or update tests with every behaviour change.

### Build

`npm run build:win` / `build:linux` / `build` (current platform) run
`scripts/build.js`, which uses `@electron/packager` (needs Node 22.12+) to download the
Electron runtime for the target and write `dist/dns-updater-<platform>-<arch>/`:

- Executable is `dns-updater(.exe)` (`executableName`); no asar, so the app sits
  unpacked in `resources/app/` and the CLI can run via `ELECTRON_RUN_AS_NODE`.
- `resources/app/` gets only a whitelist: `package.json`, `src/`,
  `conf/config.example.json` (`INCLUDE` in `build.js`). Never widen it to include
  `conf/config.json` or other local secrets.
- Windows builds also get `deploy/dns-updater-cli.cmd` copied next to the exe.
- No custom icon yet: embedding a Windows `.ico` from Linux needs wine/rcedit.

From WSL, a Windows build can be smoke-tested through interop:
`ELECTRON_RUN_AS_NODE=1 WSLENV=ELECTRON_RUN_AS_NODE ./dns-updater.exe resources/app/src/cli.js help`.

## Documentation and plans

- **`README.md` stays in the repo root** and holds the essentials: what the tool is,
  configuring, running, service setup, build/test, caveats. Keep it short.
- **No duplicated documentation**: each fact is written once. Put new user docs in
  the README unless it grows too long; the full option list lives in `cli.js help`.
- **All other documentation lives in `docs/`**. Do not add `.md` docs to the repo root
  or next to source files. Claude config (this file, settings) stays in `.claude/`.
- **Plans** go in `docs/plans/` as one Markdown file per piece of work, named
  `YYYY-MM-DD-short-slug.md` (e.g. `2026-09-27-electron-packaging.md`):
  - `docs/plans/active/`: plans being worked on. Update the plan as work progresses.
  - `docs/plans/done/`: move the file here (`git mv`) once the work is finished,
    keeping it as a record.
- When behaviour, commands or config change, update the matching doc in `docs/` in the
  same change.

## Code style

- **4 spaces** for indentation, no tabs.
- **Double quotes** for strings (`"like this"`); template literals only when
  interpolating.
- `"use strict";` at the top of CommonJS files; `require("node:...")` for built-ins.
- Functions are declared as `const name = function(...) { ... };` or
  `const name = async function(...) { ... };`; short callbacks may use arrows.
- Object keys in Electron option objects are quoted (`{ "width": 800 }`), matching
  `main.js`.
- JSDoc `/** ... */` comment above exported/non-trivial functions.
- Log with a module prefix: `console.log("[DNS] ...")`, `console.error("[Auth] ...")`.
  The CLI silences `console.log` unless `--verbose` is given.
- No npm runtime dependencies in the core (`cli.js`, `electron/*.js`); keep the CLI
  runnable with only Node.js. Third-party browser libs are vendored under
  `renderer/libs/`.
- Never log or commit real Forpsi credentials, cookies or OTP codes.
