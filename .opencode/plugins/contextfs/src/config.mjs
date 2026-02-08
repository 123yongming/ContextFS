export const DEFAULT_CONFIG = {
  enabled: true,
  autoInject: true,
  autoCompact: true,
  contextfsDir: ".contextfs",
  recentTurns: 6,
  tokenThreshold: 8000,
  pinsMaxItems: 20,
  summaryMaxChars: 3200,
  manifestMaxLines: 20,
  pinScanMaxChars: 4000,
  packDelimiterStart: "<<<CONTEXTFS:BEGIN>>>",
  packDelimiterEnd: "<<<CONTEXTFS:END>>>",
};

export function mergeConfig(userConfig = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
  };
}
