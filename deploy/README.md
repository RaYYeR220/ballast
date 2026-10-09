# Running the Risk Desk on a VPS

The desk is one long-running Node process (`apps/agent/src/desk/main.ts`): the Session Oracle publisher,
the account keeper, the guardian, the x402 earnings buyer, desk notes and the read API. This guide sets
it up on a small Debian or Ubuntu VPS with systemd and Caddy. Pick an EU region (DE or FR): keyed Binance
Web3 API calls are refused from some countries (code `40304`), and the desk then falls back to the keyless
public endpoints.

The read API is public, through Caddy over HTTPS. The Ballast MCP server can be public too: it is a second
unit (`ballast-mcp.service`) with no key, behind the same Caddy site at `/mcp` (see "Public MCP endpoint").
The Agent Studio A2A/MCP faces are not started by either unit; if you run them, they bind to `127.0.0.1`
and stay unproxied.

## 1. Node 22, pnpm and two users

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo corepack enable                       # provides the pnpm version pinned in package.json
# runs the desk: no home, no shell, owns nothing but its state directory
sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ballast
# fetches and installs the code: its own home for the pnpm store and caches, never runs the desk
sudo useradd --system --create-home --home-dir /var/lib/ballast-build --shell /usr/sbin/nologin ballast-build
```

The split keeps the running desk from ever writing its own code: the service user can read `/opt/ballast`
and write `/var/lib/ballast`, nothing else, and the user that can write the code never holds the key.

## 2. Code

```bash
sudo install -d -o ballast-build -g ballast-build /opt/ballast
sudo -u ballast-build -H git clone https://github.com/RaYYeR220/ballast /opt/ballast
cd /opt/ballast
sudo -u ballast-build -H corepack pnpm install --frozen-lockfile --ignore-scripts
sudo chown -R root:root /opt/ballast       # from here on the code is root-owned and read-only
```

`--ignore-scripts` runs no dependency install script as any user on this host. The only dependency that
has one is esbuild (pulled in by `tsx`), and it works without it: its platform binary ships as an optional
dependency. `--frozen-lockfile` installs exactly what `pnpm-lock.yaml` pins.

`contracts/deployments/56.json` must be in the checkout (it is committed after the mainnet deploy). Check
the deployment against the chain before anything runs on it:

```bash
sudo -u ballast-build -H env BSC_RPC_URL=<rpc> PUBLISHER_ADDRESS=<desk address> PUBLISHER_AGENT_ID=<agent id> \
  VERIFY_SKIP_BYTECODE=1 corepack pnpm verify:onchain
```

It checks code at every address, the external addresses against `config/bsc-mainnet.json`, the wiring
between the contracts, the Session Oracle params and tickers, the publisher and that its ERC-8004 identity
belongs to the desk key (owner or agent wallet), the guardian limits and `guardianStartJobId`, and that the
on-chain calendar agrees with the desk's on the current session. It prints explorer links and exits non-zero
on any mismatch.

Run it once without `VERIFY_SKIP_BYTECODE` on the machine that built and deployed the contracts
(`pnpm contracts:build` first). There it also compares the runtime bytecode of all eight contracts with
the forge artifacts: same length, immutable ranges zeroed on both sides (they are constructor arguments,
covered by the wiring checks), trailing CBOR metadata cut, then keccak256 of the rest must match.

## 3. Secrets and settings

```bash
sudo install -d -m 0750 -o root -g ballast /etc/ballast
sudo install -m 0600 -o root -g root deploy/agent.env.example /etc/ballast/agent.env
sudoedit /etc/ballast/agent.env
```

`agent.env` is `root:root 0600`: systemd reads it as root and hands the variables to the process, so the
desk user cannot read (or leak) the file itself. A keystore, if you use one instead of `AGENT_PRIVATE_KEY`,
is read by the desk and goes to `/etc/ballast/` as `root:ballast 0640`.

Every variable is documented in the file. For mainnet set at least `CHAIN_ID=56`, `BSC_RPC_URL` (https), the
signer and `WEB_ORIGIN`; `DATA_DIR=/var/lib/ballast` and `DX_PROBE_FILE` are pre-filled. Leave `DRY_RUN`
unset (true) for the first start, read the feed, then set `DRY_RUN=false`.

**The RPC endpoint must serve receipts and accept batched calls.** The desk learns what became of a
transaction from `eth_getTransactionReceipt`, and it reads the chain in JSON-RPC batches of `eth_call`.
An endpoint that fails either one looks healthy until the desk sends something. Two failure signatures,
both seen on public BSC endpoints:

- `https://bsc-rpc.publicnode.com` accepts batches but answers `eth_getTransactionReceipt` with **HTTP 403**
  and `{"code":-32602,"message":"Archive requests require a personal token. ..."}`, even for a transaction
  mined a second ago. The desk then cannot confirm anything it sends: on its first day on mainnet it
  recorded mined overlay posts as dropped or pending for that reason (the note in `PROOF.md`).
