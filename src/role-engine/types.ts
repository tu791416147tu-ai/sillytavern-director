/**
 * 角色执行层 —— 核心类型定义
 *
 * 设计决策记录：
 *
 * 1. RoleTask vs 裸参数：
 *    - 方案A：导演直接传 {roleId, instruction} 裸参数 → 简单但扩展性差
 *    - 方案B：使用 RoleTask 结构化任务 → 可追踪、可重试、可日志
 *    - ✅ 选B：结构化任务让执行层可以独立追踪每个角色的执行状态
 *
 * 2. 执行模式：
 *    - 方案A：只做顺序 → 稳但慢
 *    - 方案B：只做并行 → 快但容易串戏
 *    - 方案C：顺序+并行都支持，用户切换 → 灵活
 *    - ✅ 选C：并行模式在角色多但互动轻的场景下省大量时间
 *
 * 3. 输出归一化策略：
 *    - 方案A：正则清洗 → 快、免费、可预测
 *    - 方案B：LLM 二次清洗 → 更准但多一次 API 调用
 *    - 方案C：混合（正则主力 + LLM 兜底）→ 平衡
 *    - ✅ 选A（MVP），预留C的接口：正则覆盖 90% 场景，零额外成本
 *
 * 4. 模型路由：
 *    - 方案A：每个角色硬绑定模型 → 简单但不灵活
 *    - 方案B：三层路由（默认→角色→任务→降级）→ 灵活但复杂
 *    - ✅ 选B：角色多模型混用是这个插件的核心卖点，值得这点复杂度
 */

import type { Character } from '../models/character';
import type { Message } from '../models/message';
import type { WorldBookEntry } from '../models/worldbook';

// ─── 执行模式 ─────────────────────────────────────────
export type ExecutionMode = 'sequential' | 'parallel';

// ─── 任务状态 ─────────────────────────────────────────
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

// ─── 输出状态 ─────────────────────────────────────────
export type OutputStatus = 'success' | 'failed' | 'skipped';

// ─── 模型路由层级 ─────────────────────────────────────
export type RouteLevel = 'default' | 'role' | 'task' | 'fallback';

// ─── 角色上下文（只包含该角色应该看到的内容）──────────
export interface RoleContext {
  /** 角色自身卡片 */
  character: Character;
  /** 公共聊天记录（所有角色都能看到的对话） */
  publicMessages: Message[];
  /** 该角色相关的世界书条目（已经过导演层筛选 + 本层二次过滤） */
  relevantWorldBooks: WorldBookEntry[];
  /** 破限/系统提示 */
  jailbreak: string;
  /** 导演给该角色的本轮指令 */
  directorNote: string;
  /** 本轮会话公共摘要 */
  sessionSummary: string;
  /** 角色不应看到的内容过滤列表（其他角色的隐藏设定等） */
  hiddenRoleIds: string[];
  /** 公共场景信息 */
  sceneInfo: string;
}

// ─── 角色执行任务 ─────────────────────────────────────
export interface RoleTask {
  /** 任务唯一 ID */
  taskId: string;
  /** 所属会话 ID */
  sessionId: string;
  /** 目标角色 ID */
  roleId: string;
  /** 角色显示名 */
  roleName: string;
  /** 执行顺序（0 = 第一个） */
  order: number;
  /** 执行模式 */
  mode: ExecutionMode;
  /** 任务状态 */
  status: TaskStatus;
  /** 指定模型（覆盖路由） */
  modelId?: string;
  /** 专属上下文 */
  context: RoleContext;
  /** 导演指令 */
  instruction: string;
  /** 约束条件 */
  constraints: string[];
  /** 超时（毫秒） */
  deadlineMs: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 已重试次数 */
  retryCount: number;
  /** 创建时间 */
  createdAt: number;
}

// ─── 角色输出 ─────────────────────────────────────────
export interface RoleOutput {
  /** 对应任务 ID */
  taskId: string;
  /** 角色 ID */
  roleId: string;
  /** 角色名 */
  roleName: string;
  /** 清洗后的回复内容 */
  content: string;
  /** 输出状态 */
  status: OutputStatus;
  /** 实际使用的模型 */
  modelId: string;
  /** 消耗 token */
  tokensUsed: number;
  /** 耗时（毫秒） */
  latencyMs: number;
  /** 模型原始返回（调试用） */
  raw: string;
  /** 归一化步骤日志 */
  normSteps: string[];
  /** 错误信息 */
  error: string;
  /** 生成时间 */
  timestamp: number;
}

// ─── 模型路由配置 ─────────────────────────────────────
export interface ModelRouteConfig {
  /** 默认模型（全局兜底） */
  defaultModel: string;
  /** 角色→模型映射 */
  roleModels: Record<string, string>;
  /** 降级模型链（按优先级排列，前面的先尝试） */
  fallbackModels: string[];
  /** 导演专用模型 */
  directorModel: string;
  /** 任务级模型覆盖（{taskId: modelId}） */
  taskOverrides: Record<string, string>;
}

// ─── 执行引擎配置 ─────────────────────────────────────
export interface ExecutionConfig {
  /** 执行模式 */
  mode: ExecutionMode;
  /** 默认超时（毫秒） */
  defaultDeadlineMs: number;
  /** 默认最大重试次数 */
  defaultMaxRetries: number;
  /** 并发上限 */
  maxConcurrency: number;
  /** 模型路由配置 */
  modelRoute: ModelRouteConfig;
}

// ─── 执行结果汇总 ─────────────────────────────────────
export interface ExecutionReport {
  /** 报告 ID */
  reportId: string;
  /** 会话 ID */
  sessionId: string;
  /** 本轮所有输出 */
  outputs: RoleOutput[];
  /** 成功数 */
  successCount: number;
  /** 失败数 */
  failedCount: number;
  /** 跳过数 */
  skippedCount: number;
  /** 总耗时 */
  totalLatencyMs: number;
  /** 总 token */
  totalTokens: number;
  /** 执行模式 */
  mode: ExecutionMode;
  /** 时间戳 */
  timestamp: number;
}

// ─── 默认配置 ─────────────────────────────────────────
export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  mode: 'sequential',
  defaultDeadlineMs: 30000,
  defaultMaxRetries: 2,
  maxConcurrency: 4,
  modelRoute: {
    defaultModel: '',
    roleModels: {},
    fallbackModels: [],
    directorModel: '',
    taskOverrides: {},
  },
};
