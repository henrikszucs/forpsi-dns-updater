# Forpsi DNS Updater

Dynamic DNS for domains hosted at [Forpsi](https://www.forpsi.hu). Forpsi has no API
for DNS records, so this tool logs in to the Forpsi web admin like a browser and keeps
the **A records** of your domains pointed at your current public IPv4 address.

It runs as a **CLI** (Node.js 18+, no dependencies) for servers, cron or systemd, or
as a **desktop app** (Electron) with a tray icon.

## Configure

```sh
cp conf/config.example.json conf/config.json
chmod 600 conf/config.json
```

```json
{
    "forpsi": {
        "username": "your-forpsi-username",
        "password": "your-forpsi-password"
    },
    "domains": ["example.com", "home.example.com"],
    "intervalMinutes": 5,
    "ipCheckUrl": "https://api.ipify.org?format=json"
}
```

All keys are optional. Subdomains are fine: the host's A record is updated, or created
if missing. `conf/config.json` is git-ignored.

Environment variables override the file: `FORPSI_USERNAME`, `FORPSI_PASSWORD`,
`DNS_UPDATER_DOMAINS` (comma-separated), `DNS_UPDATER_INTERVAL`, `DNS_UPDATER_IP_URL`,
`DNS_UPDATER_CONF_DIR` (folder of `config.json`) and `DNS_UPDATER_DATA_DIR`.

## Run

```sh
node src/cli.js once                        # update once, exit 1 on failure (for cron)
node src/cli.js run                         # keep running (default command)
node src/cli.js status                      # login state, public IP, last sync
node src/cli.js domains add|remove|list     # edit the domains in conf/config.json
node src/cli.js login                       # save credentials instead of the config file
node src/cli.js help                        # all commands and options
```

Useful options: `--verbose` (log every Forpsi request), `--force` (update even if the
IP is unchanged), `--domain <d>` (repeatable, overrides the config).

Session cookies, sync state and `login` credentials are kept in `~/.config/dns-updater`
(Linux) or `%APPDATA%\dns-updater` (Windows).

Desktop app: `npm install && npm start`. On Linux, Electron also needs:

```sh
sudo apt install libnss3 libnspr4 libgbm1 libgtk-3-0 libasound2t64
```

## Run as a service (Linux)

```sh
sudo mkdir -p /opt/dns-updater && sudo cp -r src conf /opt/dns-updater/
sudo cp deploy/dns-updater.env.example /etc/dns-updater.env
sudo chmod 600 /etc/dns-updater.env && sudo nano /etc/dns-updater.env   # credentials + domains
sudo cp deploy/dns-updater.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now dns-updater
journalctl -u dns-updater -f
```

Keep the credentials in `/etc/dns-updater.env`: the service's unprivileged user cannot
read a root-only `config.json`. Or use cron instead:

```cron
*/5 * * * * FORPSI_USERNAME=... FORPSI_PASSWORD=... node /opt/dns-updater/src/cli.js once --domain example.com
```

## Build and test

```sh
npm run build:win       # dist/dns-updater-win32-x64 (also build:linux, build)
npm test                # all tests, no network access to Forpsi
```

The build downloads the Electron runtime and needs Node.js 22.12+. In the Windows
build, `dns-updater-cli.cmd` runs the CLI and `config.json` goes in
`resources\app\conf\`.

## Good to know

- It works by reading Forpsi's web pages, so a change to their site can break it.
  `--verbose` shows what was parsed.
- DNS is only touched when the IP changes; each update is verified by reloading the
  DNS page.
- Passwords in `conf/config.json` are plain text and `login` stores them only
  base64-encoded (both mode 600). On servers prefer the environment variables.
