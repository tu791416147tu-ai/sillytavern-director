/**
 * validateSession —— 会话校验器
 *
 * 在校验 UnifiedSession 的结构完整性和数据合法性。
 * 校验失败返回明确的错误信息列表，绝不静默吞错。
 */

import type { UnifiedSession } from '../models/session';
import type { Character } from '../models/character';
import type { Message } from '../models/message';
import type { WorldBookEntry } from '../models/worldbook';
import type { JailbreakConfig } from '../models/jailbreak';

// ─── 校验结果类型 ─────────────────────────────────────

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  /** 问题严重级别 */
  severity: ValidationSeverity;
  /** 所属字段路径，如 "characters[0].name" */
  path: string;
  /** 人类可读的错误描述 */
  message: string;
}

export interface ValidationResult {
  /** 是否通过（无 error 级别问题时为 true） */
  valid: boolean;
  /** 所有问题列表 */
  issues: ValidationIssue[];
  /** 仅 error 级别 */
  errors: ValidationIssue[];
  /** 仅 warning 级别 */
  warnings: ValidationIssue[];
  /** 仅 info 级别 */
  infos: ValidationIssue[];
}

// ─── 工厂函数 ─────────────────────────────────────────

function issue(
  severity: ValidationSeverity,
  path: string,
  message: string
): ValidationIssue {
  return { severity, path, message };
}

function makeResult(issues: ValidationIssue[]): ValidationResult {
  return {
    valid: issues.every(i => i.severity !== 'error'),
    issues,
    errors: issues.filter(i => i.severity === 'error'),
    warnings: issues.filter(i => i.severity === 'warning'),
    infos: issues.filter(i => i.severity === 'info'),
  };
}

// ─── 顶层校验 ─────────────────────────────────────────

export function validateSession(session: UnifiedSession): ValidationResult {
  const issues: ValidationIssue[] = [];

  // ── 必填字段 ──────────────────────────────
  if (!session.sessionId) {
    issues.push(issue('error', 'sessionId', '会话 ID 不能为空'));
  }

  if (!session.mode) {
    issues.push(issue('error', 'mode', '运行模式不能为空'));
  } else if (!['live', 'import'].includes(session.mode)) {
    issues.push(issue('error', 'mode', `未知的运行模式: "${session.mode}"`));
  }

  // ── 校验角色 ──────────────────────────────
  issues.push(...validateCharacters(session.characters, session.mode));

  // ── 校验消息 ──────────────────────────────
  issues.push(...validateMessages(session.messages));

  // ── 校验世界书 ────────────────────────────
  issues.push(...validateWorldBooks(session.worldBooks));

  // ── 校验破限 ──────────────────────────────
  issues.push(...validateJailbreak(session.jailbreak, session.mode));

  // ── 校验来源元数据 ─────────────────────────
  if (!session.sourceMeta) {
    issues.push(issue('warning', 'sourceMeta', '缺少来源元数据，建议补充以便调试'));
  } else {
    if (!session.sourceMeta.source) {
      issues.push(issue('warning', 'sourceMeta.source', '未标记数据来源'));
    }
    if (session.mode === 'import' && session.sourceMeta.fileNames.length === 0) {
      issues.push(issue('info', 'sourceMeta.fileNames', '导入模式但未记录文件名'));
    }
  }

  return makeResult(issues);
}

// ─── 角色校验 ─────────────────────────────────────────

function validateCharacters(
  characters: Character[],
  mode: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!Array.isArray(characters)) {
    issues.push(issue('error', 'characters', '角色列表必须为数组'));
    return issues;
  }

  if (characters.length === 0) {
    issues.push(issue('warning', 'characters', '没有加载任何角色（允许空白草稿状态）'));
    return issues;
  }

  const seenNames = new Set<string>();

  characters.forEach((char, i) => {
    const p = `characters[${i}]`;

    // 名字不能为空
    if (!char.name || char.name.trim() === '') {
      issues.push(issue('error', `${p}.name`, '角色名不能为空'));
    } else {
      // 检查重名
      const normalized = char.name.trim().toLowerCase();
      if (seenNames.has(normalized)) {
        issues.push(issue('warning', `${p}.name`, `角色名 "${char.name}" 重复`));
      }
      seenNames.add(normalized);
    }

    // ID 不能为空
    if (!char.id) {
      issues.push(issue('error', `${p}.id`, '角色 ID 不能为空'));
    }

    // 状态检查
    if (!char.status) {
      issues.push(issue('info', `${p}.status`, `角色 "${char.name}" 未设置状态，默认启用`));
    }

    // 提示检查（角色 prompt 是核心字段）
    if (!char.prompt && !char.description) {
      issues.push(
        issue('info', `${p}.prompt`, `角色 "${char.name}" 缺少系统提示和描述，可能影响对话质量`)
      );
    }
  });

  return issues;
}

