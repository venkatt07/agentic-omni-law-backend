export type AgentGenerationProfile = {
  temperature: number;
  topP: number;
  maxTokens: number;
  timeoutMs: number;
  repairMaxTokens: number;
  repairTimeoutMs: number;
  queryChars: number;
  compactQueryChars: number;
  contextCharBudget: number;
  compactContextCharBudget: number;
  maxChunks: number;
  compactMaxChunks: number;
  perChunkChars: number;
  compactPerChunkChars: number;
  priorOutputsChars: number;
};

const COMMON_PROFILES: Record<string, AgentGenerationProfile> = {
  query_parsing: {
    temperature: 0.06,
    topP: 0.88,
    maxTokens: 360,
    timeoutMs: 16_000,
    repairMaxTokens: 260,
    repairTimeoutMs: 9_000,
    queryChars: 2600,
    compactQueryChars: 900,
    contextCharBudget: 4200,
    compactContextCharBudget: 1300,
    maxChunks: 9,
    compactMaxChunks: 4,
    perChunkChars: 310,
    compactPerChunkChars: 160,
    priorOutputsChars: 900,
  },
  terms_and_policies: {
    temperature: 0.06,
    topP: 0.88,
    maxTokens: 420,
    timeoutMs: 28_000,
    repairMaxTokens: 260,
    repairTimeoutMs: 12_000,
    queryChars: 2000,
    compactQueryChars: 700,
    contextCharBudget: 4600,
    compactContextCharBudget: 1600,
    maxChunks: 10,
    compactMaxChunks: 4,
    perChunkChars: 290,
    compactPerChunkChars: 150,
    priorOutputsChars: 1000,
  },
  contract_risk: {
    temperature: 0.05,
    topP: 0.86,
    maxTokens: 520,
    timeoutMs: 40_000,
    repairMaxTokens: 300,
    repairTimeoutMs: 15_000,
    queryChars: 1800,
    compactQueryChars: 600,
    contextCharBudget: 5200,
    compactContextCharBudget: 1800,
    maxChunks: 11,
    compactMaxChunks: 5,
    perChunkChars: 300,
    compactPerChunkChars: 170,
    priorOutputsChars: 1200,
  },
  outcome_projection: {
    temperature: 0.06,
    topP: 0.88,
    maxTokens: 520,
    timeoutMs: 42_000,
    repairMaxTokens: 300,
    repairTimeoutMs: 15_000,
    queryChars: 2200,
    compactQueryChars: 800,
    contextCharBudget: 5200,
    compactContextCharBudget: 1800,
    maxChunks: 11,
    compactMaxChunks: 5,
    perChunkChars: 300,
    compactPerChunkChars: 170,
    priorOutputsChars: 1300,
  },
  policy_compliance: {
    temperature: 0.05,
    topP: 0.86,
    maxTokens: 580,
    timeoutMs: 46_000,
    repairMaxTokens: 340,
    repairTimeoutMs: 17_000,
    queryChars: 2400,
    compactQueryChars: 800,
    contextCharBudget: 5600,
    compactContextCharBudget: 1900,
    maxChunks: 12,
    compactMaxChunks: 5,
    perChunkChars: 300,
    compactPerChunkChars: 170,
    priorOutputsChars: 1400,
  },
  legal_drafts_validation: {
    temperature: 0.06,
    topP: 0.88,
    maxTokens: 620,
    timeoutMs: 36_000,
    repairMaxTokens: 340,
    repairTimeoutMs: 15_000,
    queryChars: 1800,
    compactQueryChars: 700,
    contextCharBudget: 5200,
    compactContextCharBudget: 1700,
    maxChunks: 11,
    compactMaxChunks: 5,
    perChunkChars: 300,
    compactPerChunkChars: 180,
    priorOutputsChars: 1200,
  },
  final_summary: {
    temperature: 0.06,
    topP: 0.88,
    maxTokens: 540,
    timeoutMs: 32_000,
    repairMaxTokens: 300,
    repairTimeoutMs: 15_000,
    queryChars: 2000,
    compactQueryChars: 700,
    contextCharBudget: 5000,
    compactContextCharBudget: 1700,
    maxChunks: 11,
    compactMaxChunks: 5,
    perChunkChars: 290,
    compactPerChunkChars: 160,
    priorOutputsChars: 1500,
  },
  default: {
    temperature: 0.07,
    topP: 0.88,
    maxTokens: 460,
    timeoutMs: 32_000,
    repairMaxTokens: 280,
    repairTimeoutMs: 14_000,
    queryChars: 1800,
    compactQueryChars: 600,
    contextCharBudget: 4800,
    compactContextCharBudget: 1400,
    maxChunks: 11,
    compactMaxChunks: 4,
    perChunkChars: 280,
    compactPerChunkChars: 150,
    priorOutputsChars: 1000,
  },
};

const ROLE_PROFILE: AgentGenerationProfile = {
  temperature: 0.06,
  topP: 0.88,
  maxTokens: 900,
  timeoutMs: 22_000,
  repairMaxTokens: 700,
  repairTimeoutMs: 12_000,
  queryChars: 1600,
  compactQueryChars: 600,
  contextCharBudget: 3400,
  compactContextCharBudget: 1500,
  maxChunks: 6,
  compactMaxChunks: 4,
  perChunkChars: 220,
  compactPerChunkChars: 130,
  priorOutputsChars: 1200,
};

function isRoleModule(moduleKey: string) {
  return /^(lawyer_|student_|corp_|individual_)/.test(String(moduleKey || ""));
}

export function getGenerationProfile(moduleKey: string, tier: "preview" | "final" = "final"): AgentGenerationProfile {
  if (isRoleModule(moduleKey)) {
    return tier === "preview"
      ? { ...ROLE_PROFILE, maxTokens: 650, timeoutMs: 14_000, repairMaxTokens: 520, repairTimeoutMs: 9_000, contextCharBudget: 2200, maxChunks: 4, perChunkChars: 180 }
      : ROLE_PROFILE;
  }
  const base = COMMON_PROFILES[moduleKey] || COMMON_PROFILES.default;
  if (tier === "preview") {
    return {
      ...base,
      maxTokens: Math.min(base.maxTokens, 260),
      timeoutMs: Math.min(base.timeoutMs, 9_000),
      repairMaxTokens: Math.min(base.repairMaxTokens, 190),
      repairTimeoutMs: Math.min(base.repairTimeoutMs, 8_000),
      contextCharBudget: Math.min(base.contextCharBudget, 2100),
      maxChunks: Math.min(base.maxChunks, 6),
      perChunkChars: Math.min(base.perChunkChars, 220),
      priorOutputsChars: Math.min(base.priorOutputsChars, 600),
    };
  }
  return base;
}
