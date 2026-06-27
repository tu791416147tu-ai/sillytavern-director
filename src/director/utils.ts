export function nowId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function normalizeText(input: string): string {
  return (input || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function textContainsAny(text: string, needles: string[]): boolean {
  if (!text || needles.length === 0) return false;
  const hay = normalizeText(text);
  return needles.some((needle) => needle && hay.includes(normalizeText(needle)));
}

export function takeLast<T>(items: T[], limit: number): T[] {
  if (limit <= 0) return [];
  return items.slice(Math.max(0, items.length - limit));
}

export function safeJoin(parts: Array<string | undefined | null>, sep = '\n'): string {
  return parts.filter((x): x is string => Boolean(x && String(x).trim())).join(sep);
}

export function keywordHitScore(text: string, keywords: string[]): number {
  if (!text || !keywords.length) return 0;
  const hay = normalizeText(text);
  let score = 0;
  for (const kw of keywords) {
    const token = normalizeText(kw);
    if (!token) continue;
    if (hay.includes(token)) score += Math.max(1, Math.min(5, token.length / 2));
  }
  return score;
}
