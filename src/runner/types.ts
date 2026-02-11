export type Phase = "unknown" | "menu" | "dungeon" | "combat" | "market" | "town" | "death";

export type GameState = {
  phase: Phase;
  level?: number | null;
  hp?: number | null;
  maxHp?: number | null;
  gold?: number | null;
  location?: string | null;
  enemy?: {
    name?: string | null;
    level?: number | null;
    hp?: number | null;
    maxHp?: number | null;
  } | null;
  inventory?: unknown;
  market?: unknown;
  availableActions: string[];
  flags: {
    pendingTx: boolean;
    walletUi: boolean;
    overlay: boolean;
    practiceMode: boolean | null;
  };
};

export type ActionType =
  | "startPractice"
  | "continue"
  | "explore"
  | "fight"
  | "flee"
  | "drinkPotion"
  | "market"
  | "buyPotion"
  | "closeOverlay"
  | "reload"
  | "wait";

export type Action = {
  type: ActionType;
  reason: string;
  selectorOverride?: string;
};
