import fs from "node:fs";
import path from "node:path";
import { RunnerConfig } from "../config/schema.js";

async function fetchAbi(rpcUrl: string, contractAddress: string) {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "starknet_getClassAt",
    params: {
      block_id: "latest",
      contract_address: contractAddress
    }
  };

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ABI: ${res.status}`);
  }

  const json = await res.json();
  if (!json?.result?.abi) {
    throw new Error("ABI not found in RPC response");
  }
  return JSON.parse(json.result.abi);
}

export async function loadGameAbi(config: RunnerConfig) {
  const cachePath = path.resolve(process.cwd(), config.chain.abiCacheFile);
  if (fs.existsSync(cachePath)) {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.abi) return parsed.abi;
  }

  const abi = await fetchAbi(config.chain.rpcReadUrl, config.chain.gameContract);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ abi }, null, 2));
  return abi;
}

export async function loadLootAbi(config: RunnerConfig) {
  const cachePath = path.resolve(process.cwd(), config.chain.lootAbiCacheFile);
  if (fs.existsSync(cachePath)) {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.abi) return parsed.abi;
  }

  const abi = await fetchAbi(config.chain.rpcReadUrl, config.chain.lootContract);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ abi }, null, 2));
  return abi;
}