- The `bsc-dataseed` endpoints serve receipts but can answer a batch with
  `{"code":-32005,"message":"method eth_call in batch triggered rate limit"}`. Reads then fail in bursts.

Use a provider endpoint that does both, and test it before the first start. `<rpc>` is the endpoint,
`<hash>` any recent transaction hash from a block explorer:

```bash
# must return a receipt, not an error
curl -s -X POST -H 'content-type: application/json' <rpc> \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["<hash>"]}'
# must return two results, not an error (the call is SessionOracle.owner() on chain 56)
curl -s -X POST -H 'content-type: application/json' <rpc> \
  -d '[{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x8Fc983D9cC9880e0FbBcd7F48304A175b4055388","data":"0x8da5cb5b"},"latest"]},{"jsonrpc":"2.0","id":2,"method":"eth_call","params":[{"to":"0x8Fc983D9cC9880e0FbBcd7F48304A175b4055388","data":"0x8da5cb5b"},"latest"]}]'
```

A rate limit on batches shows under load, so a pass of the second check is necessary, not sufficient:
watch the desk's log for `-32005` in the first hour. The MCP server and the web app only read, so an
endpoint that refuses receipts is fine for them as long as it accepts batches.

The desk refuses to start when `DATA_DIR` is not writable (it test-writes at startup and exits non-zero),
when `HTTP_HOST` or `AGENT_BIND_HOST` is not loopback on chain 56, when the RPC or the paid-data URL is
plain http on chain 56, and when `guardian.json` in `DATA_DIR` was written for another chain or guardian.

**Binance Web3 API keys are required on mainnet for collateral sales.** A sale (`shieldDeleverage`) is only
ever broadcast through the Binance MEV-protected endpoint, never to the public mempool. Without
`BINANCE_WEB3_API_KEY` / `BINANCE_WEB3_API_SECRET` the desk never signs a sale: it still shields with the
cushion (the keeper plans the cushion repay only and alerts once per account and closure that it is not
enough), posts overlays and settles guardian jobs over the RPC, and it warns at startup, records an alert in
the feed and shows `sender.sales: "disabled"` in `/health` (`"protected"` with the keys).

The desk key needs BNB for gas; the feed raises an alert below `MIN_BNB_BALANCE`. Paid earnings data is
off until `X402_EARNINGS_URL` is set; the key then also needs the stablecoin the endpoint is paid in, on
the network it is paid on (`X402_NETWORKS`), and spend stays under `X402_MAX_PRICE_USD` per call (at most
0.05) and `X402_DAILY_CAP_USD` per day (at most 0.5).

## 4. The service

```bash
sudo cp deploy/ballast-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ballast-agent
journalctl -u ballast-agent -f
curl -s http://127.0.0.1:8787/health
```

`Restart=always` brings the process back after a crash; each loop already isolates its own failures and
backs off, and the API stays up through RPC or Binance outages.

The desk sends one transaction at a time. `/health` shows the sender: how sales leave (`sales`), the
transaction in flight (nonce and every hash signed for it) and, when it has halted, why (`STUCK`, `GAS_CAP`,
`INSUFFICIENT_FUNDS`, `FEE_BUDGET`, `FOREIGN_BLOCKER`, `BUILD_FAILED`). While halted `/health` answers HTTP
503 with `ok: false` and the desk signs nothing; it resumes by itself once the cause clears (the nonce is
mined, the key is topped up, the hour has moved on). Point an uptime check at `/health` to be paged for it.

If a halt alert does not clear, restart the desk (`systemctl restart ballast-agent`): at startup it takes
over whatever is pending for the key and cancels it. For a `GAS_CAP` halt that does not clear, raise
`MAX_GAS_PRICE_GWEI` in `agent.env` first, then restart. Nothing else may sign with the desk key while the
desk runs. `systemctl stop` sends SIGTERM: the desk
stops scheduling, lets a transaction waiting for its receipt finish (up to `TimeoutStopSec`), then flushes
the ledger and the guardian cursor.

