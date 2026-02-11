import { Account, Contract, RpcProvider } from "starknet";
import { RunnerConfig } from "../config/schema.js";
import { BurnerSession } from "../session/session.js";
import { loadGameAbi } from "./abi.js";

export type ChainGameState = {
  adventurer: any;
  bag: any;
  beast: any;
  market: any;
};

export class ChainClient {
  private readProvider: RpcProvider;
  private writeProvider: RpcProvider;
  private account: Account;
  private readContract: Contract;
  private writeContract: Contract;

  private constructor(
    readProvider: RpcProvider,
    writeProvider: RpcProvider,
    account: Account,
    readContract: Contract,
    writeContract: Contract
  ) {
    this.readProvider = readProvider;
    this.writeProvider = writeProvider;
    this.account = account;
    this.readContract = readContract;
    this.writeContract = writeContract;
  }

  static async init(config: RunnerConfig, session: BurnerSession) {
    const abi = await loadGameAbi(config);
    const readProvider = new RpcProvider({ nodeUrl: config.chain.rpcReadUrl });
    const writeProvider = new RpcProvider({ nodeUrl: config.chain.rpcWriteUrl });
    const account = new Account({
      provider: writeProvider,
      address: session.address,
      signer: session.privateKey
    });

    const readContract = new Contract({
      abi,
      address: config.chain.gameContract,
      providerOrAccount: readProvider
    });

    const writeContract = new Contract({
      abi,
      address: config.chain.gameContract,
      providerOrAccount: account
    });

    return new ChainClient(readProvider, writeProvider, account, readContract, writeContract);
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
}
