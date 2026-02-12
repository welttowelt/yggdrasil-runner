import { z } from "zod";

const SelectorMapSchema = z.record(z.string(), z.string());

export const ConfigSchema = z.object({
  app: z.object({
    url: z.string().min(1),
    headless: z.boolean().default(false),
    slowMoMs: z.number().int().nonnegative().default(0),
    timeoutMs: z.number().int().positive().default(15000),
    navigationTimeoutMs: z.number().int().positive().default(30000),
    dataDir: z.string().default("./data"),
    screenshotOnError: z.boolean().default(true)
  }),
  state: z.object({
    extractor: z.object({
      type: z.enum(["window", "dom"]).default("window"),
      script: z.string().optional()
    }),
    dom: z.object({
      level: z.string().optional(),
      hp: z.string().optional(),
      maxHp: z.string().optional(),
      gold: z.string().optional(),
      location: z.string().optional(),
      enemyName: z.string().optional(),
      enemyLevel: z.string().optional(),
      enemyHp: z.string().optional(),
      enemyMaxHp: z.string().optional()
    }).default({})
  }),
  selectors: SelectorMapSchema,
  policy: z.object({
    targetLevel: z.number().int().positive().default(50),
    minHpToExplorePct: z.number().min(0).max(1).default(0.6),
    minHpToFightPct: z.number().min(0).max(1).default(0.55),
    fleeBelowHpPct: z.number().min(0).max(1).default(0.35),
    usePotionBelowHpPct: z.number().min(0).max(1).default(0.45),
    buyPotionIfBelowPct: z.number().min(0).max(1).default(0.7),
    maxPotions: z.number().int().nonnegative().default(6),
    hpBase: z.number().int().positive().default(100),
    hpPerVitality: z.number().int().positive().default(15),
    exploreTillBeastPct: z.number().min(0).max(1).default(0.85),
    minFleeChance: z.number().min(0).max(1).default(0.75),
    maxBeastLevelRatio: z.number().min(0.5).max(5).default(1.6),
    equipUpgradeThreshold: z.number().min(0).max(1).default(0.12),
    itemXpDivisor: z.number().int().positive().default(10),
    dexTargetRatio: z.number().min(0).max(2).default(1),
    vitTargetRatio: z.number().min(0).max(2).default(0.7),
    strTargetRatio: z.number().min(0).max(2).default(0.6),
    intTargetRatio: z.number().min(0).max(2).default(0.5),
    wisTargetRatio: z.number().min(0).max(2).default(0.4),
    statUpgradePriority: z.array(z.enum(["vitality", "strength", "dexterity", "intelligence", "wisdom", "charisma", "luck"])).default(["vitality", "strength", "dexterity"]),
    startingWeaponId: z.number().int().nonnegative().default(1)
  }),
  chain: z.object({
    rpcReadUrl: z.string().default("https://api.cartridge.gg/x/starknet/mainnet/rpc/v0_9"),
    rpcWriteUrl: z.string().default("https://api.cartridge.gg/x/starknet/mainnet/rpc/v0_9"),
    gameContract: z.string().default("0x6f7c4350d6d5ee926b3ac4fa0c9c351055456e75c92227468d84232fc493a9c"),
    abiCacheFile: z.string().default("./data/game_abi.json"),
    lootContract: z.string().default("0x4c386505ce1cc0be91e7ae8727c9feec66692a92c851b01e7f764ea0143dbe4"),
    lootAbiCacheFile: z.string().default("./data/loot_abi.json"),
    accountClassHash: z.string().default("0x743c83c41ce99ad470aa308823f417b2141e02e04571f5c0004e743556e7faf"),
    accountCairoVersion: z.enum(["0", "1"]).default("1"),
    autoDeployAccount: z.boolean().default(false),
    txWaitRetries: z.number().int().positive().default(80),
    txWaitIntervalMs: z.number().int().positive().default(1500),
    txTimeoutMs: z.number().int().positive().default(120000)
  }),
  session: z.object({
    file: z.string().default("./data/session.json"),
    reuse: z.boolean().default(true),
    usernamePrefix: z.string().default("runner"),
    username: z.string().default(""),
    password: z.string().default(""),
    autoLogin: z.boolean().default(true),
    autoBuyGame: z.boolean().default(false),
    resumeLastAdventurer: z.boolean().default(false),
    controllerAddress: z.string().default(""),
    useControllerAddress: z.boolean().default(true)
  }),
  safety: z.object({
    blockIfNotPractice: z.boolean().default(true),
    practiceText: z.string().default("Practice"),
    walletText: z.array(z.string()).default(["Connect Wallet", "Approve", "Signature", "Transaction"]),
    blockOnWalletUI: z.boolean().default(true),
    blockOnPendingTx: z.boolean().default(true),
    pendingTxText: z.array(z.string()).default(["Pending", "Confirm", "Wallet", "Approve"])
  }),
  recovery: z.object({
    staleStateMs: z.number().int().positive().default(15000),
    actionTimeoutMs: z.number().int().positive().default(10000),
    uiFreezeMs: z.number().int().positive().default(20000),
    vrfStuckMs: z.number().int().positive().default(10 * 60 * 1000),
    vrfAbandonCooldownMs: z.number().int().positive().default(30 * 60 * 1000),
    maxReloadsPerHour: z.number().int().positive().default(10),
    reloadCooldownMs: z.number().int().positive().default(30000),
    maxConsecutiveFailures: z.number().int().positive().default(5),
    deathCooldownMs: z.number().int().positive().default(5000)
  }),
  logging: z.object({
    eventsFile: z.string().default("./data/events.jsonl"),
    milestonesFile: z.string().default("./data/milestones.jsonl")
  })
});

export type RunnerConfig = z.infer<typeof ConfigSchema>;
