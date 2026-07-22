const LOW_INFORMATION_EXACT = new Set([
  "你好",
  "您好",
  "嗨",
  "hi",
  "hello",
  "谢谢",
  "感谢",
  "ok",
  "okay",
  "好的",
  "嗯",
  "嗯嗯"
]);

/**
 * A deliberately narrow, exact-match guard. It is not a semantic classifier and
 * must not grow into a replacement for embedding or LLM decisions.
 */
export function isHighPrecisionLowInformation(text: string): boolean {
  return LOW_INFORMATION_EXACT.has(text.trim().toLocaleLowerCase());
}
