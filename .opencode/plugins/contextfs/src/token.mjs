export function estimateTokens(text) {
  const value = String(text || "");
  return Math.ceil(value.length / 4);
}

export function estimateBlockTokens(blocks) {
  return blocks.reduce((sum, item) => sum + estimateTokens(item), 0);
}