State lives in `/var/lib/ballast` (the unit's `StateDirectory`, created by systemd for the `ballast`
user): `feed.jsonl` (audit feed), `ledger.json`, `sender.json` (the nonce in flight and every hash signed for
it, so a restart settles it before sending anything new), `guardian.json` (scan cursor and open jobs, stamped with
the chain id and guardian address), `evidence/<jobId>.json` (submitted guardian evidence; its keccak256 is
the on-chain deliverable), `earnings-paid.json`, `notes.jsonl`. Back it up; never delete `evidence/` for
open jobs. After a redeploy of the contracts move the old directory away: the desk will not load state
that belongs to another guardian.

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

With the MCP endpoint (next section) the site becomes two `handle` blocks: see there.

```bash
sudo systemctl reload caddy
curl -s https://desk.example.org/health
```

Caddy obtains the certificate and passes the client address in `X-Forwarded-For`; the desk only trusts that
header from a loopback peer, for its per-IP rate limit. Open only 22, 80 and 443:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

## Public MCP endpoint

The MCP server (`packages/mcp`) gives any MCP client the Ballast read and plan tools: session state, oracle
price and `canAddRisk`, position risk, shield plans, accounts, guardian jobs, token status. Served publicly it
is **unauthenticated, read and plan only, and rate limited**: it holds no key, signs nothing, answers
`MCP_RATE_PER_MIN` requests a minute per client address (120 by default) and caps heavy chain reads in
flight. It binds `127.0.0.1:8790`; Caddy terminates TLS and forwards `/mcp` to it. The server refuses any
request whose `Host` is not on its allowlist, so the public host name must be in `MCP_ALLOWED_HOSTS`.

```bash
sudo install -m 600 -o root -g root /opt/ballast/deploy/mcp.env.example /etc/ballast/mcp.env
sudoedit /etc/ballast/mcp.env                 # BSC_RPC_URL, MCP_ALLOWED_HOSTS=<the public host name>
sudo cp /opt/ballast/deploy/ballast-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ballast-mcp
curl -s -H 'Host: desk.example.org' http://127.0.0.1:8790/health      # {"ok":true,"name":"ballast",...}
```

`/etc/caddy/Caddyfile`, replacing the site from section 5. `POST` is how MCP's Streamable HTTP works, so it
is allowed on `/mcp` and nowhere else; everything but `/mcp` still goes to the desk's read API, `GET` only:

```
desk.example.org {
	header -Server
	header Strict-Transport-Security "max-age=31536000"

	handle /mcp {
		reverse_proxy 127.0.0.1:8790
	}
	handle {
		encode gzip
		@write not method GET HEAD OPTIONS
		respond @write 405
		reverse_proxy 127.0.0.1:8787
	}
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
curl -s https://desk.example.org/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                   # the eight tools
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://desk.example.org/feed    # 405: the read API stays GET only
```

Start order: `ballast-mcp` first, then reload Caddy, so `/mcp` never answers 502. Neither step touches the
desk (`ballast-agent`), which keeps running.

Client configuration, one line (any MCP client that speaks Streamable HTTP):

```json
{ "mcpServers": { "ballast": { "type": "http", "url": "https://desk.example.org/mcp" } } }
```

Caddy passes the client address in `X-Forwarded-For`; like the desk, the MCP server believes that header
only from a loopback peer. `journalctl -u ballast-mcp -f` shows the server's log. To take the endpoint down:
`sudo systemctl disable --now ballast-mcp` and remove the `handle /mcp` block.

Once `/mcp` answers, list it in the desk's ERC-8004 registration (`--mcp-url`, see `apps/agent/README.md`):
the registration names only endpoints that are really served.

## Read API

| Path | What |
|---|---|
| `/health` | process, sender (halt, transaction in flight) and loop status; 503 while the sender is halted |
| `/feed?account=&kind=&source=&limit=` | audit feed, newest first, with desk notes |
| `/accounts` | Ballast accounts and CushionVault covers with their state |
| `/oracle` | session and Session Oracle snapshot per ticker |
| `/ledger?kind=&limit=` | income, gas (one entry per nonce: the mined transaction, cancels labelled) and x402 spend |
| `/evidence/:jobId` | the evidence file a guardian job was submitted with |
| `/api-health` | Binance call latency (p50/p95) and response codes |

## Updating

```bash
cd /opt/ballast
sudo systemctl stop ballast-agent
sudo chown -R ballast-build:ballast-build /opt/ballast
sudo -u ballast-build -H git pull --ff-only
sudo -u ballast-build -H corepack pnpm install --frozen-lockfile --ignore-scripts
sudo chown -R root:root /opt/ballast
sudo systemctl start ballast-agent
sudo systemctl restart ballast-mcp          # if the MCP endpoint is installed
```
