/**
 * ExecutionEngine —— 执行引擎
 *
 * 负责真正发起模型调用，支持顺序/并行两种模式。
 *
 * 设计决策：
 *
 * 1. 模型调用方式：
 *    - 方案A：executor 内直接调 fetch/ST API → 耦合 ST，不可测试
 *    - 方案B：接受回调函数 (prompt, model) => text → 解耦，可测试，后端无关
 *    ✅ 选B：GenerateCallback 由插件层注入，executor 不关心底层是 ST/OpenAI/本地
 *
 * 2. 超时处理：
 *    - 方案A：AbortController → 标准但浏览器端有兼容问题
 *    - 方案B：Promise.race + setTimeout → 简单可靠，但无法真正中断底层请求
 *    ✅ 选B：Promise.race 在 JS 环境最可靠，虽然无法中断底层 TCP 连接，
 *       但对用户体验来说"超时就放弃"的效果是一样的
 *
 * 3. 重试策略：
 *    - 方案A：固定重试 N 次 → 简单
 *    - 方案B：指数退避 → 适合网络波动但增加延迟
 *    - 方案C：立即重试 + 切模型 → 最大化成功率
 *    ✅ 选C：第一次重试用原模型（可能是临时网络问题），
 *       第二次重试切降级模型（可能是模型本身的问题），最大化成功率
 *
 * 4. 并发控制：
 *    - 在并行模式下，不是无限制并发，而是用 maxConcurrency 限制
 *    - 用分批 Promise.all 实现：每批最多 maxConcurrency 个并发
 *    ✅ 防止同时发起 20 个 API 调用导致限流
 */

import type { RoleTask, RoleOutput, ExecutionConfig, ExecutionReport, OutputStatus } from './types';
import { ModelRouter } from './modelRouter';
import { nowId } from '../director/utils';

// ─── 生成回调类型 ──────────────────────────────────────

/**
 * 模型生成回调
 *
 * 由插件层注入，负责实际的 API 调用。
 * executor 不关心底层实现（ST / OpenAI / Claude / 本地模型）。
 */
export type GenerateCallback = (
  prompt: string,
  modelId: string,
  timeoutMs: number
) => Promise<GenerateResult>;

export interface GenerateResult {
  /** 模型返回的原始文本 */
  text: string;
  /** token 用量 */
  tokensUsed: number;
  /** 实际耗时（毫秒） */
  latencyMs: number;
}

// ─── 执行引擎 ─────────────────────────────────────────

export class ExecutionEngine {
  private config: ExecutionConfig;
  private modelRouter: ModelRouter;
  private generateCallback: GenerateCallback | null = null;

  constructor(config: ExecutionConfig) {
    this.config = config;
    this.modelRouter = new ModelRouter(config.modelRoute);
  }

  /**
   * 设置生成回调（由插件层注入）
   */
  setGenerateCallback(callback: GenerateCallback): void {
    this.generateCallback = callback;
  }

  /**
   * 获取内部模型路由器（用于外部查询路由信息）
   */
  getModelRouter(): ModelRouter {
    return this.modelRouter;
  }

  /**
   * 执行一批角色任务
   *
   * 根据 config.mode 自动选择顺序或并行模式。
   * 返回 ExecutionReport 包含所有输出和统计信息。
   */
  async execute(tasks: RoleTask[]): Promise<ExecutionReport> {
    if (!this.generateCallback) {
      throw new Error('[ExecutionEngine] 未设置 generateCallback。请先调用 setGenerateCallback()。');
    }

    const startTime = performance.now();
    const validTasks = tasks.filter(t => t.status !== 'skipped');

    if (validTasks.length === 0) {
      return this.emptyReport(startTime);
    }

    // 按 mode 选择执行策略
    let outputs: RoleOutput[];
    if (this.config.mode === 'parallel') {
      outputs = await this.executeParallel(validTasks);
    } else {
      outputs = await this.executeSequential(validTasks);
    }

    return this.buildReport(outputs, startTime);
  }

  /**
   * 顺序执行：一个接一个
   *
   * 每个角色能看到前面角色的输出（由调用方在 context 中体现），
   * executor 只保证执行顺序，不修改 context。
   */
  private async executeSequential(tasks: RoleTask[]): Promise<RoleOutput[]> {
    const outputs: RoleOutput[] = [];

    for (const task of [...tasks].sort((a, b) => a.order - b.order)) {
      const output = await this.executeOneTask(task);
      outputs.push(output);
    }

    return outputs;
  }

