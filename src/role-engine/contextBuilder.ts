/**
 * RoleContextBuilder —— 角色专属上下文构建器
 *
 * 这是防串戏的核心。每个角色只拿"自己应该知道的东西"。
 *
 * 设计决策：
 *
 * 1. 公共/私有分层 vs 全量共享：
 *    - 全量共享：所有角色看到完全相同的上下文 → 简单但必然串戏
 *    - 公共/私有分层：聊天公开，角色卡私有 → 平衡安全性和实现复杂度
 *    - 完全隔离：每个角色只看到经角色关系过滤的聊天 → 最安全但过度设计
 *    ✅ 选公共/私有分层：聊天天然就是公开的，角色卡天然就是私有的，
 *       这个分层符合直觉，不需要复杂的关系建模。
 *
 * 2. 世界书二次过滤 vs 全量交给导演：
 *    - 导演全权负责：执行层不碰世界书 → 导演层职责过重
 *    - 执行层二次过滤：导演粗筛 → 执行层按角色精筛 → 分工合理
 *    ✅ 选二次过滤：导演筛"本轮相关"，执行层筛"该角色相关"
 *
 * 3. 聊天记录裁剪策略：
 *    - 固定 N 条：简单但不同场景需求不同
 *    - 按轮次：保持对话完整性
 *    - 按 token 预算：精确但复杂
 *    ✅ 选按条数+可见性过滤：简单可控，visible=false 的消息自动排除
 */

import type { UnifiedSession } from '../models/session';
import type { Character } from '../models/character';
import type { Message } from '../models/message';
import type { WorldBookEntry } from '../models/worldbook';
import type { RoleContext } from './types';
import { clamp } from '../director/utils';

// ─── 构建参数 ─────────────────────────────────────────

export interface ContextBuildOptions {
  /** 公共聊天保留条数 */
  maxPublicMessages: number;
  /** 世界书最大条目数 */
  maxWorldBooks: number;
  /** 是否包含破限 */
  includeJailbreak: boolean;
  /** 会话摘要最大长度 */
  summaryMaxChars: number;
  /** 隐藏的角色 ID 列表（这些角色的私设不可见） */
  hiddenRoleIds: string[];
}

const DEFAULT_OPTIONS: ContextBuildOptions = {
  maxPublicMessages: 20,
  maxWorldBooks: 8,
  includeJailbreak: true,
  summaryMaxChars: 500,
  hiddenRoleIds: [],
};

// ─── 主构建函数 ───────────────────────────────────────

/**
 * 为单个角色构建专属上下文
 *
 * 公共层（所有角色共享）：
 *   - 最近公开聊天记录
 *   - 场景信息
 *   - 破限
 *
 * 私有层（仅该角色）：
 *   - 角色卡
 *   - 专属世界书
 *   - 导演指令
 */
export function buildRoleContext(
  session: UnifiedSession,
  role: Character,
  directorNote: string,
  preFilteredWorldBooks: WorldBookEntry[],
  options: Partial<ContextBuildOptions> = {}
): RoleContext {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // ── 公共聊天 ────────────────────────────
  const visibleMessages = session.messages
    .filter(m => m.visible !== false)
    .slice(-opts.maxPublicMessages);

  // ── 世界书二次过滤 ──────────────────────
  // 导演已经筛过一轮，这里只保留与该角色相关的
  const relevantWBs = filterWorldBooksForRole(preFilteredWorldBooks, role, opts.maxWorldBooks);

  // ── 会话摘要 ────────────────────────────
  const sessionSummary = buildSessionSummary(session, opts.summaryMaxChars);

  // ── 场景信息 ────────────────────────────
  const sceneInfo = extractSceneInfo(session, role);

  return {
    character: role,
    publicMessages: visibleMessages,
    relevantWorldBooks: relevantWBs,
    jailbreak: opts.includeJailbreak ? session.jailbreak.text : '',
    directorNote,
    sessionSummary,
    hiddenRoleIds: opts.hiddenRoleIds,
    sceneInfo,
  };
}

/**
 * 批量为多个角色构建上下文
 *
 * 在并行模式下，所有角色使用相同的公共上下文快照，
 * 避免因构建时差导致的不一致。
 */
