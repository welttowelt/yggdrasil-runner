import { loadConfig } from "../config/load.js";
import { ChainClient } from "../chain/client.js";
import { deriveState } from "../chain/state.js";
import { loadSession } from "../session/session.js";

function jsonReplacer(_key: string, value: unknown) {
  if (typeof value === "bigint") return value.toString();
  return value;
}

async function main() {
  const config = loadConfig();
  const session = loadSession(config);
  if (!session) {
    throw new Error(`No session found at ${config.session.file}. Run the runner once to create it.`);
  }

  const arg = process.argv[2];
  const adventurerId = arg ? Number(arg) : session.adventurerId;
  if (!Number.isFinite(adventurerId)) {
    throw new Error(`Invalid adventurer id: ${arg}`);
  }

  const client = await ChainClient.init(config, session);
  const raw = await client.getGameState(adventurerId);
  const derived = deriveState(config, adventurerId, raw);

  const advKeys = raw?.adventurer ? Object.keys(raw.adventurer).sort() : [];
  const beastKeys = raw?.beast ? Object.keys(raw.beast).sort() : [];

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        adventurerId,
        adventurerKeys: advKeys,
        beastKeys,
        raw,
        derived
      },
      jsonReplacer,
      2
    )
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});

