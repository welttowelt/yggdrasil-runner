import { Account, Contract, RpcProvider } from "starknet";
import { RunnerConfig } from "../config/schema.js";
import { BurnerSession } from "../session/session.js";
import { loadGameAbi, loadLootAbi } from "./abi.js";

export type ChainGameState = {
  adventurer: any;
  bag: any;
  beast: any;
  market: any;
};

export type LootMeta = {
  id: number;
  tier: number;
  slot: string;
  itemType: string;
};

function enumKey(value: any): string {
  if (!value) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > 0) return keys[0]!;
  }
  return "None";
}

export class ChainClient {
  private readProvider: RpcProvider;
  private writeProvider: RpcProvider;
  private account: Account;
  private readContract: Contract;
  private writeContract: Contract;
  private lootContract: Contract | null;
  private lootCache = new Map<number, LootMeta>();

  private constructor(
    readProvider: RpcProvider,
    writeProvider: RpcProvider,
    account: Account,
    readContract: Contract,
    writeContract: Contract,
    lootContract: Contract | null
  ) {
    this.readProvider = readProvider;
    this.writeProvider = writeProvider;
    this.account = account;
    this.readContract = readContract;
    this.writeContract = writeContract;
    this.lootContract = lootContract;
  }

  static async init(config: RunnerConfig, session: BurnerSession) {
    const gameAbi = await loadGameAbi(config);
    const readProvider = new RpcProvider({ nodeUrl: config.chain.rpcReadUrl });
    const writeProvider = new RpcProvider({ nodeUrl: config.chain.rpcWriteUrl });
    const account = new Account({
      provider: writeProvider,
      address: session.address,
      signer: session.privateKey
    });

    const readContract = new Contract({
      abi: gameAbi,
      address: config.chain.gameContract,
      providerOrAccount: readProvider
    });

    const writeContract = new Contract({
      abi: gameAbi,
      address: config.chain.gameContract,
      providerOrAccount: account
    });

    let lootContract: Contract | null = null;
    if (config.chain.lootContract) {
      try {
        const lootAbi = await loadLootAbi(config);
        lootContract = new Contract({
          abi: lootAbi,
          address: config.chain.lootContract,
          providerOrAccount: readProvider
        });
      } catch {
        lootContract = null;
      }
    }

    return new ChainClient(readProvider, writeProvider, account, readContract, writeContract, lootContract);
  }

  async getGameState(adventurerId: number): Promise<ChainGameState> {
    const result = await this.readContract.call("get_game_state", [adventurerId]);
    return result as ChainGameState;
  }

  async startGame(adventurerId: number, weaponId: number) {
    return this.writeContract.invoke("start_game", [adventurerId, weaponId]);
  }

  async explore(adventurerId: number, tillBeast: boolean) {
    return this.writeContract.invoke("explore", [adventurerId, tillBeast]);
  }

  async attack(adventurerId: number, toTheDeath: boolean) {
    return this.writeContract.invoke("attack", [adventurerId, toTheDeath]);
  }

  async flee(adventurerId: number, toTheDeath: boolean) {
    return this.writeContract.invoke("flee", [adventurerId, toTheDeath]);
  }

  async buyItems(adventurerId: number, potions: number, items: Array<{ item_id: number; equip: boolean }>) {
    return this.writeContract.invoke("buy_items", [adventurerId, potions, items]);
  }

  async equip(adventurerId: number, items: number[]) {
    return this.writeContract.invoke("equip", [adventurerId, items]);
  }

  async drop(adventurerId: number, items: number[]) {
    return this.writeContract.invoke("drop", [adventurerId, items]);
  }

  async selectStatUpgrades(adventurerId: number, stats: Record<string, number>) {
    return this.writeContract.invoke("select_stat_upgrades", [adventurerId, stats]);
  }

  async waitForTx(txHash: string, retries = 80, retryInterval = 1500) {
    return this.readProvider.waitForTransaction(txHash, { retries, retryInterval });
  }

  async getLootMeta(itemId: number): Promise<LootMeta | null> {
    if (!this.lootContract) return null;
    if (!itemId) return null;
    const cached = this.lootCache.get(itemId);
    if (cached) return cached;
    const result = (await this.lootContract.call("get_item", [itemId])) as any;
    const meta: LootMeta = {
      id: Number(result?.id ?? itemId),
      tier: {
        None: 0,
        T1: 1,
        T2: 2,
        T3: 3,
        T4: 4,
        T5: 5
      }[enumKey(result?.tier)] ?? 0,
      slot: enumKey(result?.slot).toLowerCase(),
      itemType: enumKey(result?.item_type).toLowerCase()
    };
    this.lootCache.set(itemId, meta);
    return meta;
  }

  async getLootMetaBatch(itemIds: number[]): Promise<Record<number, LootMeta>> {
    const unique = Array.from(new Set(itemIds.filter((id) => id > 0)));
    const results = await Promise.all(unique.map((id) => this.getLootMeta(id)));
    const map: Record<number, LootMeta> = {};
    for (const meta of results) {
      if (meta) map[meta.id] = meta;
    }
    return map;
  }
}
