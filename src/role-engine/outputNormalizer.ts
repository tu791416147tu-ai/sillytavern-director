/**
 * OutputNormalizer —— 输出归一器
 *
 * 把模型原始回复清洗成干净的角色台词。
 *
 * 设计决策：
 *
 * 1. 清洗策略：
 *    - 方案A：纯正则 → 快、免费、可预测，覆盖 90% 场景
 *    - 方案B：LLM 二次清洗 → 更准但多一次 API 调用，延迟翻倍
 *    - 方案C：正则主力 + LLM 兜底（正则结果可疑时触发）→ 平衡
 *    ✅ 选A（MVP），预留C的接口：正则覆盖绝大多数脏输出模式，
 *       LLM 兜底的触发条件很难定义清楚（什么叫"可疑"？），先不做。
 *
 * 2. 空输出处理：
 *    - 方案A：直接标记 failed → 简单但可能浪费（模型其实回复了只是格式不对）
 *    - 方案B：标记 degraded，返回原始文本供调试 → 不丢失信息
 *    ✅ 选B：保留 raw 字段，让调用方决定是否接受降级结果
 *
 * 3. 重复检测：
 *    - 方案A：完全禁止重复 → 太严格，角色可能合理地说相同的话
 *    - 方案B：只检测"回声重复"（和输入原文一模一样）→ 精准
 *    ✅ 选B：只过滤明显的回声/复制粘贴，不干预合理的相似表达
 */

import type { RoleOutput } from './types';

// ─── 归一化选项 ───────────────────────────────────────

export interface NormalizeOptions {
  /** 移除角色名前缀（如 "角色A: 你好" → "你好"） */
  stripRoleNamePrefix: boolean;
  /** 移除思考标签（如 思考... <｜end▁of▁thinking｜>...） */
  stripThinkingTags: boolean;
  /** 移除元话语（如 "作为AI..."、"我来回答..."） */
  stripMetaDiscourse: boolean;
  /** 最大输出长度（字符），超出截断 */
  maxLength: number;
  /** 最小输出长度，低于此值标记为可疑 */
  minLength: number;
  /** 是否裁剪尾部不完整句子 */
  trimIncomplete: boolean;
  /** 角色名列表（用于移除前缀匹配） */
  roleNames: string[];
}

const DEFAULT_NORMALIZE_OPTIONS: NormalizeOptions = {
  stripRoleNamePrefix: true,
  stripThinkingTags: true,
  stripMetaDiscourse: true,
  maxLength: 2000,
  minLength: 1,
  trimIncomplete: false,   // 默认不裁，保留完整回复
  roleNames: [],
};

// ─── 主归一化函数 ─────────────────────────────────────

/**
 * 清洗单条角色输出
 *
 * 返回清洗后的结果 + 步骤日志，方便调试。
 */
export function normalizeOutput(
  output: RoleOutput,
  options: Partial<NormalizeOptions> = {}
): RoleOutput {
  const opts = { ...DEFAULT_NORMALIZE_OPTIONS, ...options };
  const steps: string[] = [];
  let content = output.raw || output.content;

  if (!content || content.trim().length === 0) {
    return {
      ...output,
      content: '',
      status: 'failed',
      normSteps: ['空输出，无法归一化'],
      error: output.error || '模型返回空内容',
    };
  }

  const originalLength = content.length;

  // Step 1: 基础清理
  content = content.trim();
  steps.push(`原始长度: ${originalLength} 字符`);

  // Step 2: 移除思考标签
  if (opts.stripThinkingTags) {
    const beforeThought = content.length;
    content = stripThinkingTags(content);
    if (content.length < beforeThought) {
      steps.push(`移除思考标签: -${beforeThought - content.length} 字符`);
    }
  }

  // Step 3: 移除角色名前缀
  if (opts.stripRoleNamePrefix) {
    const allNames = [output.roleName, ...opts.roleNames];
    const beforePrefix = content.length;
    content = stripRolePrefix(content, allNames);
    if (content.length < beforePrefix) {
      steps.push(`移除角色名前缀: -${beforePrefix - content.length} 字符`);
    }
  }

  // Step 4: 移除元话语
  if (opts.stripMetaDiscourse) {
    const beforeMeta = content.length;
    content = stripMetaDiscourse(content);
    if (content.length < beforeMeta) {
      steps.push(`移除元话语: -${beforeMeta - content.length} 字符`);
    }
  }

  // Step 5: 清洗多余空白
  content = normalizeWhitespace(content);

  // Step 6: 长度截断
  if (content.length > opts.maxLength) {
    content = content.slice(0, opts.maxLength);
    if (opts.trimIncomplete) {
      content = trimToLastCompleteSentence(content);
    }
    steps.push(`截断到 ${opts.maxLength} 字符`);
  }

  // Step 7: 最终修剪
  content = content.trim();

  // Step 8: 结果判断
  if (content.length < opts.minLength) {
    steps.push(`⚠ 输出过短 (${content.length} 字符)，标记为失败`);
    return {
      ...output,
      content,
      status: 'failed',
      normSteps: steps,
      error: '归一化后内容为空或过短',
    };
  }

  steps.push(`归一化完成: ${content.length} 字符`);

  return {
    ...output,
    content,
    status: output.status, // 保持原始状态，不因归一化改变
    normSteps: steps,
  };
}

