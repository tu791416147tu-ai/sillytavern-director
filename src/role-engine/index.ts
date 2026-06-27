/**
 * 角色执行层 —— 统一导出
 */

// 类型
export type {
  ExecutionMode, TaskStatus, OutputStatus, RouteLevel,
  RoleContext, RoleTask, RoleOutput,
  ModelRouteConfig, ExecutionConfig, ExecutionReport,
} from './types';
export { DEFAULT_EXECUTION_CONFIG } from './types';

// 上下文构建
export {
  buildRoleContext,
  buildAllRoleContexts,
  estimateContextTokens,
} from './contextBuilder';
export type { ContextBuildOptions } from './contextBuilder';

// 模型路由
export { ModelRouter, createModelRouter } from './modelRouter';
export type { RouteResult } from './modelRouter';

// Prompt 组装
export {
  assembleRolePrompt,
  assembleDirectorPrompt,
  estimatePromptTokens,
  isPromptOverLimit,
  trimPromptToLimit,
} from './promptAssembler';
export type { PromptAssembleOptions } from './promptAssembler';

// 执行引擎
export { ExecutionEngine } from './executor';
export type { GenerateCallback, GenerateResult } from './executor';

// 输出归一化
export {
  normalizeOutput,
  normalizeOutputs,
  detectEcho,
} from './outputNormalizer';
export type { NormalizeOptions } from './outputNormalizer';

// 回写适配器
export { Writer, createWriter } from './writer';
export type { WriteCallback, WriteCompleteCallback, WriteMessage } from './writer';
