export function estimateTokens(text) {
  const value = String(text || "");
  if (!value) {
    return 0;
  }
  const asciiChars = (value.match(/[\x00-\x7f]/g) || []).length;
  const nonAsciiChars = value.length - asciiChars;
  return Math.ceil(asciiChars / 4 + nonAsciiChars / 1.6);
}

export function estimateBlockTokens(blocks) {
  return blocks.reduce((sum, item) => sum + estimateTokens(item), 0);
}