/**
 * 批量归一化
 */
export function normalizeOutputs(
  outputs: RoleOutput[],
  options: Partial<NormalizeOptions> = {}
): RoleOutput[] {
  return outputs.map(o => normalizeOutput(o, options));
}

// ─── 清洗规则 ─────────────────────────────────────────

/**
 * 移除思考标签
 *
 * 匹配模式：
 *  思考...
 *  [思考]...[思考]
 *  thinking...
 *  <thinking>...</thinking>
 */
function stripThinkingTags(text: string): string {
  // XML 风格标签（完整）
  text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  // XML 风格标签（不完整/自闭合）
  text = text.replace(/<think(?:ing)?\s*\/>/gi, '');
  // 中文方括号风格
  text = text.replace(/【思考】[\s\S]*?【\/?思考】?/g, '');
  text = text.replace(/\[思考\][\s\S]*?\[\/?思考\]?/g, '');
  // 单行思考前缀
  text = text.replace(/^(?:思考|thinking|thought)\s*[:：]\s*.+$/gim, '');
  // SillyTavern 风格: 思考...  (单行)
  text = text.replace(/^思考[：:]\s*.+$/gim, '');

  return text;
}

/**
 * 移除角色名前缀
 *
 * 匹配模式：
 *  角色A: 你好 → 你好
 *  【角色A】你好 → 你好
 *  角色A：你好 → 你好
 */
function stripRolePrefix(text: string, roleNames: string[]): string {
  for (const name of roleNames) {
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 只在开头匹配
    const pattern = new RegExp(
      `^${escaped}\\s*[:：]\\s*`,
      'i'
    );
    if (pattern.test(text)) {
      text = text.replace(pattern, '');
      break; // 只移除一个匹配
    }
    // 方括号/中文括号包裹
    const bracketPattern = new RegExp(
      `^[【\\[]\\s*${escaped}\\s*[】\\]]\\s*`,
      'i'
    );
    if (bracketPattern.test(text)) {
      text = text.replace(bracketPattern, '');
      break;
    }
  }
  return text;
}

/**
 * 移除 AI 元话语
 *
 * 匹配模式：
 *  "作为AI..."
 *  "我来回答..."
 *  "根据设定..."
 *  "好的，我将扮演..."
 *  "(点头)" "(微笑)" 等动作描述
 */
function stripMetaDiscourse(text: string): string {
  const patterns = [
    // 中文元话语
    /^(?:作为(?:一个|一名)?(?:AI|人工智能|语言模型|角色扮演)[，,]?\s*)+/gi,
    /^(?:好的[，,]\s*)?(?:我来?|让我来?)(?:回答|扮演|饰演|表演|演示)/gi,
    /^(?:根据(?:设定|角色|剧本|上下文)[，,]?\s*)+/gi,
    /^(?:我会|我将)(?:扮演|饰演|回答|按照)/gi,
    /^(?:以下是|下面是)(?:我的)?(?:回答|扮演|回复)/gi,
    // 英文元话语
    /^(?:as\s+(?:an?\s+)?(?:AI|language\s+model)[，,]\s*)+/gi,
    /^(?:I\s+will|let\s+me)\s+(?:answer|play|roleplay|respond)/gi,
    /^(?:here\s+(?:is|are)\s+(?:my\s+)?(?:response|answer|reply))/gi,
  ];

  for (const pattern of patterns) {
    text = text.replace(pattern, '');
  }

  return text.trim();
}

/**
 * 规范化空白
 */
function normalizeWhitespace(text: string): string {
  // 合并多个连续换行为双换行
  text = text.replace(/\n{3,}/g, '\n\n');
  // 去除行首尾空白
  text = text.split('\n').map(l => l.trim()).join('\n');
  // 合并多个连续空格
  text = text.replace(/[ \t]{2,}/g, ' ');
  return text;
}

/**
 * 裁剪到最后一个完整句子
 */
function trimToLastCompleteSentence(text: string): string {
  const sentenceEnd = /[。！？.!?\n](?=[^。！？.!?\n]*$)/;
  const match = text.match(sentenceEnd);
  if (match && match.index !== undefined && match.index > text.length * 0.3) {
    return text.slice(0, match.index + 1);
  }
  return text;
}

// ─── 回声检测 ─────────────────────────────────────────

/**
 * 检测输出是否与最近聊天记录高度重复（回声）
 *
 * @returns 重复度 0-1，> 0.8 视为回声
 */
export function detectEcho(output: string, recentMessages: string[]): number {
  if (!output || recentMessages.length === 0) return 0;

  const normalized = output.replace(/\s+/g, '').toLowerCase();

  let maxSimilarity = 0;
  for (const msg of recentMessages) {
    const msgNorm = msg.replace(/\s+/g, '').toLowerCase();
    if (msgNorm.length < 10) continue;

    // 简单的包含检测 + 长度比例
    if (normalized.includes(msgNorm) || msgNorm.includes(normalized)) {
      const ratio = Math.min(normalized.length, msgNorm.length) /
                    Math.max(normalized.length, msgNorm.length);
      maxSimilarity = Math.max(maxSimilarity, ratio);
    }
  }

  return maxSimilarity;
}
