/**
 * JSONParser —— JSON 格式数据解析器
 *
 * 职责：
 *  1. 接收 RawSourceData（来自任意 Loader）
 *  2. 根据字段映射表提取并重命名字段
 *  3. 产出"半归一化"的中间结构，交给 Normalizer 完成最终归一化
 *
 * 核心理念：用 fieldMap 做映射，不硬编码字段名。
 */

import {
  CHARACTER_FIELD_MAP,
  MESSAGE_FIELD_MAP,
  WORLDBOOK_FIELD_MAP,
  GLOBAL_ALIASES,
} from './fieldMap';
import type { RawSourceData, RawCharacter, RawMessage, RawWorldBookEntry } from '../adapters/rawTypes';

// ─── 映射解析工具 ─────────────────────────────────────

/**
 * 根据映射表从原始对象中查找值
 * 优先级：按映射数组顺序，先找到就返回
 */
function resolveField(
  obj: Record<string, unknown>,
  aliases: string[],
  defaultValue: unknown = undefined
): unknown {
  for (const alias of aliases) {
    // 支持点分隔的嵌套路径，如 "data.description"
    const value = getNested(obj, alias);
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return defaultValue;
}

function getNested(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 将整个映射表应用到对象上，产出新对象
 */
function applyFieldMap(
  obj: Record<string, unknown>,
  fieldMap: Record<string, string[]>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [targetKey, aliases] of Object.entries(fieldMap)) {
    result[targetKey] = resolveField(obj, aliases);
  }
  // 保留未映射的原始字段到 meta
  const mappedKeys = new Set(Object.values(fieldMap).flat());
  for (const [key, value] of Object.entries(obj)) {
    if (!mappedKeys.has(key)) {
      if (!result._raw) result._raw = {};
      (result._raw as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

// ─── 解析函数 ─────────────────────────────────────────

export interface ParsedCharacter {
  [key: string]: unknown;
}

export interface ParsedMessage {
  [key: string]: unknown;
}

export interface ParsedWorldBookEntry {
  [key: string]: unknown;
}

export interface ParsedData {
  characters: ParsedCharacter[];
  messages: ParsedMessage[];
  worldBooks: ParsedWorldBookEntry[];
  jailbreak: string;
  jailbreakName: string;
  sessionMeta: Record<string, unknown>;
  /** 原始数据中未被归类的字段 */
  extras: Record<string, unknown>;
}

/**
 * 解析 RawSourceData → 中间结构
 */
export function parseRawData(raw: RawSourceData): ParsedData {
  const result: ParsedData = {
    characters: [],
    messages: [],
    worldBooks: [],
    jailbreak: raw.jailbreak || '',
    jailbreakName: raw.jailbreakName || '',
    sessionMeta: {},
    extras: { ...raw.extras },
  };

  // ── 解析角色 ──────────────────────────────
  for (const rawChar of raw.characters) {
    const parsed = applyFieldMap(rawChar as Record<string, unknown>, CHARACTER_FIELD_MAP);
    result.characters.push(parsed as ParsedCharacter);
  }

  // ── 解析消息 ──────────────────────────────
  for (const rawMsg of raw.messages) {
    const parsed = applyFieldMap(rawMsg as Record<string, unknown>, MESSAGE_FIELD_MAP);

    // 修复：SillyTavern v2 格式的 mes 字段
    if (parsed.content === undefined && rawMsg.mes !== undefined) {
      parsed.content = rawMsg.mes;
    }

    // 修复 role
    if (parsed.role === undefined) {
      if (rawMsg.is_system === true) {
        parsed.role = 'system';
      } else if (rawMsg.is_user === true || rawMsg.role === 'user') {
        parsed.role = 'user';
      } else if (rawMsg.role === 'assistant' || rawMsg.role === 'bot' || rawMsg.role === 'ai') {
        parsed.role = 'assistant';
      } else if (rawMsg.name || rawMsg.speaker) {
        parsed.role = 'character';
      }
    }

    result.messages.push(parsed as ParsedMessage);
  }

  // ── 解析世界书 ────────────────────────────
  for (const rawEntry of raw.worldBooks) {
    const parsed = applyFieldMap(rawEntry as Record<string, unknown>, WORLDBOOK_FIELD_MAP);

    // 特殊处理 keys：可能是逗号分隔的字符串
    if (typeof parsed.keys === 'string') {
      parsed.keys = (parsed.keys as string).split(',').map(k => k.trim()).filter(Boolean);
    }
    if (typeof parsed.secondaryKeys === 'string') {
      parsed.secondaryKeys = (parsed.secondaryKeys as string)
        .split(',')
        .map(k => k.trim())
        .filter(Boolean);
    }

    // 修复 enabled：disable 字段要取反
    if (parsed.enabled === undefined && (rawEntry as Record<string, unknown>).disable !== undefined) {
      parsed.enabled = !(rawEntry as Record<string, unknown>).disable;
    }

    result.worldBooks.push(parsed as ParsedWorldBookEntry);
  }

  // ── 处理 extras 中的未归类数据 ─────────────
  // 如果原始数据在 extras 中有完整 JSON 还没被处理
  const unknownJson = raw.extras.unknownJson as Record<string, unknown> | undefined;
  if (unknownJson) {
    // 尝试找到角色、消息、世界书
    const charsKey = resolveField(unknownJson, GLOBAL_ALIASES.characters) as unknown[];
    if (Array.isArray(charsKey) && result.characters.length === 0) {
      for (const c of charsKey) {
        result.characters.push(applyFieldMap(c as Record<string, unknown>, CHARACTER_FIELD_MAP));
      }
    }

    const msgsKey = resolveField(unknownJson, GLOBAL_ALIASES.messages) as unknown[];
    if (Array.isArray(msgsKey) && result.messages.length === 0) {
      for (const m of msgsKey) {
        result.messages.push(applyFieldMap(m as Record<string, unknown>, MESSAGE_FIELD_MAP));
      }
    }

    const wbKey = resolveField(unknownJson, GLOBAL_ALIASES.worldBooks) as unknown[];
    if (Array.isArray(wbKey) && result.worldBooks.length === 0) {
      for (const w of wbKey) {
        result.worldBooks.push(applyFieldMap(w as Record<string, unknown>, WORLDBOOK_FIELD_MAP));
      }
    }
  }

  // ── 检查 jailbreak ─────────────────────────
  if (!result.jailbreak && unknownJson) {
    result.jailbreak = (resolveField(unknownJson, GLOBAL_ALIASES.jailbreak) as string) || '';
  }

  return result;
}
