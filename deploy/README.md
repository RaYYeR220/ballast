# Running the Risk Desk on a VPS

The desk is one long-running Node process (`apps/agent/src/desk/main.ts`): the Session Oracle publisher,
the account keeper, the guardian, the x402 earnings buyer, desk notes and the read API. This guide sets
it up on a small Debian or Ubuntu VPS with systemd and Caddy. Pick an EU region (DE or FR): keyed Binance
Web3 API calls are refused from some countries (code `40304`), and the desk then falls back to the keyless
public endpoints.

Only the read API is public, through Caddy over HTTPS. The Agent Studio A2A/MCP faces and the Ballast MCP
server are not started by this unit; if you run them, they bind to `127.0.0.1` and stay unproxied.

## 1. Node 22, pnpm and a service user

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo corepack enable                       # provides the pnpm version pinned in package.json
sudo useradd --system --home /opt/ballast --shell /usr/sbin/nologin ballast
```

## 2. Code

```bash
sudo git clone <repository-url> /opt/ballast
sudo chown -R ballast:ballast /opt/ballast
cd /opt/ballast
sudo -u ballast corepack pnpm install --frozen-lockfile
```

`contracts/deployments/56.json` must be in the checkout (it is committed after the mainnet deploy). Check
the deployment against the chain before anything runs on it:

```bash
sudo -u ballast env BSC_RPC_URL=<rpc> PUBLISHER_ADDRESS=<desk address> PUBLISHER_AGENT_ID=<agent id> \
  corepack pnpm verify:onchain
```

It checks code at every address, the wiring between the contracts, the Session Oracle params and tickers
against `config/bsc-mainnet.json`, the publisher, the guardian limits and `guardianStartJobId`, prints
explorer links and exits non-zero on any mismatch.

## 3. Secrets and settings

```bash
sudo install -d -m 0750 -o root -g ballast /etc/ballast
sudo install -m 0640 -o root -g ballast deploy/agent.env.example /etc/ballast/agent.env
sudoedit /etc/ballast/agent.env
```

Every variable is documented in the file. For mainnet set at least `CHAIN_ID=56`, `BSC_RPC_URL`, the signer
(`AGENT_PRIVATE_KEY`, or `AGENT_KEYSTORE_PATH` plus its password with the keystore in `/etc/ballast/`),
`DATA_DIR=/var/lib/ballast`, `DX_PROBE_FILE=/var/lib/ballast/dx-probe.jsonl` and `WEB_ORIGIN`. Leave
`DRY_RUN` unset (true) for the first start, read the feed, then set `DRY_RUN=false`.

The desk key needs BNB for gas; the feed raises an alert below `MIN_BNB_BALANCE`. Paid earnings data is
off until `X402_EARNINGS_URL` is set; the key then also needs the stablecoin the endpoint is paid in, on
the network it is paid on (`X402_NETWORKS`), and spend stays under `X402_MAX_PRICE_USD` per call and
`X402_DAILY_CAP_USD` per day.

## 4. The service

```bash
sudo cp deploy/ballast-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ballast-agent
journalctl -u ballast-agent -f
curl -s http://127.0.0.1:8787/health
```

`Restart=always` brings the process back after a crash; each loop already isolates its own failures and
backs off, and the API stays up through RPC or Binance outages. `systemctl stop` sends SIGTERM: the desk
stops scheduling, lets a transaction waiting for its receipt finish (up to `TimeoutStopSec`), then flushes
the ledger and the guardian cursor.

State lives in `/var/lib/ballast`: `feed.jsonl` (audit feed), `ledger.json`, `guardian.json` (scan cursor
and open jobs), `evidence/<jobId>.json` (submitted guardian evidence; its keccak256 is the on-chain
deliverable), `earnings-paid.json`, `notes.jsonl`. Back it up; never delete `evidence/` for open jobs.

## 5. HTTPS with Caddy

```bash
sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```
desk.example.org {
	encode gzip
	header -Server
	header Strict-Transport-Security "max-age=31536000"
	@write not method GET HEAD OPTIONS
	respond @write 405
	reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
curl -s https://desk.example.org/health
```

Caddy obtains the certificate and passes the client address in `X-Forwarded-For`; the desk only trusts that
header from a loopback peer, for its per-IP rate limit. Open only 22, 80 and 443:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

## Read API

| Path | What |
|---|---|
| `/health` | process and loop status (runs, failures, last error, next run) |
| `/feed?account=&kind=&source=&limit=` | audit feed, newest first, with desk notes |
| `/accounts` | Ballast accounts and CushionVault covers with their state |
| `/oracle` | session and Session Oracle snapshot per ticker |
| `/ledger?kind=&limit=` | income, gas and x402 spend, today and in total |
| `/evidence/:jobId` | the evidence file a guardian job was submitted with |
| `/api-health` | Binance call latency (p50/p95) and response codes |

## Updating

```bash
cd /opt/ballast
sudo -u ballast git pull --ff-only
sudo -u ballast corepack pnpm install --frozen-lockfile
sudo systemctl restart ballast-agent
```
