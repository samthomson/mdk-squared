# mdk² (mdk-squared)

Control a fleet of **Heatbit BitAir** purifier-miners from one app built on **two MDKs**:

- **Tether MDK** — the device plane. A first-of-its-kind `bitair-mdk-worker` (Heatbit has
  committed to MDK but shipped no Worker; this repo fills the gap) hosted on the Kernel,
  with three mock BitAirs so everything runs with **zero hardware**.
- **Marmot MDK** (`@internet-privacy/marmot-ts`) — the people plane. The app itself is a
  member of one MLS (RFC 9420) group: **group membership is the access list**, and the
  encrypted group chat is a control channel.

Plus a **PM2.5 autopilot** driven by Nostr weather stations (kinds 16158/4223,
[draft NIP PR 2163](https://github.com/nostr-protocol/nips/pull/2163) — the
[samthomson/weather-station](https://github.com/samthomson/weather-station) format):
air gets dirty → purifiers go HIGH; air clears → back to eco.

```
browser (NIP-07 + NIP-98) ──► fastify app ──► @tetherto/mdk-client ──► Kernel ──► bitair worker ──► 3× BitAir (mocks)
White Noise / darkmatter  ──► MLS group  ──► marmot-ts member (the app)      ▲ authz = group members
nostr weather stations    ──► kind 4223   ──► autopilot (hysteresis) ────────┘
```

## Quickstart (native)

```bash
cp .env.example .env           # set ADMIN_NPUB to your npub
cd app && npm install && cd ../worker && npm install && cd ..
(cd app && npx tsx src/index.ts)   # or: docker compose up --build
open http://localhost:8090         # sign in with your Nostr extension (Alby, nos2x…)
```

With `MOCK_COUNT=3` (default) you get three simulated BitAirs. Real devices later:

```
REAL_DEVICES=[{"id":"BA-001","host":"192.168.1.50","port":80},{"id":"BA-002","host":"192.168.1.51","port":80}]
```

No app changes — the Worker's client speaks the same AxeOS-style HTTP API either way
(BitAir firmware is ESP-Miner-derived; endpoints get pinned when Heatbit ships docs).

## Quickstart (docker)

```bash
cp .env.example .env   # ADMIN_NPUB=…
docker compose up --build --detach
open http://localhost:8090
```

## Auth model

1. **Sign in**: NIP-98 (kind 27235 event signed by your NIP-07 extension).
2. **Authorization**, in order: `ADMIN_NPUB` always passes; the admin-managed allowlist
   passes (Members panel in the UI); **current members of the Marmot group pass**.

### Inviting the bot into your group (Marmot)

1. Set `MARMOT_ENABLED=true` (default) and boot. The console + UI show the app's npub.
2. From your Marmot client (White Noise on the Rust MDK, or darkmatter — the marmot-ts
   wire target), create/choose a group and invite that npub like any contact.
3. The app joins from the gift-wrapped Welcome, live-syncs the member list into authz,
   and answers in the encrypted chat:

```
!air status            fleet telemetry for every device
!air on [eco|low|high] all purifiers to a mode (default high)
!air off               all purifiers off
!air fan 80 [BA-002]   fan percent, one device or all
!air mining off [id]   solo miner toggle
!air reboot BA-001     restart one device
```

Invite someone to the group → they can sign into the web app too, no restart.
Remove them → access is gone on the next group state change.

Interop note (measured 2026-11-05): marmot-ts key packages are spec-conformant and
relay-visible, but White Noise (Rust MDK production) rejects them as incompatible:
WN requires MLS extensions 0xf2d2/0xf2d4 + app component 0x800c that marmot-ts's v2
track doesn't implement, and marmot-ts declares v2 proposals (0x1a1a/0xeaea) WN
doesn't know. Same ciphersuite (0x0001), same protocol version — the gap is the
v2 feature set. Until the two tracks converge (or this repo moves the bot onto the
Rust MDK as a sidecar), group-based authz is dormant; admin + allowlist authz work
fully. marmot-ts↔marmot-ts is proven end-to-end (`node tools/marmot-e2e.ts`).

## Autopilot

UI → Automation: pick stations (kind 16158 with a `pm25` sensor tag) from your relays,
set thresholds. Default policy: mean PM2.5 ≥ `AUTOPILOT_ON_UGM3` (35) → every device
`high`; ≤ `AUTOPILOT_OFF_UGM3` (25) → `idleMode` (eco). 15-minute reading staleness
holds state; any manual command pauses the autopilot for 30 minutes.

Demo it without hardware stations:

```bash
cd app
node tools/seed-weather.mjs station 18   # publish a fake station + reading
node tools/seed-weather.mjs pm25 45      # spike → fleet goes HIGH
node tools/seed-weather.mjs pm25 12      # clear → fleet back to eco
```

Relay note: relays are opinionated about kinds — `wss://relay.primal.net` accepts
16158/4223; some (e.g. relay.relaying.earth) block them. `RELAYS` is yours to tune.

## Layout

```
worker/            bitair-mdk-worker: contract, handlers, AxeOS-style client, mock + fault injection
  test/            contract-level tests against the mock (no runtime needed)
app/
  src/mdk.ts       kernel + worker + mocks + client, one process (private loopback DHT)
  src/server.ts    fastify /api + SPA
  src/auth.ts      NIP-98 verification + sessions
  src/authz.ts     admin ∨ allowlist ∨ marmot members
  src/marmot.ts    marmot-ts member: invites, chat commands, member sync
  src/autopilot.ts kind 4223 subscriptions, hysteresis, actuation
  src/schedule.ts  weekly per-device windows
  tools/           smoke, marmot-e2e, autopilot-e2e, seed-weather, mdk-probe, test-signer
ui/                React SPA (NIP-07 login mirrors MKStack's LoginArea pattern)
```

## Verification (what has actually been run)

- `worker/`: `npm test` — 5/5 (contract validates strict; telemetry; commands; ERR_ passthrough; offline)
- `app/`: `tsc --noEmit` clean; `tools/smoke.mjs` — login, 3 devices, power/fan/mining
  commands verified through telemetry read-back, foreign key 403, no token 401, bad mode 400
- `app/tools/marmot-e2e.ts` — group create → invite → join → E2EE `!air on high` round trip
- `app/tools/autopilot-e2e.mjs` — nostr PM2.5 45 → fleet HIGH; 12 → eco (live relays)
- Browser-driven: NIP-07 sign-in → dashboard → mode click → telemetry + log update

## Env

See `.env.example`. Key ones: `ADMIN_NPUB` (required), `PORT`, `RELAYS`,
`MOCK_COUNT`/`MOCK_PORT_BASE` or `REAL_DEVICES`, `AUTOPILOT_ON_UGM3`/`OFF`/`IDLE_MODE`,
`MARMOT_ENABLED`, `DATA_DIR`.
