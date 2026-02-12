# Controller CLI (Cartridge) LLM Rules

This repo treats the Cartridge Controller CLI (`controller`, aka `controller-cli`) as a strict, JSON-only interface for Starknet actions that require a human-authorized session.

If you are an LLM (or writing automation), follow the rules below exactly.

## Non-Negotiables

- Always use machine-readable output: pass `--json` for every `controller` command.
- Always be explicit about network:
  - Use `--chain-id SN_MAIN|SN_SEPOLIA`, or
  - Use `--rpc-url <explicit url>`.
  - Never rely on defaults.
- Registration requires a human in the loop:
  - `controller register` prints an authorization URL and waits for browser approval.
  - Do not attempt to automate/bypass approval.
- Always use Voyager for transaction links:
  - Mainnet: `https://voyager.online/tx/0x...`
  - Sepolia: `https://sepolia.voyager.online/tx/0x...`
  - Never use Starkscan.
- Use least-privilege policies:
  - Only authorize the minimum contracts + entrypoints needed.
  - Never include token transfer permissions unless explicitly requested.

## Recommended Local Wrapper

Prefer running `controller` through the wrapper:

```bash
bash scripts/controller_safe.sh <command> [args...]
```

What it does:
- Appends `--json` if missing.
- Refuses to run networked commands without `--chain-id` or `--rpc-url`.
- Validates output is JSON and pretty-prints it with `jq`.
- If `.status == "error"`, prints `error_code`, `message`, `recovery_hint` and exits non-zero.

## Canonical Workflow

### 1) Generate Keypair

```bash
controller generate --json
```

The private key is stored locally (typically under `~/.config/controller-cli/`).

### 2) Check Session Status

```bash
controller status --json
```

Expected states include:
- `no_session`
- `keypair_only`
- `active` (not expired)

### 3) Register Session (Human Approval Required)

Use a preset when possible:

```bash
controller register --preset loot-survivor --chain-id SN_MAIN --json
```

Or a local policy file (least privilege):

```bash
controller register --file policy.json --rpc-url https://api.cartridge.gg/x/starknet/sepolia --json
```

Authorization flow rules:
- Display `short_url` if present; otherwise display `authorization_url`.
- Ask the user to open it in their browser and approve.
- The command blocks until approved or timeout (typically ~6 minutes).

### 4) Execute Transaction

Single call:

```bash
controller execute <contract> <entrypoint> <comma_separated_calldata> --rpc-url <url> --json
```

Multiple calls from file:

```bash
controller execute --file calls.json --rpc-url <url> --json
```

Optional: `--wait --timeout 300`.

### 5) Read-Only Call

Read-only calls do not require an active session (network is still required):

```bash
controller call <contract> <entrypoint> <calldata> --chain-id SN_SEPOLIA --json
```

### 6) Transaction Status

```bash
controller transaction <tx_hash> --chain-id SN_SEPOLIA --json
```

Optional: `--wait --timeout 300`.

### 7) Username / Address Lookup

```bash
controller lookup --usernames alice,bob --json
controller lookup --addresses 0x123...,0x456... --json
```

## Paymaster

- Default behavior uses the paymaster (free execution).
- If the paymaster is unavailable, the transaction fails (it does not automatically fall back).
- Use `--no-paymaster` only when explicitly opting into user-funded fees.

## Input Validation

- Addresses must be `0x`-prefixed hex.
- Use:

```bash
bash scripts/validate_hex_address.sh 0xabc...
```

## Amount Encoding (u256)

Many Starknet token amounts are `u256` split into low/high u128:

- For values that fit in u128: use `high=0x0`.
- Calldata example: `0xRECIPIENT,0xLOW,0xHIGH`

## Error Handling Contract

Errors are expected to be JSON. When `.status == "error"`:
- Branch on `error_code`
- Follow `recovery_hint` exactly
- Common cases: `NoSession`, `SessionExpired`, `ManualExecutionRequired`, `CallbackTimeout`, `InvalidInput`

