import { hash } from "starknet";

export const CARTRIDGE_VRF_PROVIDER_ADDRESS =
  "0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f";

export type StarknetCall = {
  contractAddress: string;
  entrypoint: string;
  calldata: any[];
};

export function computeExploreSalt(adventurerId: number, xp: number): string {
  return hash.computePoseidonHashOnElements([BigInt(xp), BigInt(adventurerId)]);
}

export function computeBattleSalt(adventurerId: number, xp: number, actionCount: number): string {
  // Must match upstream LS2 client `generateBattleSalt(gameId, xp, actionCount)`:
  // Poseidon([xp, gameId, actionCount + 1]).
  return hash.computePoseidonHashOnElements([BigInt(xp), BigInt(adventurerId), BigInt(actionCount + 1)]);
}

export function buildRequestRandomCall(gameContract: string, salt: string): StarknetCall {
  // Cairo:
  //   request_random(caller: ContractAddress, source: Source)
  // where Source is an enum. `type: 1` selects `Source::Salt`.
  return {
    contractAddress: CARTRIDGE_VRF_PROVIDER_ADDRESS,
    entrypoint: "request_random",
    calldata: [gameContract, 1, salt]
  };
}

