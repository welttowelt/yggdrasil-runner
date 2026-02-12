# Loot Survivor 2 Runner (Mainnet + Practice)

Autonomous, survival-first Loot Survivor 2 runner with chain-driven decisions, safety guards, and milestone logging.
Supports Practice and Mainnet (via Cartridge Controller).

## What This Does
- Bootstraps a session, grabs the burner account + adventurer id, then runs fully autonomous onchain actions.
- Reads live game state directly from the Loot Survivor game contract.
- Makes survival-first decisions (fight/flee, stat upgrades, potions, basic equip).
- Executes actions safely and refuses wallet bypass / approval flows.
- Recovers from UI stalls by re-bootstrapping the Practice session.
- Logs milestones and failures to JSONL files.

## Setup
1. Install dependencies:
   ```bash
   npm install
   npx playwright install
   ```
2. Update `config/default.json` with the real game URL if needed.
3. Run:
   ```bash
   npm run start
   ```

### Mainnet Auth (Recommended)
Provide secrets via environment variables (so they don't live in git-tracked config):
```bash
LS2_USERNAME='Hugobiss' \
LS2_PASSWORD='***' \
LS2_CONTROLLER_ADDRESS='0x...' \
npm run start
```

Alternatively, create `config/local.json` (gitignored) and run:
```bash
RUNNER_CONFIG=config/local.json npm run start
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
- `policy`: survival thresholds, stat priorities, starting weapon, HP formula.
- `safety`: wallet/tx UI blocklist strings and Practice mode enforcement.
- `recovery`: timeouts and reload thresholds.

## Safety Boundaries
- If a wallet prompt, transaction approval, or non‑Practice mode UI is detected, the runner stops acting and logs the blocker.
- It will never click wallet approval dialogs or attempt to bypass them.
- Session data is stored in `data/session.json` and includes the burner key; keep it private.

## Logs
- `data/events.jsonl` for operational logs.
- `data/milestones.jsonl` for level‑ups and target milestones.

## Known Gaps
- Gear scoring is basic (auto-equip bag items, no fine-grained item valuation yet).
- Potion strategy is conservative; tune thresholds in `policy`.

## Next Steps
- Add notifications (Discord/Slack) for death/reload/milestones.
- Expand item valuation to make smarter market decisions.
