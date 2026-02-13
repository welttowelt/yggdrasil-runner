# Loot Survivor 2 Runner (Mainnet + Practice)

Autonomous, survival-first Loot Survivor 2 runner with chain-driven decisions, safety guards, and milestone logging.
Supports Practice and Mainnet (via Cartridge Controller).

## What This Does
- Bootstraps a session and runs fully autonomous onchain actions.
- Reads live game state directly from the Loot Survivor game contract.
- Makes survival-first decisions (fight/flee, stat upgrades, potions, basic equip).
- Executes actions safely and refuses wallet bypass / approval flows.
- Recovers from UI stalls by refreshing/reconnecting and re-bootstrapping when needed.
- Logs milestones and failures to JSONL files.

## Setup
1. Install dependencies:
   ```bash
   npm install
   npx playwright install
   ```
2. Update `config/default.json` with the real game URL if needed.
3. Run a single profile:
   ```bash
   RUNNER_CONFIG=config/hugobiss.json npm run start
   ```

### Mainnet Auth (Recommended)
Provide secrets via environment variables (so they don't live in git-tracked config):
```bash
LS2_USERNAME='Hugobiss' \
LS2_PASSWORD='***' \
LS2_CONTROLLER_ADDRESS='0x...' \
RUNNER_CONFIG=config/hugobiss.json npm run start
```

Alternatively, create `config/local.json` (gitignored). It will be merged into any `config/*.json` profile you run:
```bash
cat > config/local.json <<'JSON'
{
  "session": {
    "password": "YOUR_PASSWORD",
    "autoLogin": true,
    "autoBuyGame": false,
    "resumeLastAdventurer": false
  }
}
JSON
```

Then start:
```bash
RUNNER_CONFIG=config/hugobiss.json npm run start
```

### Run All Profiles + Dashboard
Start the dashboard:
```bash
npm run dashboard
```
Open: `http://localhost:3199`

Start all configured profiles:
```bash
bash scripts/sessions.sh start
```

### Different Profile Sets Per Machine (Recommended)
If you run multiple machines, avoid logging into the same Cartridge usernames from different hosts.

Use a machine-local config dir (gitignored) and point all tools at it:
```bash
mkdir -p config/_local

# Start only profiles in config/_local/*.json
RUNNER_CONFIG_DIR=config/_local npm run dashboard
RUNNER_CONFIG_DIR=config/_local bash scripts/sessions.sh start
RUNNER_CONFIG_DIR=config/_local npm run autofund
```

To generate + fund new machine-local profiles:
```bash
RUNNER_CONFIG_DIR=config/_local NEW_ACCOUNTS=5 FUND_AMOUNT_STRK=300 FUNDER_CONFIG=config/autopsy.json \
npm run provision
```

## Probe Mode (Auto-Discover Selectors/State)
Run this to capture UI structure, Cartridge login iframe details, and network calls:
```bash
npm run probe
```
It writes `data/probe.json` and a screenshot in `data/`.

## Playwright Mainnet Flow Script
Automates the browser-only flow (`BUY GAME` -> login -> accept terms -> `Enter Dungeon` -> `SUBMIT`) and keeps retrying with reload recovery.

Run:
```bash
LS2_USERNAME='your_username' \
LS2_PASSWORD='your_password' \
npm run flow:mainnet
```

Optional:
```bash
RUNNER_HEADLESS=1 RUNNER_SLOWMO_MS=50 FLOW_TIMEOUT_MS=1200000 npm run flow:mainnet
```

## Reliability Analysis Commands
Use the installed custom skills directly from project scripts:
```bash
npm run analyze:starknet
npm run analyze:clickflow
npm run analyze:health
npm run analyze:recovery
```

## Dump Onchain State
```bash
npm run dump:state -- <adventurerId>
```

## Configuration
The runner is fully driven by `config/default.json` or by `RUNNER_CONFIG=/path/to/config.json`.

Key fields:
- `app.url`: Loot Survivor 2 web URL.
- `chain`: RPC endpoints + game contract address.
- `session`: session file + username strategy for Cartridge.
- `session.autoBuyGame`: opt-in; buys a new mainnet game ticket when blocked (rate limited).
- `session.resumeLastAdventurer`: opt-in; keeps using the last known `playUrl`/`adventurerId` from `data/session.json`.
- `policy`: survival thresholds, stat priorities, starting weapon, HP formula.
- `safety`: wallet/tx UI blocklist strings and Practice mode enforcement.
- `recovery`: timeouts and reload thresholds.

## Safety Boundaries
- If a wallet prompt, transaction approval, or non‑Practice mode UI is detected, the runner stops acting and logs the blocker.
- It will never click wallet approval dialogs or attempt to bypass them.
- Practice session data is stored in `data/session.json` and includes the burner key; keep it private.
- Mainnet controller mode stores only the controller address plus the last `playUrl`/`adventurerId` (no private key).

## Logs
- `data/events.jsonl` for operational logs.
- `data/milestones.jsonl` for level‑ups and target milestones.

## Known Gaps
- Gear scoring is basic (auto-equip bag items, no fine-grained item valuation yet).
- Potion strategy is conservative; tune thresholds in `policy`.

## Next Steps
- Add notifications (Discord/Slack) for death/reload/milestones.
- Expand item valuation to make smarter market decisions.
