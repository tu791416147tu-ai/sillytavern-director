/**
 * Writer —— 回写适配器
 *
 * 把角色执行结果写回聊天系统和 UI。
 *
 * 设计决策：
 *
 * 1. 回写目标：
 *    - 方案A：直接写 ST 全局状态 → 简单但绕过 ST 的消息管理
 *    - 方案B：通过回调注入，由插件层决定写到哪里 → 解耦
 *    ✅ 选B：WriteCallback 让 writer 不关心目标是 ST/内部缓存/文件
 *
 * 2. 回写时机：
 *    - 方案A：每个角色生成完立即回写 → 实时但顺序模式下后发言的角色看不到前者的内容
 *    - 方案B：全部生成完后统一回写 → 一致但延迟
 *    - 方案C：顺序模式逐条回写，并行模式统一回写 → 因地制宜
 *    ✅ 选C：顺序模式时每个角色应看到前者的输出，所以逐条回写；
 *       并行模式时所有角色基于同一快照，统一回写更合理
 *
 * 3. 写回内容格式：
 *    - 方案A：只写纯文本 → 丢信息
 *    - 方案B：写 Message 对象 + 元数据 → 完整可追踪
 *    ✅ 选B：附带 modelId/tokens/latency 等元数据，方便调试和日志
 */

import type { RoleOutput, ExecutionReport } from './types';
import type { Message, MessageRole } from '../models/message';

// ─── 回写回调类型 ─────────────────────────────────────

/**
 * 单条消息回写回调
 *
 * 每次角色生成完成后调用。
 * 插件层实现此回调来决定写到哪里（ST 聊天流 / 内部缓存 / 文件）。
 */
export type WriteCallback = (message: WriteMessage) => Promise<void>;

/**
 * 批量回写完成后的回调
 */
export type WriteCompleteCallback = (report: ExecutionReport) => void;

// ─── 回写消息结构 ─────────────────────────────────────

export interface WriteMessage {
  /** 消息 ID */
  id: string;
  /** 角色 */
  role: MessageRole;
  /** 发言者名 */
  speaker: string;
  /** 消息内容 */
  content: string;
  /** 轮次 */
  turnIndex: number;
  /** 时间戳 */
  timestamp: number;
  /** 可见性 */
  visible: boolean;
  /** 使用的模型 */
  modelId: string;
  /** token 用量 */
  tokensUsed: number;
  /** 耗时 */
  latencyMs: number;
  /** 是否来自导演（系统消息） */
  isDirectorMessage: boolean;
}

// ─── Writer 类 ────────────────────────────────────────

export class Writer {
  private writeCallback: WriteCallback | null = null;
  private completeCallback: WriteCompleteCallback | null = null;

  /**
   * 设置回写回调
   */
  setWriteCallback(callback: WriteCallback): void {
    this.writeCallback = callback;
  }

  /**
   * 设置完成回调
   */
  setCompleteCallback(callback: WriteCompleteCallback): void {
    this.completeCallback = callback;
  }

  /**
   * 写入单条角色输出
   */
  async writeOne(output: RoleOutput, turnIndex: number): Promise<WriteMessage | null> {
    if (!this.writeCallback) return null;

    const msg: WriteMessage = {
      id: `role_${output.taskId}_${Date.now()}`,
      role: 'character' as MessageRole,
      speaker: output.roleName,
      content: output.content,
      turnIndex,
      timestamp: Date.now(),
      visible: true,
      modelId: output.modelId,
      tokensUsed: output.tokensUsed,
      latencyMs: output.latencyMs,
      isDirectorMessage: false,
    };

    await this.writeCallback(msg);
    return msg;
  }

  /**
   * 写入导演决策消息
   */
  async writeDirectorNote(
    note: string,
    turnIndex: number,
    modelId = ''
  ): Promise<WriteMessage | null> {
    if (!this.writeCallback) return null;

    const msg: WriteMessage = {
      id: `director_${Date.now()}`,
      role: 'system',
      speaker: '🎬 导演',
      content: note,
      turnIndex,
      timestamp: Date.now(),
      visible: true,
      modelId,
      tokensUsed: 0,
      latencyMs: 0,
      isDirectorMessage: true,
    };

    await this.writeCallback(msg);
    return msg;
  }

  /**
   * 构造失败消息对象（供 writeReport 内部使用）
   */
  private makeFailMessage(output: RoleOutput, turnIndex: number): WriteMessage {
    return {
      id: `fail_${output.taskId}`,
      role: 'system',
      speaker: '⚠️ 系统',
      content: `角色 "${output.roleName}" 生成失败: ${output.error || '未知错误'}`,
      turnIndex,
      timestamp: Date.now(),
      visible: true,
      modelId: output.modelId,
      tokensUsed: 0,
      latencyMs: output.latencyMs,
      isDirectorMessage: false,
    };
  }

  /**
   * 按模式写入整批结果
   *
   * 顺序模式：逐条写入（后面的角色能看到前面的输出）
   * 并行模式：统一批量写入
   */
  async writeReport(
    report: ExecutionReport,
    baseTurnIndex: number,
    mode: 'sequential' | 'parallel'
  ): Promise<WriteMessage[]> {
    const written: WriteMessage[] = [];
    const successes = report.outputs.filter(o => o.status === 'success');

    if (mode === 'sequential') {
      // 逐条写入，按报告中的实际位置递增 turnIndex（含失败和成功）
      let turnOffset = 0;
      for (const output of report.outputs) {
        if (output.status === 'success') {
          const msg = await this.writeOne(output, baseTurnIndex + turnOffset);
          if (msg) written.push(msg);
          turnOffset++;
        } else if (output.status === 'failed') {
          const failMsg = this.makeFailMessage(output, baseTurnIndex + turnOffset);
          if (this.writeCallback) {
            await this.writeCallback(failMsg);
            written.push(failMsg);
          }
          turnOffset++;
        }
        // skipped 不占 turnIndex
      }
    } else {
      // 并行模式：所有成功输出同一 turnIndex
      for (const output of successes) {
        const msg = await this.writeOne(output, baseTurnIndex);
        if (msg) written.push(msg);
      }
      // 失败消息用 baseTurnIndex（并行模式下所有输出同一轮）
      const failures = report.outputs.filter(o => o.status === 'failed');
      for (const failed of failures) {
        const failMsg = this.makeFailMessage(failed, baseTurnIndex);
        if (this.writeCallback) {
          await this.writeCallback(failMsg);
          written.push(failMsg);
        }
      }
    }

    // 触发完成回调
    this.completeCallback?.(report);

    return written;
  }

  /**
   * 更新 UI 日志（通过 window 事件）
   */
  notifyUI(report: ExecutionReport): void {
    try {
      window.dispatchEvent(new CustomEvent('tavern-director:execution-complete', {
        detail: {
          successCount: report.successCount,
          failedCount: report.failedCount,
          skippedCount: report.skippedCount,
          totalLatencyMs: report.totalLatencyMs,
          totalTokens: report.totalTokens,
          outputs: report.outputs.map(o => ({
            roleName: o.roleName,
            content: o.content.slice(0, 100),
            status: o.status,
            modelId: o.modelId,
          })),
        },
      }));
    } catch {
      // 静默失败（不在浏览器环境）
    }
  }
}

// ─── 工厂 ─────────────────────────────────────────────

export function createWriter(
  writeCallback?: WriteCallback,
  completeCallback?: WriteCompleteCallback
): Writer {
  const w = new Writer();
  if (writeCallback) w.setWriteCallback(writeCallback);
  if (completeCallback) w.setCompleteCallback(completeCallback);
  return w;
}
