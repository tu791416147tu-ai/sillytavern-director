import type { UnifiedSession } from '../models/session';
import type { Character } from '../models/character';
import type { Message } from '../models/message';
import type { WorldBookEntry } from '../models/worldbook';
import type { DirectorConfig, RoleContextBundle, ContextSummary, WakeReason, DispatchPriority } from './types';
import { clamp, keywordHitScore, safeJoin, takeLast, textContainsAny } from './utils';

export function buildContextSummary(session: UnifiedSession): ContextSummary {
  const messages = session.messages.filter((m) => m.visible !== false);
  const latest = messages[messages.length - 1];
  return {
    sessionId: session.sessionId,
    mode: session.mode,
    characterCount: session.characters.length,
    messageCount: messages.length,
    worldBookCount: session.worldBooks.filter((w) => w.enabled !== false).length,
    latestSpeaker: latest?.speaker || '',
    latestMessage: latest?.content || '',
  };
}

export function selectVisibleMessages(session: UnifiedSession, limit: number): Message[] {
  const visible = session.messages.filter((m) => m.visible !== false);
  return takeLast(visible, Math.max(1, limit));
}

export function selectRelevantWorldBooks(
  session: UnifiedSession,
  focusText: string,
  maxCount: number,
  role?: Character
): WorldBookEntry[] {
  const enabled = session.worldBooks.filter((entry) => entry.enabled !== false);
  const scored = enabled
    .map((entry) => {
      let score = 0;
      const reasons: string[] = [];

      score += keywordHitScore(focusText, entry.keys);
      if (score > 0) reasons.push('关键词命中');

      score += keywordHitScore(focusText, entry.secondaryKeys) * 0.5;
      if (entry.constant) {
        score += 2;
        reasons.push('恒定插入');
      }

      if (entry.target === 'character' && role && entry.characterId === role.id) {
        score += 5;
        reasons.push('角色绑定');
      }

      if (entry.target === 'global') {
        score += 1;
        reasons.push('全局条目');
      }

      if (entry.triggerType === 'manual') score += 0.5;
      if (entry.triggerType === 'director') score += 1.5;

      return { entry, score, reasons };
    })
    .sort((a, b) => b.score - a.score || b.entry.priority - a.entry.priority || a.entry.depth - b.entry.depth)
    .filter((item) => item.score > 0 || item.entry.constant);

  return scored.slice(0, Math.max(0, maxCount)).map((x) => x.entry);
}

export function buildRoleContextBundle(params: {
  session: UnifiedSession;
  role: Character;
  config: DirectorConfig;
  selectedWorldBooks: WorldBookEntry[];
  wakeReason: WakeReason[];
  priority: DispatchPriority;
}): RoleContextBundle {
  const { session, role, config, selectedWorldBooks, wakeReason, priority } = params;
  const visibleMessages = selectVisibleMessages(session, config.recentMessages);
  const publicSummary = summarizeMessages(visibleMessages);

  const directorNote = safeJoin([
    `本轮身份：${role.displayName}`,
    `唤醒原因：${wakeReason.join(' / ') || 'fallback'}`,
    `优先级：${priority}`,
    selectedWorldBooks.length ? `相关世界书：${selectedWorldBooks.map((w) => w.title).join('、')}` : '相关世界书：无',
  ]);

  return {
    role,
    visibleMessages,
    selectedWorldBooks,
    publicSummary,
    directorNote,
    wakeReason,
    priority,
  };
}

export function summarizeMessages(messages: Message[]): string {
  if (!messages.length) return '无公开聊天记录';
  const lines = messages.map((m) => {
    const speaker = m.speaker || m.role;
    const content = String(m.content || '').replace(/\s+/g, ' ').trim();
    return `${speaker}: ${content}`;
  });
  return safeJoin(lines, '\n');
}

export function buildRoleFocusText(
  role: Character,
  session: UnifiedSession,
  latestUserMessage?: string
): string {
  const latest = session.messages.filter((m) => m.visible !== false).slice(-8);
  const previous = latest.map((m) => `${m.speaker} ${m.content}`).join('\n');
  return safeJoin([
    role.name,
    role.displayName,
    role.description,
    role.prompt,
    latestUserMessage,
    previous,
  ]);
}

export function inferPriority(score: number): DispatchPriority {
  if (score >= 9) return 'high';
  if (score >= 4) return 'normal';
  return 'low';
}

export function limitText(text: string, maxChars: number): string {
  const clean = String(text || '').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function matchesSpeaker(role: Character, session: UnifiedSession): boolean {
  const visible = session.messages.filter((m) => m.visible !== false);
  const latest = visible[visible.length - 1];
  if (!latest) return false;
  return latest.speaker === role.displayName || latest.speaker === role.name;
}

export function matchesMention(role: Character, text?: string): boolean {
  if (!text) return false;
  return textContainsAny(text, [role.displayName, role.name]);
}

export function clampVisibleMessageCount(value: number): number {
  return clamp(value, 1, 50);
}
