/**
 * normalizeMessage —— 消息归一化
 *
 * 输入：Parser 产出的 ParsedMessage（半归一化对象）
 * 输出：Message（统一消息结构）
 */

import type { Message, MessageRole, MessageMeta } from '../models/message';
import type { ParsedMessage } from '../parsers/jsonParser';

let msgCounter = 0;

export function generateMsgId(): string {
  return `msg_${Date.now()}_${++msgCounter}`;
}

export function resetMsgCounter(): void {
  msgCounter = 0;
}

/**
 * 将单条 ParsedMessage 归一化为 Message
 */
export function normalizeMessage(raw: ParsedMessage, index = 0): Message {
  const message: Message = {
    id: String(raw.id || generateMsgId()),
    role: normalizeRole(raw),
    speaker: String(raw.speaker || raw.name || '未知'),
    content: String(raw.content || ''),
    timestamp: normalizeTimestamp(raw),
    turnIndex: normalizeTurnIndex(raw, index),
    visible: raw.visible !== false && raw.visible !== 'false',
    groupId: raw.groupId ? String(raw.groupId) : undefined,
    meta: normalizeMessageMeta(raw),
  };

  return message;
}

/**
 * 批量归一化消息，自动处理 turnIndex 排序
 */
export function normalizeMessages(raws: ParsedMessage[]): Message[] {
  const normalized = raws.map((r, i) => normalizeMessage(r, i));

  // 按时间戳排序，然后重设 turnIndex
  normalized.sort((a, b) => a.timestamp - b.timestamp);
  normalized.forEach((m, i) => {
    m.turnIndex = i;
  });

  return normalized;
}

// ─── 辅助函数 ─────────────────────────────────────────

function normalizeRole(raw: ParsedMessage): MessageRole {
  const role = String(raw.role || '').toLowerCase();

  const roleMap: Record<string, MessageRole> = {
    user: 'user',
    human: 'user',
    assistant: 'assistant',
    bot: 'assistant',
    ai: 'assistant',
    model: 'assistant',
    system: 'system',
    character: 'character',
    char: 'character',
    narrator: 'character',
  };

  if (roleMap[role]) return roleMap[role];

  // 根据 speaker 名推测
  const speaker = String(raw.speaker || raw.name || '').toLowerCase();
  if (speaker === 'user' || speaker === '用户') return 'user';
  if (speaker === 'system' || speaker === '系统') return 'system';

  // 默认：有 speaker 名就是角色消息
  if (raw.speaker || raw.name) return 'character';

  return 'system';
}

function normalizeTimestamp(raw: ParsedMessage): number {
  const ts = raw.timestamp;
  if (typeof ts === 'number') {
    // 毫秒级时间戳（> 1e12）转秒
    return ts > 1e12 ? Math.floor(ts / 1000) : ts;
  }
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return isNaN(parsed) ? Date.now() / 1000 : Math.floor(parsed / 1000);
  }
  // 没有时间戳就用当前时间
  return Math.floor(Date.now() / 1000);
}

function normalizeTurnIndex(raw: ParsedMessage, fallback: number): number {
  if (typeof raw.turnIndex === 'number') return raw.turnIndex;
  if (typeof raw.turn === 'number') return raw.turn;
  if (typeof raw.swipeId === 'number') return raw.swipeId;
  return fallback;
}

function normalizeMessageMeta(raw: ParsedMessage): MessageMeta {
  const meta: MessageMeta = {};

  if (raw.model !== undefined) meta.model = String(raw.model);
  if (raw.tokenCount !== undefined) meta.tokenCount = Number(raw.tokenCount);
  if (raw.edited !== undefined) meta.edited = Boolean(raw.edited);
  if (raw.swipeId !== undefined || raw.swipeIndex !== undefined) {
    meta.swipeIndex = Number(raw.swipeId || raw.swipeIndex || 0);
  }
  if (raw.swipes !== undefined) {
    const s = raw.swipes;
    meta.swipeTotal = Array.isArray(s) ? s.length : Number(s);
  }

  // 保留未映射的原始字段
  if (raw._raw) {
    Object.assign(meta, raw._raw as Record<string, unknown>);
  }

  return meta;
}