export function buildAllRoleContexts(
  session: UnifiedSession,
  roles: Character[],
  directorNotes: Record<string, string>,    // {roleId: note}
  preFilteredWorldBooks: WorldBookEntry[],
  options: Partial<ContextBuildOptions> = {}
): Record<string, RoleContext> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // 公共层一次性构建，保证并行模式下一致性
  const visibleMessages = session.messages
    .filter(m => m.visible !== false)
    .slice(-opts.maxPublicMessages);
  const sessionSummary = buildSessionSummary(session, opts.summaryMaxChars);

  const contexts: Record<string, RoleContext> = {};

  for (const role of roles) {
    const relevantWBs = filterWorldBooksForRole(preFilteredWorldBooks, role, opts.maxWorldBooks);
    const sceneInfo = extractSceneInfo(session, role);

    contexts[role.id] = {
      character: role,
      publicMessages: visibleMessages,
      relevantWorldBooks: relevantWBs,
      jailbreak: opts.includeJailbreak ? session.jailbreak.text : '',
      directorNote: directorNotes[role.id] || '',
      sessionSummary,
      hiddenRoleIds: opts.hiddenRoleIds,
      sceneInfo,
    };
  }

  return contexts;
}

// ─── 世界书过滤 ───────────────────────────────────────

/**
 * 为角色过滤世界书条目
 *
 * 过滤规则（按优先级）：
 *  1. target='character' 且 characterId 匹配 → 保留
 *  2. target='global' → 保留
 *  3. target='session' → 保留
 *  4. 其余 → 丢弃
 *
 * 然后按 priority 降序 + depth 升序排列，取前 N 条。
 */
function filterWorldBooksForRole(
  entries: WorldBookEntry[],
  role: Character,
  maxCount: number
): WorldBookEntry[] {
  return entries
    .filter(entry => {
      if (!entry.enabled) return false;
      if (entry.target === 'character') {
        return entry.characterId === role.id;
      }
      return entry.target === 'global' || entry.target === 'session';
    })
    .sort((a, b) => {
      // priority 高的在前，同 priority 按 depth 升序
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.depth - b.depth;
    })
    .slice(0, Math.max(1, maxCount));
}

// ─── 会话摘要 ─────────────────────────────────────────

function buildSessionSummary(session: UnifiedSession, maxChars: number): string {
  const visible = session.messages.filter(m => m.visible !== false);
  if (visible.length === 0) return '暂无对话记录';

  const recentCount = Math.min(6, visible.length);
  const recent = visible.slice(-recentCount);

  const lines = recent.map(m => {
    const speaker = m.speaker || m.role;
    const text = (m.content || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return `${speaker}: ${text}`;
  });

  let summary = lines.join('\n');
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars - 3) + '...';
  }

  const totalMsg = visible.length;
  if (totalMsg > recentCount) {
    summary = `（共 ${totalMsg} 条消息，以下为最近 ${recentCount} 条）\n` + summary;
  }

  return summary;
}

// ─── 场景信息提取 ─────────────────────────────────────

function extractSceneInfo(session: UnifiedSession, role: Character): string {
  const parts: string[] = [];

  // 会话中的角色列表（角色名，不含详细设定）
  const otherChars = session.characters
    .filter(c => c.id !== role.id && c.status === 'enabled')
    .map(c => c.displayName);

  if (otherChars.length > 0) {
    parts.push(`在场角色：${otherChars.join('、')}`);
  }

  // 如果有 scenario/场景描述
  if (role.description) {
    const desc = role.description.trim();
    if (desc.length > 0 && desc.length < 200) {
      parts.push(`场景：${desc}`);
    }
  }

  return parts.join('\n') || '无特殊场景信息';
}

// ─── 上下文 token 估算 ────────────────────────────────

/**
 * 估算上下文大概占用多少 token（中文约 1.5 字符/token，英文约 4 字符/token）
 */
export function estimateContextTokens(context: RoleContext): number {
  let totalChars = 0;

  totalChars += context.character.prompt.length;
  totalChars += context.character.description.length;
  totalChars += context.jailbreak.length;
  totalChars += context.directorNote.length;
  totalChars += context.sessionSummary.length;
  totalChars += context.sceneInfo.length;

  for (const msg of context.publicMessages) {
    totalChars += (msg.speaker || '').length + (msg.content || '').length;
  }

  for (const wb of context.relevantWorldBooks) {
    totalChars += (wb.title || '').length + (wb.content || '').length;
  }

  // 混合中英文粗略估算：约 2.5 字符/token
  return Math.ceil(totalChars / 2.5);
}
