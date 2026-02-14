import { Account, Contract, EDataAvailabilityMode, ETransactionVersion, RpcProvider, ec, hash } from "starknet";
import { RunnerConfig } from "../config/schema.js";
import { RunnerSession } from "../session/session.js";
import { sleep } from "../utils/time.js";
import { loadGameAbi, loadLootAbi } from "./abi.js";
import { buildRequestRandomCall } from "./vrf.js";

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
    // starknet.js v9 returns Cairo enums as CairoCustomEnum { variant: { X: {}, ... } }
    // where the active variant has a non-undefined payload (often `{}` for unit variants).
    const variant = (value as any).variant;
    if (variant && typeof variant === "object") {
      for (const [key, payload] of Object.entries(variant)) {
        if (payload !== undefined) return key;
      }
    }
    const activeVariant = (value as any).activeVariant;
    if (typeof activeVariant === "string" && activeVariant.trim().length > 0) {
      return activeVariant;
    }
    const keys = Object.keys(value);
    if (keys.length > 0) return keys[0]!;
  }
  return "None";
}

export class ChainClient {
  private readProvider: RpcProvider;
  private writeProvider: RpcProvider | null;
  private account: Account | null;
  private accountPublicKey: string | null;
  private accountClassHash: string | null;
  private readContract: Contract;
  private writeContract: Contract | null;
  private lootContract: Contract | null;
  private lootCache = new Map<number, LootMeta>();
  private preflightAccount: Account | null = null;
  private readonly fallbackResourceBounds: any = {
    l1_gas: { max_amount: 0x6000n, max_price_per_unit: 0n },
    l2_gas: { max_amount: 0x200000n, max_price_per_unit: 0n },
    l1_data_gas: { max_amount: 0x1000n, max_price_per_unit: 0n }
  };

  private constructor(
    readProvider: RpcProvider,
    writeProvider: RpcProvider | null,
    account: Account | null,
    accountPublicKey: string | null,
    accountClassHash: string | null,
    readContract: Contract,
    writeContract: Contract | null,
    lootContract: Contract | null
  ) {
    this.readProvider = readProvider;
    this.writeProvider = writeProvider;
    this.account = account;
    this.accountPublicKey = accountPublicKey;
    this.accountClassHash = accountClassHash;
    this.readContract = readContract;
    this.writeContract = writeContract;
    this.lootContract = lootContract;
  }

  static async init(config: RunnerConfig, session: RunnerSession, opts: { readOnly?: boolean } = {}) {
    const gameAbi = await loadGameAbi(config);
    const wantsMainnet = config.chain.rpcWriteUrl.includes("/mainnet/");
    const readUrl = wantsMainnet ? config.chain.rpcReadUrl : session.rpcUrl || config.chain.rpcReadUrl;
    const writeUrl = wantsMainnet ? config.chain.rpcWriteUrl : session.rpcUrl || config.chain.rpcWriteUrl;
    const gameContract = wantsMainnet ? config.chain.gameContract : session.gameContract || config.chain.gameContract;
    const readProvider = new RpcProvider({ nodeUrl: readUrl });
    const readOnly = !!opts.readOnly;
    let writeProvider: RpcProvider | null = null;
    let accountPublicKey: string | null = null;
    let account: Account | null = null;
    if (!readOnly) {
      if (!session.privateKey) {
        throw new Error("Session is missing privateKey (required for direct chain writes)");
      }
      writeProvider = new RpcProvider({ nodeUrl: writeUrl });
      accountPublicKey = ec.starkCurve.getStarkKey(session.privateKey);
      account = new Account({
        provider: writeProvider,
        address: session.address,
        signer: session.privateKey,
        cairoVersion: config.chain.accountCairoVersion === "0" ? "0" : "1"
      });
    }

    const readContract = new Contract({
      abi: gameAbi,
      address: gameContract,
      providerOrAccount: readProvider
    });

    const writeContract = account
      ? new Contract({
          abi: gameAbi,
          address: gameContract,
          providerOrAccount: account
        })
      : null;

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

    return new ChainClient(
      readProvider,
      writeProvider,
      account,
      accountPublicKey,
      config.chain.accountClassHash || null,
      readContract,
      writeContract,
      lootContract
    );
  }

