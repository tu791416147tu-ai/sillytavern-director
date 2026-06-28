/**
 * PromptAssembler —— 提示词组装器
 *
 * 把 RoleContext 组装成模型能吃的最终 prompt。
 *
 * 设计决策：
 *
 * 1. 组装方式：
 *    - 方案A：平铺拼接，所有内容直接 join → 简单但模型容易混淆不同段落
 *    - 方案B：结构化分段，用明确标记分隔各区块 → 模型能区分角色卡/聊天/指令
 *    - 方案C：ChatML/对话模板格式 → 最规范但强依赖具体模型格式
 *    ✅ 选B：结构化分段让模型清晰理解"这是你的设定""这是聊天""这是你要做的"，
 *       同时不依赖特定 chat template，兼容性好。
 *
 * 2. 世界书插入位置：
 *    - 方案A：全部放在角色卡后面 → 简单但长上下文时世界书被截断
 *    - 方案B：按 depth 控制插入位置 → ST 原生方式，精确但复杂
 *    ✅ 选B的简化版：按 position 字段分为 before_char / after_char / in_chat 三组，
 *       分别插入 prompt 的不同位置，不实现完整 depth 排序（那是 ST 的事）
 *
 * 3. 指令格式：
 *    - 方案A：自然语言指令 → 灵活但模型可能不遵守
 *    - 方案B：结构化约束列表 → 清晰但僵硬
 *    ✅ 混合：自然语言主指令 + 结构化约束列表，兼顾灵活性和明确性
 */

import type { RoleContext, RoleTask } from './types';
import type { Message } from '../models/message';
import type { WorldBookEntry } from '../models/worldbook';
import { safeJoin } from '../director/utils';

// ─── 组装参数 ─────────────────────────────────────────

export interface PromptAssembleOptions {
  /** 是否包含角色描述 */
  includeDescription: boolean;
  /** 是否包含世界书 */
  includeWorldBooks: boolean;
  /** 聊天消息的最大条数 */
  maxChatMessages: number;
  /** 世界书内容的最大字符数 */
  maxWorldBookChars: number;
  /** 自定义系统提示前缀 */
  systemPrefix: string;
}

const DEFAULT_PROMPT_OPTIONS: PromptAssembleOptions = {
  includeDescription: true,
  includeWorldBooks: true,
  maxChatMessages: 20,
  maxWorldBookChars: 2000,
  systemPrefix: '',
};

// ─── 主组装函数 ───────────────────────────────────────

/**
 * 将角色上下文组装为完整的模型 prompt
 */
export function assembleRolePrompt(
  task: RoleTask,
  options: Partial<PromptAssembleOptions> = {}
): string {
  const opts = { ...DEFAULT_PROMPT_OPTIONS, ...options };
  const ctx = task.context;
  const sections: string[] = [];

  // ── 1. 系统提示 / 破限 ──────────────────
  if (ctx.jailbreak) {
    sections.push(ctx.jailbreak);
  }

  if (opts.systemPrefix) {
    sections.push(opts.systemPrefix);
  }

  // ── 2. 角色卡 ────────────────────────────
  sections.push(buildCharacterCard(ctx, opts));

  // ── 3. 场景信息 ──────────────────────────
  if (ctx.sceneInfo && ctx.sceneInfo !== '无特殊场景信息') {
    sections.push(`【当前场景】\n${ctx.sceneInfo}`);
  }

  // ── 4. 世界书（before_char 组）───────────
  if (opts.includeWorldBooks && ctx.relevantWorldBooks.length > 0) {
    const beforeChar = ctx.relevantWorldBooks.filter(w => w.position === 'before_char');
    if (beforeChar.length > 0) {
      sections.push(buildWorldBookSection(beforeChar, opts.maxWorldBookChars));
    }
  }

  // ── 5. 会话摘要 ──────────────────────────
  if (ctx.sessionSummary && ctx.sessionSummary !== '暂无对话记录') {
    sections.push(`【对话背景】\n${ctx.sessionSummary}`);
  }

  // ── 6. 公共聊天记录 ──────────────────────
  const chatMsgs = ctx.publicMessages.slice(-opts.maxChatMessages);
  if (chatMsgs.length > 0) {
    sections.push(buildChatSection(chatMsgs));
  }

  // ── 7. 世界书（in_chat 组）───────────────
  if (opts.includeWorldBooks) {
    const inChat = ctx.relevantWorldBooks.filter(w => w.position === 'in_chat');
    if (inChat.length > 0) {
      sections.push(buildWorldBookSection(inChat, opts.maxWorldBookChars));
    }
  }

  // ── 8. 世界书（after_char 组）────────────
  if (opts.includeWorldBooks) {
    const afterChar = ctx.relevantWorldBooks.filter(w => w.position === 'after_char');
    if (afterChar.length > 0) {
      sections.push(buildWorldBookSection(afterChar, opts.maxWorldBookChars));
    }
  }

  // ── 9. 导演指令 + 约束 ───────────────────
  sections.push(buildInstructionSection(task));

  // ── 10. 输出格式要求 ─────────────────────
  sections.push(buildOutputFormatSection(ctx));

  return safeJoin(sections, '\n\n');
}

/**
 * 为导演模型组装调度 prompt（与角色 prompt 不同，导演需要全局视角）
 */
