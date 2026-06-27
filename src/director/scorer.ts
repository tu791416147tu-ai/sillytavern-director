import type { Character } from '../models/character';
import type { UnifiedSession } from '../models/session';
import type { DirectorConfig, DirectorRequest, RoleSelectionScore, WorldBookSelectionScore, WakeReason, DispatchPriority } from './types';
import { buildRoleFocusText, inferPriority, matchesMention, matchesSpeaker } from './context';
import { keywordHitScore, normalizeText, uniq } from './utils';

export function scoreRoles(session: UnifiedSession, request: DirectorRequest, config: DirectorConfig): RoleSelectionScore[] {
  const manual = new Set([request.manualSpeakerId, ...(request.manualSpeakerIds || [])].filter(Boolean) as string[]);
  const visibleMsgs = session.messages.filter((m) => m.visible !== false);
  const latestUserMessage = request.latestUserMessage || visibleMsgs[visibleMsgs.length - 1]?.content || '';

  return session.characters
    .filter((role) => config.includeDisabled || role.status !== 'disabled')
    .map((role) => {
      let score = 0;
      const reasons: WakeReason[] = [];

      if (manual.has(role.id)) {
        score += 100;
        reasons.push('manual');
      }

      if (role.isNarrator && config.includeNarrator) {
        score += 20;
        reasons.push('narrator');
      }

      if (matchesMention(role, latestUserMessage)) {
        score += 18;
        reasons.push('mention');
      }

      if (config.preferSpeakerContinuity && matchesSpeaker(role, session)) {
        score += 8;
        reasons.push('speaker-continuity');
      }

      // 发言冷却：最近 2 轮已多次发言的角色降权，防止同一角色连续霸屏
      if (!manual.has(role.id)) {
        const recentSpeakers = session.messages
          .filter(m => m.visible !== false)
          .slice(-4)
          .map(m => m.speaker);
        const recentCount = recentSpeakers.filter(
          s => s === role.displayName || s === role.name
        ).length;
        if (recentCount >= 2) {
          score *= 0.25;
          reasons.push('cooldown-heavy');
        } else if (recentCount >= 1) {
          score *= 0.55;
          reasons.push('cooldown-light');
        }
      }

      const focusText = buildRoleFocusText(role, session, request.latestUserMessage);
      score += keywordHitScore(focusText, [role.name, role.displayName]) * 0.6;
      score += keywordHitScore(latestUserMessage, [role.name, role.displayName]) * 0.4;

      if (role.prompt) score += 0.5;
      if (role.description) score += 0.25;

      if (score <= 0) {
        score += 1;
        reasons.push('fallback');
      } else if (!reasons.length) {
        reasons.push('topic-match');
      }

      const priority: DispatchPriority = inferPriority(score);
      return { roleId: role.id, score, reasons: uniq(reasons), priority };
    })
    .sort((a, b) => b.score - a.score || a.roleId.localeCompare(b.roleId));
}

export function scoreWorldBooks(session: UnifiedSession, request: DirectorRequest, selectedRoles: Character[], config: DirectorConfig): WorldBookSelectionScore[] {
  const focusText = [
    request.latestUserMessage,
    ...session.messages.filter((m) => m.visible !== false).slice(-config.recentMessages).map((m) => `${m.speaker} ${m.content}`),
    ...selectedRoles.map((r) => `${r.name} ${r.displayName} ${r.prompt} ${r.description}`),
  ].filter(Boolean).join('\n');

  return session.worldBooks
    .filter((entry) => entry.enabled !== false)
    .map((entry) => {
      let score = 0;
      const reasons: string[] = [];

      score += keywordHitScore(focusText, entry.keys);
      if (score > 0) reasons.push('primary-keyword');

      const secondary = keywordHitScore(focusText, entry.secondaryKeys);
      if (secondary > 0) {
        score += secondary * 0.5;
        reasons.push('secondary-keyword');
      }

      if (entry.constant) {
        score += 2;
        reasons.push('constant');
      }

      if (entry.target === 'character') {
        const hit = selectedRoles.some((r) => r.id === entry.characterId);
        if (hit) {
          score += 4;
          reasons.push('character-target');
        }
      }

      if (entry.triggerType === 'director') {
        score += 1.5;
        reasons.push('director-trigger');
      }

      if (entry.position === 'in_chat') score += 0.4;
      if (entry.depth === 0) score += 0.2;

      return { entryId: entry.id, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId));
}

export function pickSelectedRoles(scores: RoleSelectionScore[], maxRoles: number): string[] {
  // maxRoles <= 0 表示不自动选择角色（如 silent 模式）
  if (maxRoles <= 0) return [];
  return scores.slice(0, maxRoles).map((item) => item.roleId);
}

// 各会话的 round-robin 旋转位置（模块级持久化）
const roundRobinState = new Map<string, number>();

export function sortSelectedRoles(scores: RoleSelectionScore[], selectedRoleIds: string[], strategy: 'score' | 'fixed' | 'round-robin'): string[] {
  const selected = scores.filter((s) => selectedRoleIds.includes(s.roleId));
  if (strategy === 'fixed') return selectedRoleIds;
  if (strategy === 'round-robin') {
    // 从模块级状态读取上一轮位置，本轮从下一个开始旋转
    const sorted = selected.map((s) => s.roleId).sort((a, b) => a.localeCompare(b));
    // 用排序后的角色列表作为 key（同一组角色共享旋转状态）
    const key = sorted.join(',');
    const lastIdx = roundRobinState.get(key) || -1;
    const start = (lastIdx + 1) % sorted.length;
    // 旋转后的顺序：start...end, 0...start-1
    const rotated = sorted.slice(start).concat(sorted.slice(0, start));
    // 持久化下一轮索引
    roundRobinState.set(key, start);
    return rotated;
  }
  return selected.sort((a, b) => b.score - a.score || a.roleId.localeCompare(b.roleId)).map((s) => s.roleId);
}

export function resolveWakeReasons(role: Character, session: UnifiedSession, request: DirectorRequest, config: DirectorConfig): WakeReason[] {
  const reasons: WakeReason[] = [];
  const latestVis = session.messages.filter((m) => m.visible !== false);
  const latestText = request.latestUserMessage || latestVis[latestVis.length - 1]?.content || '';

  if (request.manualSpeakerId === role.id || (request.manualSpeakerIds || []).includes(role.id)) reasons.push('manual');
  if (matchesMention(role, latestText)) reasons.push('mention');
  if (config.preferSpeakerContinuity && matchesSpeaker(role, session)) reasons.push('speaker-continuity');

  const focusText = buildRoleFocusText(role, session, request.latestUserMessage);
  if (normalizeText(focusText).includes(normalizeText(role.name)) || normalizeText(focusText).includes(normalizeText(role.displayName))) {
    reasons.push('topic-match');
  }

  if (!reasons.length) reasons.push('fallback');
  return uniq(reasons);
}