  /**
   * 并行执行：分批并发
   *
   * 所有并行的角色共享同一份 context 快照（调用方负责一致性）。
   * 用 maxConcurrency 限制并发数，防止 API 限流。
   */
  private async executeParallel(tasks: RoleTask[]): Promise<RoleOutput[]> {
    const sorted = [...tasks].sort((a, b) => a.order - b.order);
    const outputs: RoleOutput[] = [];
    const maxCon = Math.max(1, this.config.maxConcurrency);

    // 分批执行
    for (let i = 0; i < sorted.length; i += maxCon) {
      const batch = sorted.slice(i, i + maxCon);

      const batchResults = await Promise.all(
        batch.map(task => this.executeOneTask(task))
      );

      outputs.push(...batchResults);
    }

    // 恢复原始顺序
    return outputs.sort((a, b) => {
      const ta = tasks.find(t => t.taskId === a.taskId);
      const tb = tasks.find(t => t.taskId === b.taskId);
      return (ta?.order ?? 0) - (tb?.order ?? 0);
    });
  }

  /**
   * 执行单个任务（含重试和降级逻辑）
   */
  private async executeOneTask(task: RoleTask): Promise<RoleOutput> {
    const taskStart = performance.now();
    let currentModelId = '';
    let lastError = '';

    // 获取初始模型
    try {
      const route = this.modelRouter.route(task);
      currentModelId = route.modelId;
    } catch (e) {
      return this.makeFailedOutput(task, '', 0, String(e));
    }

    const maxAttempts = 1 + (task.maxRetries ?? this.config.defaultMaxRetries);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.callWithTimeout(task, currentModelId);
        const latency = Math.round(performance.now() - taskStart);

        // 成功：重置该模型的失败计数
        this.modelRouter.recordSuccess(currentModelId);

        return {
          taskId: task.taskId,
          roleId: task.roleId,
          roleName: task.roleName,
          content: result.text,        // 原始文本，调用方再归一化
          status: 'success',
          modelId: currentModelId,
          tokensUsed: result.tokensUsed,
          latencyMs: latency,
          raw: result.text,
          normSteps: [],
          error: '',
          timestamp: Date.now(),
        };
      } catch (e) {
        lastError = String(e);
        this.modelRouter.recordFailure(currentModelId);

        // 最后一次尝试：切降级模型
        if (attempt < maxAttempts - 1) {
          const fallback = this.modelRouter.getFallbackForRetry(currentModelId, task);
          if (fallback) {
            currentModelId = fallback;
            continue; // 用降级模型重试
          }
        }
      }
    }

    // 所有尝试均失败
    const latency = Math.round(performance.now() - taskStart);
    return this.makeFailedOutput(task, currentModelId, latency, lastError);
  }

  /**
   * 带超时的单次模型调用
   */
  private async callWithTimeout(
    task: RoleTask,
    modelId: string
  ): Promise<GenerateResult> {
    const deadline = task.deadlineMs || this.config.defaultDeadlineMs;

    const result = await Promise.race([
      this.generateCallback!(task.instruction, modelId, deadline),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`模型调用超时 (${deadline}ms)`)), deadline)
      ),
    ]);

    return result;
  }

  // ── 辅助 ─────────────────────────────────

  private makeSkippedOutput(task: RoleTask): RoleOutput {
    return {
      taskId: task.taskId, roleId: task.roleId, roleName: task.roleName,
      content: '', status: 'skipped', modelId: '', tokensUsed: 0,
      latencyMs: 0, raw: '', normSteps: ['任务被跳过'], error: '', timestamp: Date.now(),
    };
  }

  private makeFailedOutput(
    task: RoleTask, modelId: string, latencyMs: number, error: string
  ): RoleOutput {
    return {
      taskId: task.taskId, roleId: task.roleId, roleName: task.roleName,
      content: '', status: 'failed', modelId, tokensUsed: 0,
      latencyMs, raw: '', normSteps: [], error, timestamp: Date.now(),
    };
  }

  private buildReport(outputs: RoleOutput[], startTime: number): ExecutionReport {
    const totalLatency = Math.round(performance.now() - startTime);
    return {
      reportId: nowId('report'),
      sessionId: '',
      outputs,
      successCount: outputs.filter(o => o.status === 'success').length,
      failedCount: outputs.filter(o => o.status === 'failed').length,
      skippedCount: outputs.filter(o => o.status === 'skipped').length,
      totalLatencyMs: totalLatency,
      totalTokens: outputs.reduce((sum, o) => sum + o.tokensUsed, 0),
      mode: this.config.mode,
      timestamp: Date.now(),
    };
  }

  private emptyReport(startTime: number): ExecutionReport {
    return {
      reportId: nowId('report'), sessionId: '',
      outputs: [], successCount: 0, failedCount: 0, skippedCount: 0,
      totalLatencyMs: Math.round(performance.now() - startTime),
      totalTokens: 0, mode: this.config.mode, timestamp: Date.now(),
    };
  }
}
