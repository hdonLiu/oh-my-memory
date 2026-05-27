export function tokenize(text: string): string[] {
  return Array.from(new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)));
}

export function jaccard(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  const union = new Set([...left, ...right]);
  const intersection = left.filter((token) => right.includes(token));
  return union.size === 0 ? 0 : intersection.length / union.size;
}

export function isNoise(content: string): boolean {
  const trimmed = content.trim();
  return ["你好", "谢谢", "好的", "ok", "OK"].includes(trimmed) || trimmed.length < 4;
}