// ─── 消息校验 ─────────────────────────────────────────

function validateMessages(messages: Message[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!Array.isArray(messages)) {
    issues.push(issue('error', 'messages', '消息列表必须为数组'));
    return issues;
  }

  if (messages.length === 0) {
    issues.push(issue('info', 'messages', '聊天记录为空'));
    return issues;
  }

  let lastTurnIndex = -1;

  messages.forEach((msg, i) => {
    const p = `messages[${i}]`;

    // 内容检查
    if (msg.content === undefined || msg.content === null) {
      issues.push(issue('warning', `${p}.content`, `消息 #${i} 内容为空`));
    }

    // 角色消息必须有 speaker
    if (msg.role === 'character' && (!msg.speaker || msg.speaker.trim() === '')) {
      issues.push(issue('error', `${p}.speaker`, `角色消息 #${i} 缺少发言者 (speaker)`));
    }

    // 顺序检查
    if (typeof msg.turnIndex === 'number') {
      if (msg.turnIndex < lastTurnIndex && msg.turnIndex >= 0) {
        issues.push(
          issue('warning', `${p}.turnIndex`, `消息顺序异常: turnIndex ${msg.turnIndex} < ${lastTurnIndex}`)
        );
      }
      if (msg.turnIndex >= 0) {
        lastTurnIndex = msg.turnIndex;
      }
    }

    // role 检查
    const validRoles = ['user', 'assistant', 'system', 'character'];
    if (!validRoles.includes(msg.role)) {
      issues.push(issue('warning', `${p}.role`, `未知消息角色: "${msg.role}"`));
    }
  });

  // 检查是否有连续同角色消息（可能是数据问题）
  let prevRole = '';
  let consecutiveCount = 0;
  messages.forEach((msg, i) => {
    if (msg.role === prevRole && msg.role === 'assistant') {
      consecutiveCount++;
      if (consecutiveCount >= 3) {
        issues.push(
          issue('info', `messages[${i}].role`, `连续 ${consecutiveCount + 1} 条 assistant 消息，请确认是否为预期行为`)
        );
        consecutiveCount = 0; // 只报一次
      }
    } else {
      prevRole = msg.role;
      consecutiveCount = 0;
    }
  });

  return issues;
}

// ─── 世界书校验 ───────────────────────────────────────

function validateWorldBooks(entries: WorldBookEntry[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!Array.isArray(entries)) {
    issues.push(issue('error', 'worldBooks', '世界书列表必须为数组'));
    return issues;
  }

  if (entries.length === 0) {
    // 世界书可以为空，这不是错误
    return issues;
  }

  entries.forEach((entry, i) => {
    const p = `worldBooks[${i}]`;

    // 内容不能全空
    if (!entry.content || entry.content.trim() === '') {
      issues.push(issue('warning', `${p}.content`, `世界书条目 "${entry.title || '未命名'}" 内容为空`));
    }

    // key 最好至少一个（非 constant 模式下）
    if ((!entry.keys || entry.keys.length === 0) && !entry.constant) {
      issues.push(
        issue('info', `${p}.keys`, `世界书条目 "${entry.title}" 没有设置触发关键词，且非恒定插入，可能永远不会触发`)
      );
    }

    // 标题检查
    if (!entry.title || entry.title.trim() === '') {
      issues.push(issue('warning', `${p}.title`, `世界书条目 #${i} 缺少标题`));
    }

    // 深度范围检查
    if (entry.depth < 0 || entry.depth > 99) {
      issues.push(issue('warning', `${p}.depth`, `世界书条目 "${entry.title}" 深度 ${entry.depth} 超出常规范围 [0-99]`));
    }
  });

  return issues;
}

// ─── 破限校验 ─────────────────────────────────────────

function validateJailbreak(
  jailbreak: JailbreakConfig,
  mode: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!jailbreak) {
    issues.push(issue('info', 'jailbreak', '破限未加载'));
    return issues;
  }

  if (!jailbreak.text || jailbreak.text.trim() === '') {
    if (jailbreak.enabled) {
      issues.push(issue('warning', 'jailbreak.text', '破限已启用但内容为空'));
    } else {
      issues.push(issue('info', 'jailbreak.text', '破限未加载（已标记为未启用）'));
    }
  }

  if (jailbreak.source === 'none' && mode === 'live') {
    issues.push(issue('info', 'jailbreak.source', '实时模式未检测到激活的破限/预设'));
  }

  return issues;
}

// ─── 快捷校验（抛异常版） ─────────────────────────────

/**
 * 校验并抛出：有 error 时抛出汇总异常
 */
export function validateOrThrow(session: UnifiedSession): void {
  const result = validateSession(session);
  if (!result.valid) {
    const messages = result.errors.map(e => `  [${e.path}] ${e.message}`).join('\n');
    throw new Error(`会话校验失败:\n${messages}`);
  }
}