export function assembleDirectorPrompt(
  sessionSummary: string,
  roleNames: string[],
  worldBookTitles: string[],
  latestUserMessage: string
): string {
  return safeJoin([
    '你是群聊导演 AI，负责决定本轮哪些角色发言。',
    '',
    '【当前会话摘要】',
    sessionSummary || '无',
    '',
    '【可选角色】',
    roleNames.join('、') || '无',
    '',
    '【可用世界书】',
    worldBookTitles.join('、') || '无',
    '',
    latestUserMessage ? `【用户最新输入】\n${latestUserMessage}` : '',
    '',
    '请决定：',
    '1. 哪些角色本轮发言（最多 3 位）',
    '2. 发言顺序',
    '3. 简要说明原因',
    '',
    '输出格式：',
    '发言角色：角色A → 角色B → 角色C',
    '原因：一句话说明',
  ]);
}

// ─── 区块构建 ─────────────────────────────────────────

function buildCharacterCard(
  ctx: RoleContext,
  opts: PromptAssembleOptions
): string {
  const c = ctx.character;
  const lines: string[] = [];

  lines.push(`【你的身份】`);
  lines.push(`你是 ${c.displayName}。`);

  if (c.prompt) {
    lines.push('');
    lines.push('【角色设定】');
    lines.push(c.prompt);
  }

  if (opts.includeDescription && c.description && c.description !== c.prompt) {
    lines.push('');
    lines.push('【角色描述】');
    lines.push(c.description);
  }

  return lines.join('\n');
}

function buildChatSection(messages: Message[]): string {
  const lines = messages.map(m => {
    const speaker = m.speaker || m.role;
    return `${speaker}: ${m.content}`;
  });
  return `【公开聊天记录】\n${lines.join('\n')}`;
}

function buildWorldBookSection(
  entries: WorldBookEntry[],
  maxChars: number
): string {
  let total = 0;
  const lines: string[] = [];

  for (const entry of entries) {
    const text = `【${entry.title}】${entry.content}`;
    if (total + text.length > maxChars) continue; // 跳过过长条目，继续尝试后续短条目
    lines.push(text);
    total += text.length;
  }

  if (lines.length === 0) return '';
  return `【相关设定】\n${lines.join('\n')}`;
}

function buildInstructionSection(task: RoleTask): string {
  const lines: string[] = [];

  lines.push('【本轮任务】');
  lines.push(task.instruction || task.context.directorNote || '请根据上下文自然地发言。');

  if (task.constraints.length > 0) {
    lines.push('');
    lines.push('【约束条件】');
    task.constraints.forEach((c, i) => {
      lines.push(`${i + 1}. ${c}`);
    });
  }

  return lines.join('\n');
}

function buildOutputFormatSection(ctx: RoleContext): string {
  const rules: string[] = [];

  rules.push('【输出要求】');
  rules.push('1. 只输出角色的对话内容，不要添加任何解释、前缀或元描述。');
  rules.push('2. 不要替其他角色说话或描述其他角色的行为。');
  rules.push('3. 保持角色设定和语气的一致性。');

  if (ctx.hiddenRoleIds.length > 0) {
    rules.push('4. 你不知道以下角色的内心想法和隐藏设定，请仅基于公开聊天记录回应。');
  }

  return rules.join('\n');
}

// ─── 工具函数 ─────────────────────────────────────────

/**
 * 估算 prompt 的 token 数
 */
export function estimatePromptTokens(prompt: string): number {
  // 混合中英文：约 2.5 字符/token
  return Math.ceil(prompt.length / 2.5);
}

/**
 * 检查 prompt 是否超过指定 token 限制
 */
export function isPromptOverLimit(prompt: string, maxTokens: number): boolean {
  return estimatePromptTokens(prompt) > maxTokens;
}

/**
 * 裁剪 prompt 到指定 token 限制（优先保留角色卡和指令，裁剪聊天记录）
 */
export function trimPromptToLimit(prompt: string, maxTokens: number): string {
  const estimated = estimatePromptTokens(prompt);
  if (estimated <= maxTokens) return prompt;

  // 策略：从尾部裁剪（聊天记录通常在中间偏后位置）
  const maxChars = maxTokens * 2.5;
  const sections = prompt.split('\n\n');

  // 保留前面的关键区块（角色卡、指令），从后往前删
  let result = '';
  let charCount = 0;

  for (const section of sections) {
    // 聊天记录区块最容易被裁剪
    const isChatSection = section.startsWith('【公开聊天记录】');
    const sectionChars = section.length;

    if (isChatSection && charCount + sectionChars > maxChars * 0.7) {
      // 裁剪聊天记录
      const available = Math.max(500, maxChars - charCount - 200);
      const lines = section.split('\n');
      const header = lines[0]; // "【公开聊天记录】"
      const kept = lines.slice(-Math.floor(available / 50)); // 保留最后 N 条
      result += '\n\n' + header + '\n' + kept.join('\n') + '\n（聊天记录已截断）';
      charCount += available; // 计入裁剪后的字符数，继续处理后续区块
      continue;
    }

    // 指令和输出格式必须保留，即使略微超出 token 预算
    const isCritical = section.startsWith('【本轮任务】') || section.startsWith('【输出要求】');
    if (charCount + sectionChars > maxChars && !isCritical) break;
    result += (result ? '\n\n' : '') + section;
    charCount += sectionChars;
  }

  return result;
}
