/**
 * normalizeCharacter —— 角色归一化
 *
 * 输入：Parser 产出的 ParsedCharacter（半归一化对象）
 * 输出：Character（统一角色结构）
 */

import type { Character, CharacterStatus, CharacterMeta } from '../models/character';
import type { ParsedCharacter } from '../parsers/jsonParser';

let charCounter = 0;

/** 生成唯一角色 ID */
export function generateCharId(): string {
  return `char_${Date.now()}_${++charCounter}`;
}

/** 重置计数器（测试用） */
export function resetCharCounter(): void {
  charCounter = 0;
}

/**
 * 将单个 ParsedCharacter 归一化为 Character
 */
export function normalizeCharacter(raw: ParsedCharacter, index = 0): Character {
  const name = String(raw.name || `未命名角色_${index + 1}`);

  const character: Character = {
    id: String(raw.id || generateCharId()),
    name,
    displayName: String(raw.displayName || raw.name || name),
    avatar: String(raw.avatar || ''),
    model: String(raw.model || ''),
    prompt: String(raw.prompt || raw.personality || raw.description || ''),
    description: String(raw.description || ''),
    lorebookRefs: normalizeStringArray(raw.lorebookRefs || raw.lorebook_refs || []),
    status: normalizeStatus(raw),
    isNarrator: Boolean(raw.isNarrator || raw.is_narrator || false),
    meta: normalizeCharacterMeta(raw),
  };

  return character;
}

/**
 * 批量归一化角色
 */
export function normalizeCharacters(raws: ParsedCharacter[]): Character[] {
  return raws.map((r, i) => normalizeCharacter(r, i));
}

// ─── 辅助函数 ─────────────────────────────────────────

function normalizeStatus(raw: ParsedCharacter): CharacterStatus {
  const val = raw.status || raw.enabled;
  if (val === false || val === 'disabled' || val === 'inactive') return 'disabled';
  return 'enabled';
}

function normalizeCharacterMeta(raw: ParsedCharacter): CharacterMeta {
  const meta: CharacterMeta = {};

  if (raw.cardVersion !== undefined) meta.cardVersion = String(raw.cardVersion);
  if (raw.creator !== undefined) meta.creator = String(raw.creator);

  if (raw.tags !== undefined) {
    meta.tags = normalizeStringArray(raw.tags);
  }

  // 保留所有未映射的原始字段
  if (raw._raw) {
    Object.assign(meta, raw._raw as Record<string, unknown>);
  }

  // 保留扩展字段
  for (const [key, value] of Object.entries(raw)) {
    if (
      !['id', 'name', 'displayName', 'avatar', 'model', 'prompt',
        'description', 'lorebookRefs', 'status', 'enabled', 'isNarrator',
        'cardVersion', 'creator', 'tags', '_raw', 'personality',
        'lorebook_refs', 'is_narrator', 'firstMessage', 'scenario',
        'mesExample'].includes(key)
    ) {
      meta[key] = value;
    }
  }

  return meta;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}
