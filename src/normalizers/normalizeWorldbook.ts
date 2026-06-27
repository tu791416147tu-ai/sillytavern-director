/**
 * normalizeWorldbook —— 世界书条目归一化
 *
 * 输入：Parser 产出的 ParsedWorldBookEntry（半归一化对象）
 * 输出：WorldBookEntry（统一世界书条目结构）
 */

import type { WorldBookEntry, TriggerType, WorldBookTarget } from '../models/worldbook';
import type { ParsedWorldBookEntry } from '../parsers/jsonParser';

let wbCounter = 0;

export function generateWBId(): string {
  return `wb_${Date.now()}_${++wbCounter}`;
}

export function resetWBCounter(): void {
  wbCounter = 0;
}

/**
 * 将单条 ParsedWorldBookEntry 归一化为 WorldBookEntry
 */
export function normalizeWorldBookEntry(raw: ParsedWorldBookEntry, index = 0): WorldBookEntry {
  const entry: WorldBookEntry = {
    id: String(raw.id || raw.uid || generateWBId()),
    title: String(raw.title || raw.comment || `条目_${index + 1}`),
    keys: normalizeKeys(raw.keys),
    content: String(raw.content || ''),
    depth: normalizeDepth(raw),
    triggerType: normalizeTriggerType(raw),
    priority: Number(raw.priority ?? raw.order ?? raw.weight ?? 10),
    enabled: normalizeEnabled(raw),
    target: normalizeTarget(raw),
    characterId: raw.characterId ? String(raw.characterId) : undefined,
    selective: Boolean(raw.selective ?? false),
    secondaryKeys: normalizeKeys(raw.secondaryKeys),
    constant: Boolean(raw.constant ?? false),
    position: normalizePosition(raw),
    scanDepth: Number(raw.scanDepth ?? raw.scan_depth ?? 2),
    meta: (raw._raw as Record<string, unknown>) || {},
  };

  return entry;
}

/**
 * 批量归一化世界书
 */
export function normalizeWorldBookEntries(raws: ParsedWorldBookEntry[]): WorldBookEntry[] {
  return raws.map((r, i) => normalizeWorldBookEntry(r, i));
}

// ─── 辅助函数 ─────────────────────────────────────────

function normalizeKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(k => k.trim()).filter(Boolean);
  return [];
}

function normalizeDepth(raw: ParsedWorldBookEntry): number {
  const d = raw.depth ?? raw.order ?? raw.insertionDepth ?? 0;
  return Number(d) || 0;
}

function normalizeTriggerType(raw: ParsedWorldBookEntry): TriggerType {
  const t = String(raw.triggerType || raw.type || '').toLowerCase();
  if (t === 'manual') return 'manual';
  if (t === 'director') return 'director';
  // 默认是关键词触发
  if (raw.keys && (Array.isArray(raw.keys) ? raw.keys.length > 0 : true)) {
    return 'keyword';
  }
  return 'keyword';
}

function normalizeEnabled(raw: ParsedWorldBookEntry): boolean {
  if (raw.enabled !== undefined) return Boolean(raw.enabled);
  if (raw.active !== undefined) return Boolean(raw.active);
  if (raw.disable !== undefined) return !Boolean(raw.disable);
  return true; // 默认启用
}

function normalizeTarget(raw: ParsedWorldBookEntry): WorldBookTarget {
  const t = String(raw.target || raw.scope || '').toLowerCase();
  if (t === 'character' || t === 'char') return 'character';
  if (t === 'session' || t === 'chat') return 'session';
  return 'global';
}

function normalizePosition(raw: ParsedWorldBookEntry): 'before_char' | 'after_char' | 'in_chat' {
  const p = String(raw.position || raw.insertPosition || '').toLowerCase();
  if (p === 'before_char' || p === 'before') return 'before_char';
  if (p === 'in_chat' || p === 'chat' || p === 'in-chat') return 'in_chat';
  return 'after_char';
}