  async getGameState(adventurerId: number): Promise<ChainGameState> {
    // Read RPC can be flaky; retry transient network failures.
    const maxAttempts = 3;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.readContract.call("get_game_state", [adventurerId]);
        return result as ChainGameState;
      } catch (error) {
        lastError = error;
        const text = this.stringifyError(error).toLowerCase();
        const transient =
          text.includes("fetch failed") ||
          text.includes("econnreset") ||
          text.includes("etimedout") ||
          text.includes("socket hang up") ||
          text.includes("network error");
        if (!transient || attempt >= maxAttempts) {
          throw error;
        }
        await sleep(200 * attempt);
      }
    }
    throw lastError ?? new Error("getGameState failed");
  }

  private stringifyError(error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    let json = "";
    try {
      json = JSON.stringify(error);
    } catch {
      json = "";
    }
    return `${msg} ${json}`.trim();
  }

  async preflightGameAction(method: string, args: any[], senderAddress: string): Promise<{ ok: true } | { ok: false; errorText: string }> {
    // Use a deterministic dummy signer. Fee estimation runs with SKIP_VALIDATE so signature is ignored.
    const dummyPrivateKey = "0x1";
    if (!this.preflightAccount || this.preflightAccount.address.toLowerCase() !== senderAddress.toLowerCase()) {
      this.preflightAccount = new Account({
        provider: this.readProvider,
        address: senderAddress,
        signer: dummyPrivateKey,
        cairoVersion: "1"
      });
    }

    const call = this.readContract.populate(method, args);
    let nonce: string | undefined;
    try {
      nonce = await this.preflightAccount.getNonce();
    } catch {
      nonce = undefined;
    }

    try {
      await this.preflightAccount.estimateInvokeFee(call as any, {
        version: ETransactionVersion.V3,
        ...(nonce != null ? { nonce } : {})
      } as any);
      return { ok: true };
    } catch (error) {
      return { ok: false, errorText: this.stringifyError(error) };
    }
  }

  private async invokeGame(method: string, args: any[], opts: { vrfSalt?: string | null } = {}) {
    if (!this.account || !this.writeContract || !this.writeProvider) {
      throw new Error("ChainClient is read-only; cannot invoke game write methods");
    }
    const call = this.writeContract.populate(method, args);
    const calls = [];
    if (opts.vrfSalt) {
      calls.push(buildRequestRandomCall(this.readContract.address, opts.vrfSalt));
    }
    calls.push(call);
    // Mainnet RPC v0_8+ requires v3 transactions with non-zero resource bounds.
    const nonce = await this.account.getNonce();
    const scale = (value: bigint) => (value * 13n) / 10n;
    const baseL1PriceDefault = 50_000_000_000_000n;
    const baseL2PriceDefault = 50_000_000_000_000n;
    const baseL1DataPriceDefault = 100_000_000_000n;
    const gasPrices = await this.writeProvider.getGasPrices("latest").catch(() => null);
    const baseL1Price = scale(gasPrices?.l1GasPrice ?? baseL1PriceDefault);
    const baseL2Price = scale(gasPrices?.l2GasPrice ?? baseL2PriceDefault);
    const baseL1DataPrice = scale(gasPrices?.l1DataGasPrice ?? baseL1DataPriceDefault);
    const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
    let resourceBounds = {
      l1_gas: {
        max_amount: BigInt(this.fallbackResourceBounds.l1_gas.max_amount),
        max_price_per_unit: baseL1Price
      },
      l2_gas: {
        max_amount: BigInt(this.fallbackResourceBounds.l2_gas.max_amount),
        max_price_per_unit: baseL2Price
      },
      l1_data_gas: {
        max_amount: BigInt(this.fallbackResourceBounds.l1_data_gas.max_amount),
        max_price_per_unit: baseL1DataPrice
      }
    };

    try {
      const estimate = await this.account.estimateInvokeFee(calls as any, {
        version: ETransactionVersion.V3,
        nonce
      });
      const estimatedBounds = (estimate as any)?.resourceBounds;
      if (estimatedBounds?.l1_gas && estimatedBounds?.l2_gas && estimatedBounds?.l1_data_gas) {
        resourceBounds = {
          l1_gas: {
            max_amount: maxBig(
              scale(BigInt(estimatedBounds.l1_gas.max_amount)),
              BigInt(this.fallbackResourceBounds.l1_gas.max_amount)
            ),
            max_price_per_unit: maxBig(
              scale(BigInt(estimatedBounds.l1_gas.max_price_per_unit)),
              baseL1Price
            )
          },
          l2_gas: {
            max_amount: maxBig(
              scale(BigInt(estimatedBounds.l2_gas.max_amount)),
              BigInt(this.fallbackResourceBounds.l2_gas.max_amount)
            ),
            max_price_per_unit: maxBig(
              scale(BigInt(estimatedBounds.l2_gas.max_price_per_unit)),
              baseL2Price
            )
          },
          l1_data_gas: {
            max_amount: maxBig(
              scale(BigInt(estimatedBounds.l1_data_gas.max_amount)),
              BigInt(this.fallbackResourceBounds.l1_data_gas.max_amount)
            ),
            max_price_per_unit: maxBig(
              scale(BigInt(estimatedBounds.l1_data_gas.max_price_per_unit)),
              baseL1DataPrice
            )
          }
        };
      }
    } catch {
      // fallback bounds are used when fee estimation fails
    }

    return this.account.execute(calls as any, {
      nonce,
      version: ETransactionVersion.V3,
      resourceBounds,
      tip: 0,
      paymasterData: [],
      accountDeploymentData: [],
      nonceDataAvailabilityMode: EDataAvailabilityMode.L1,
      feeDataAvailabilityMode: EDataAvailabilityMode.L1
    });
  }

  async startGame(adventurerId: number, weaponId: number, vrfSalt?: string | null) {
    return this.invokeGame("start_game", [adventurerId, weaponId], { vrfSalt: vrfSalt ?? null });
  }

  async explore(adventurerId: number, tillBeast: boolean, vrfSalt?: string | null) {
    return this.invokeGame("explore", [adventurerId, tillBeast], { vrfSalt: vrfSalt ?? null });
  }

  async attack(adventurerId: number, toTheDeath: boolean, vrfSalt?: string | null) {
    return this.invokeGame("attack", [adventurerId, toTheDeath], { vrfSalt: vrfSalt ?? null });
  }

  async flee(adventurerId: number, toTheDeath: boolean, vrfSalt?: string | null) {
    return this.invokeGame("flee", [adventurerId, toTheDeath], { vrfSalt: vrfSalt ?? null });
  }

  async buyItems(adventurerId: number, potions: number, items: Array<{ item_id: number; equip: boolean }>) {
    return this.invokeGame("buy_items", [adventurerId, potions, items]);
  }

  async equip(adventurerId: number, items: number[], vrfSalt?: string | null) {
    return this.invokeGame("equip", [adventurerId, items], { vrfSalt: vrfSalt ?? null });
  }

  async drop(adventurerId: number, items: number[]) {
    return this.invokeGame("drop", [adventurerId, items]);
  }

  async selectStatUpgrades(adventurerId: number, stats: Record<string, number>) {
    return this.invokeGame("select_stat_upgrades", [adventurerId, stats]);
  }

  async waitForTx(txHash: string, retries = 80, retryInterval = 1500) {
    return this.readProvider.waitForTransaction(txHash, { retries, retryInterval });
  }

  async ensureAccountDeployed(): Promise<{ deployed: boolean; transactionHash?: string }> {
    if (!this.account || !this.accountClassHash || !this.accountPublicKey) {
      return { deployed: true };
    }
    if (!this.accountClassHash) return { deployed: true };
    try {
      await this.readProvider.getClassAt(this.account.address);
      return { deployed: true };
    } catch {
      // fall through to deploy
    }

    const publicKey = this.accountPublicKey;
    const classHash = this.accountClassHash;
    const computed = hash.calculateContractAddressFromHash(publicKey, classHash, [publicKey], 0);
    if (BigInt(computed) !== BigInt(this.account.address)) {
      throw new Error(`Account address mismatch. Expected ${this.account.address}, computed ${computed}`);
    }

    const deployment = await this.account.deployAccount({
      classHash,
      constructorCalldata: [publicKey],
      addressSalt: publicKey,
      contractAddress: this.account.address
    });

    return { deployed: false, transactionHash: deployment.transaction_hash };
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
