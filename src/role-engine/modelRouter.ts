/**
 * ModelRouter —— 模型路由器
 *
 * 决定每个角色任务使用哪个模型。
 *
 * 设计决策：
 *
 * 1. 三层路由 vs 单层映射：
 *    - 单层映射：{roleId: model} 查表 → 简单但无降级
 *    - 三层路由：默认 → 角色专属 → 任务覆盖 → 降级链 → 报错
 *    ✅ 选三层路由：角色多模型混用是核心卖点，降级链保证鲁棒性
 *
 * 2. 降级策略：
 *    - 方案A：失败直接报错 → 用户体验差
 *    - 方案B：失败切 fallbackModels[0] → 简单但有概率二次失败
 *    - 方案C：失败沿降级链逐次尝试 → 最大化成功率
 *    ✅ 选C：在 fallbackModels 链上逐次降级，每个模型有独立超时
 *
 * 3. 模型名来源：
 *    - 在 SillyTavern 中，模型名是 ST 的连接标识符（如 "openai/gpt-4o"）
 *    - 本路由只返回模型名字符串，实际 API 调用由 ST 的 generate 接口完成
 *    ✅ 与 ST 的模型系统解耦：路由不关心后端是 OpenAI/Claude/本地模型
 */

import type { RoleTask, ModelRouteConfig, RouteLevel } from './types';

// ─── 路由结果 ─────────────────────────────────────────

export interface RouteResult {
  /** 选中的模型名 */
  modelId: string;
  /** 路由层级 */
  level: RouteLevel;
  /** 是否来自降级链 */
  isFallback: boolean;
  /** 路由决策说明（调试用） */
  reason: string;
}

// ─── 路由器 ───────────────────────────────────────────

export class ModelRouter {
  private config: ModelRouteConfig;
  /** 记录每个模型最近的失败次数，用于自动降级 */
  private failureCounts: Map<string, number> = new Map();
  /** 自动降级阈值：连续失败 N 次后自动切换到降级链 */
  private autoDegradeThreshold = 3;

  constructor(config: ModelRouteConfig) {
    this.config = config;
  }

  /**
   * 为任务选择模型
   *
   * 路由优先级：
   *  1. taskOverrides[taskId]  → 任务级覆盖（最高优先）
   *  2. roleModels[roleId]     → 角色专属模型
   *  3. defaultModel           → 全局默认
   *  4. fallbackModels[0]      → 降级链首位
   *  5. 抛出错误               → 无可用的模型
   */
  route(task: RoleTask): RouteResult {
    // 层1: 任务级覆盖
    if (task.modelId) {
      return this.makeResult(task.modelId, 'task', `任务 ${task.taskId} 指定模型`);
    }

    const taskOverride = this.config.taskOverrides[task.taskId];
    if (taskOverride) {
      return this.makeResult(taskOverride, 'task', `任务级配置覆盖`);
    }

    // 层2: 角色专属模型
    const roleModel = this.config.roleModels[task.roleId];
    if (roleModel) {
      // 检查该模型是否因连续失败被临时降级
      if (this.shouldAutoDegrade(roleModel)) {
        const fallback = this.findFallback(task);
        return this.makeResult(fallback, 'fallback',
          `角色模型 ${roleModel} 近期失败过多，自动降级到 ${fallback}`);
      }
      return this.makeResult(roleModel, 'role', `角色 ${task.roleName} 专属模型`);
    }

    // 层3: 全局默认
    if (this.config.defaultModel) {
      if (this.shouldAutoDegrade(this.config.defaultModel)) {
        const fallback = this.findFallback(task);
        return this.makeResult(fallback, 'fallback',
          `默认模型 ${this.config.defaultModel} 近期失败过多，自动降级`);
      }
      return this.makeResult(this.config.defaultModel, 'default', '全局默认模型');
    }

    // 层4: 降级链
    if (this.config.fallbackModels.length > 0) {
      return this.makeResult(this.findFallback(task), 'fallback', '使用降级模型');
    }

    throw new Error(
      `[ModelRouter] 无法为角色 "${task.roleName}" (${task.roleId}) 分配模型。` +
      '请检查 ExecutionConfig 中的 modelRoute 配置。'
    );
  }

  /**
   * 获取降级模型（用于重试）
   * 在降级链中找下一个未失败过度的模型
   */
  getFallbackForRetry(currentModelId: string, task: RoleTask): string | null {
    const idx = this.config.fallbackModels.indexOf(currentModelId);

    // 从当前位置之后找
    for (let i = idx + 1; i < this.config.fallbackModels.length; i++) {
      const candidate = this.config.fallbackModels[i];
      if (!this.shouldAutoDegrade(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * 记录模型调用失败
   */
  recordFailure(modelId: string): void {
    const count = (this.failureCounts.get(modelId) || 0) + 1;
    this.failureCounts.set(modelId, count);
  }

  /**
   * 记录模型调用成功（重置失败计数）
   */
  recordSuccess(modelId: string): void {
    this.failureCounts.delete(modelId);
  }

  /**
   * 更新路由配置（运行时动态调整）
   */
  updateConfig(partial: Partial<ModelRouteConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  getConfig(): ModelRouteConfig {
    return { ...this.config };
  }

  // ── 内部 ─────────────────────────────────

  private makeResult(modelId: string, level: RouteLevel, reason: string): RouteResult {
    return { modelId, level, isFallback: level === 'fallback', reason };
  }

  private shouldAutoDegrade(modelId: string): boolean {
    return (this.failureCounts.get(modelId) || 0) >= this.autoDegradeThreshold;
  }

  private findFallback(task: RoleTask): string {
    for (const fb of this.config.fallbackModels) {
      if (!this.shouldAutoDegrade(fb)) return fb;
    }
    throw new Error(
      `[ModelRouter] 角色 "${task.roleName}" 的所有降级模型均已失败，无法继续。`
    );
  }
}

// ─── 工厂函数 ─────────────────────────────────────────

export function createModelRouter(config: Partial<ModelRouteConfig> = {}): ModelRouter {
  return new ModelRouter({
    defaultModel: config.defaultModel || '',
    roleModels: config.roleModels || {},
    fallbackModels: config.fallbackModels || [],
    directorModel: config.directorModel || '',
    taskOverrides: config.taskOverrides || {},
  });
}
