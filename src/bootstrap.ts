/**
 * 酒馆导演插件 —— 浏览器端启动入口
 *
 * 装配所有模块并挂载到 window.TavernDirector。
 * 此文件作为 rollup IIFE 构建的入口点。
 *
 * 基于 SillyTavern 真实扩展 API:
 *   const ctx = SillyTavern.getContext();
 *   ctx.chat         → 聊天消息数组
 *   ctx.characters   → 角色对象/数组
 *   ctx.generateRaw({ systemPrompt, prompt, prefill })
 *
 * 配置持久化：
 *   settingsStore (localStorage + 导出/导入 JSON)
 *   启动时自动加载，配置变更自动保存
 */

// ─── 依赖导入 ──────────────────────────────────────────
import { AdapterFacade, adapter } from './adapters/facade';
import { DirectorFacade } from './director/facade';
import { ExecutionEngine } from './role-engine/executor';
import { normalizeOutput, normalizeOutputs, detectEcho } from './role-engine/outputNormalizer';
import { Writer, createWriter } from './role-engine/writer';
import type { WriteMessage } from './role-engine/writer';
import type { GenerateResult } from './role-engine/executor';
import { nowId, clamp, uniq, normalizeText, textContainsAny, takeLast, safeJoin, keywordHitScore } from './director/utils';
import type { UnifiedSession } from './models/session';
import { settingsStore } from './store/settingsStore';
import type { PersistedSettings } from './store/settingsStore';
import { showRoleSelector } from './ui/roleSelector';
import type { RoleOption, RoleSelectorResult } from './ui/roleSelector';
import { injectFloatingPanel } from './ui/floatingPanel';

// ═══════════════════════════════════════════════════════
// 工具函数（跨模块共享）
// ═══════════════════════════════════════════════════════
const U = {
  nowId, clamp, uniq,
  norm: normalizeText,
  hasWord: textContainsAny,
  takeLast, join: safeJoin,
  kwScore: keywordHitScore,
  esc(s: string): string {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};

// ═══════════════════════════════════════════════════════
// SillyTavern 全局对象获取（兼容两种挂载名）
// ═══════════════════════════════════════════════════════
function getST(): any {
  return (window as any).SillyTavern || (window as any).ST || null;
}

function getSTContext(): any {
  const st = getST();
  if (!st || typeof st.getContext !== 'function') {
    throw new Error(
      '[TavernDirector] SillyTavern.getContext() 不可用。请确认插件在酒馆环境中正确加载。'
    );
  }
  return st.getContext();
}

// ═══════════════════════════════════════════════════════
// 导演调度层装配
// ═══════════════════════════════════════════════════════
const director = new DirectorFacade();

// ═══════════════════════════════════════════════════════
// 角色执行层装配（配置从 settingsStore 加载）
// ═══════════════════════════════════════════════════════
const engine = new ExecutionEngine(settingsStore.toExecutionConfig());

// ─── 注册生成回调（对接真实 ST generateRaw） ────────────
engine.setGenerateCallback(async (
  prompt: string,
  _modelId: string,
  _timeoutMs: number
): Promise<GenerateResult> => {
  const startTime = performance.now();
  const ctx = getSTContext();

  // 使用 SillyTavern 官方 generateRaw API
  // modelId 由 ST 内部当前选中的模型决定，此处不传 modelId
  let result: any;
  if (typeof ctx.generateRaw === 'function') {
    // generateRaw 接收 { systemPrompt?, prompt, prefill? }
    // prompt 已由 director/promptAssembler 组装好（含 jailbreak 等）
    result = await ctx.generateRaw({ prompt });
  } else {
    throw new Error(
      '[TavernDirector] ctx.generateRaw 不可用。请确认酒馆版本支持此 API。'
    );
  }

  // generateRaw 可能返回字符串或 {text, response, ...}
  const text: string =
    typeof result === 'string'
      ? result
      : (result?.text || result?.response || '');

  return {
    text,
    tokensUsed: Math.ceil(text.length / 2.5), // 粗略估算
    latencyMs: Math.round(performance.now() - startTime),
  };
});

// ─── 注册回写回调（把生成结果写入 ST 聊天流） ──────────
const writer = createWriter();

writer.setWriteCallback(async (msg: WriteMessage): Promise<void> => {
  const ctx = getSTContext();

  // 构造兼容 SillyTavern 内部格式的消息对象
  const chatMsg: Record<string, unknown> = {
    name: msg.speaker,
    is_user: false,
    is_system: msg.isDirectorMessage || msg.role === 'system',
    mes: msg.content,
    send_date: msg.timestamp,
    // 附加元数据，方便调试 / 后续处理
    extra: {
      modelId: msg.modelId,
      tokensUsed: msg.tokensUsed,
      latencyMs: msg.latencyMs,
      tavernDirector: true,
      messageId: msg.id,
    },
  };

  // 写入 context.chat
  if (Array.isArray(ctx.chat)) {
    ctx.chat.push(chatMsg);
  } else {
    console.warn(
      '[TavernDirector] ctx.chat 不是数组，无法追加消息。消息内容：',
      msg.content.slice(0, 100)
    );
  }

  // 触发 ST 的 UI 更新 / 保存机制
  // 尝试顺序：1) ST 原生 eventSource.emit（官方文档确认）
  //           2) DOM CustomEvent（部分版本兼容）
  //           3) DOM Event（旧版兼容）
  try {
    // 优先使用 ST 原生事件系统
    if (typeof ctx.eventSource?.emit === 'function') {
      ctx.eventSource.emit('chatChanged', chatMsg);
      ctx.eventSource.emit('messageAdded', chatMsg);
    }
    // DOM 事件作为补充
    window.dispatchEvent(new CustomEvent('tavern-director:message-added', {
      detail: chatMsg,
    }));
    window.dispatchEvent(new Event('chatChanged'));
  } catch {
    /* 静默——事件触发失败不影响消息已写入 chat 数组的事实 */
  }
});

// ═══════════════════════════════════════════════════════
// 配置同步：监听 settingsStore 变更 → 更新 engine
// ═══════════════════════════════════════════════════════
const settingsUnsubscribe = settingsStore.subscribe((_s: PersistedSettings) => {
  engine.getModelRouter().updateConfig(settingsStore.toModelRouteConfig());
});

// ═══════════════════════════════════════════════════════
// Session 增强：将持久化配置注入会话
// ═══════════════════════════════════════════════════════
function enrichSession(original: UnifiedSession): UnifiedSession {
  const s = settingsStore.getRaw();

  // 浅拷贝，避免污染适配器缓存的原始 session
  const session: UnifiedSession = {
    ...original,
    settings: { ...original.settings },
    jailbreak: { ...original.jailbreak },
    characters: original.characters,
    messages: original.messages,
    worldBooks: original.worldBooks.map(wb => ({ ...wb })),
    sourceMeta: { ...original.sourceMeta },
  };

  // 注入角色模型映射
  session.settings.roleModels = { ...s.roleModels };
  session.settings.directorModel = s.directorModel;
  session.settings.dialogueMode = s.mode;

  // 注入自定义破限（如果用户配置了）
  if (s.jailbreakText && !session.jailbreak.text) {
    session.jailbreak = {
      text: s.jailbreakText,
      source: 'plugin-config',
      enabled: true,
      name: s.jailbreakName || '自定义破限',
    };
  }

  // 注入世界书绑定
  const bindings = s.worldbookBindings;
  if (Object.keys(bindings).length > 0) {
    for (const wb of session.worldBooks) {
      const boundRoles = bindings[wb.id];
      if (boundRoles) {
        (wb as any)._boundRoleIds = boundRoles;
      }
    }
  }

  return session;
}

// ═══════════════════════════════════════════════════════
// 统一对外 API
// ═══════════════════════════════════════════════════════
const API = {
  version: '2.0.0',
  adapter,
  director,
  executor: engine,
  writer,
  utils: U,
  settings: settingsStore,

  // ── 角色选择器 ────────────────────────
  /** 弹出角色选择弹层（替代 prompt()） */
  promptRole: showRoleSelector,

  // ── 快捷方法（保持与旧版兼容） ────────
  getSnapshot: () => adapter.getCurrentSession() || adapter.readFromTavern(),
  getSummary: () => adapter.getSummary(),
  startLiveMode: (cb: (s: any) => void, ms?: number) =>
    adapter.watchTavern(cb, ms || settingsStore.getRaw().pollIntervalMs),
  stopLiveMode: () => adapter.stopWatching(),

  quickPlan: (session: UnifiedSession, opts?: Record<string, unknown>) =>
    director.planTurn({ session: enrichSession(session), ...opts }),
  autoPlan: (opts?: Record<string, unknown>) => {
    const session = adapter.getCurrentSession() || adapter.readFromTavern();
    if (!session) return null;
    return director.planTurn({ session: enrichSession(session), ...opts });
  },

  /** 让用户从角色列表中选择谁来发言 */
  async selectSpeakers(options?: {
    title?: string;
    multi?: boolean;
    maxSelect?: number;
  }): Promise<RoleSelectorResult | null> {
    const session = adapter.getCurrentSession() || adapter.readFromTavern();
    if (!session) {
      console.warn('[TavernDirector] selectSpeakers: 没有可用会话');
      return null;
    }

    const roles: RoleOption[] = session.characters.map(c => ({
      id: c.id,
      name: c.name,
      displayName: c.displayName || c.name,
      avatar: c.avatar || '',
      description: c.description?.slice(0, 80) || '',
      disabled: false,
      tag: settingsStore.getRaw().roleModels[c.id] || '',
    }));

    return showRoleSelector({
      title: options?.title || '选择发言角色',
      roles,
      multi: options?.multi !== false,
      maxSelect: options?.maxSelect || 8,
      confirmLabel: '开始生成',
      searchPlaceholder: '搜索角色...',
    });
  },

  /** 全自动：读取 → 调度 → 执行 → 回写 */
  async fullAuto(options?: Record<string, unknown>) {
    const session = adapter.getCurrentSession() || adapter.readFromTavern();
    if (!session) throw new Error('未连接酒馆');
    const enriched = enrichSession(session);
    const plan = director.planTurn({ session: enriched, ...options });
    const tasks = buildTasksFromPlan(plan, enriched);
    const report = await engine.execute(tasks);
    // 归一化输出
    const roleNames = enriched.characters.map((c) => c.displayName);
    report.outputs = normalizeOutputs(report.outputs, { roleNames });
    // 回写（writeReport 内部调用 setWriteCallback 注册的回调）
    await writer.writeReport(
      report,
      enriched.messages.length,
      plan.config.mode === 'parallel' ? 'parallel' : 'sequential'
    );
    writer.notifyUI(report);
    return { session: enriched, plan, report };
  },

  // ── 配置快捷方法 ──────────────────────
  /** 设置角色的模型 */
  setRoleModel(roleId: string, modelId: string) {
    settingsStore.setRoleModel(roleId, modelId);
  },
  /** 设置默认模型 */
  setDefaultModel(modelId: string) {
    settingsStore.updateModelRoute({ defaultModel: modelId });
  },
  /** 设置导演模型 */
  setDirectorModel(modelId: string) {
    settingsStore.updateModelRoute({ directorModel: modelId });
  },
  /** 设置降级模型链 */
  setFallbackModels(models: string[]) {
    settingsStore.updateModelRoute({ fallbackModels: models });
  },
  /** 设置自定义破限 */
  setJailbreak(text: string, name?: string) {
    settingsStore.setJailbreak(text, name);
  },
  /** 设置世界书绑定 */
  setWorldbookBinding(entryId: string, roleIds: string[]) {
    settingsStore.setWorldbookBinding(entryId, roleIds);
  },
  /** 导出配置为 JSON 字符串 */
  exportConfig(): string {
    return settingsStore.exportJSON();
  },
  /** 从 JSON 字符串导入配置 */
  importConfig(json: string): { success: boolean; message: string } {
    return settingsStore.importJSON(json);
  },
  /** 重置所有配置 */
  resetConfig() {
    settingsStore.reset();
  },
};

// ═══════════════════════════════════════════════════════
// 辅助：从 plan 构建 RoleTask 列表
// ═══════════════════════════════════════════════════════
function buildTasksFromPlan(
  plan: ReturnType<typeof director.planTurn>,
  session: UnifiedSession
) {
  const tasks: any[] = [];
  const now = Date.now();

  for (const payload of plan.payloads || []) {
    const ctx = payload.context || {};
    const role = (session.characters || []).find(
      (c) => c.id === payload.roleId
    );

    tasks.push({
      taskId: `task_${payload.roleId}_${now}`,
      sessionId: session.sessionId,
      roleId: payload.roleId,
      roleName: payload.roleName,
      order: payload.orderIndex != null ? payload.orderIndex : 0,
      mode: plan.config.mode || 'sequential',
      status: 'pending',
      modelId: payload.model || settingsStore.getRaw().roleModels[payload.roleId] || '',
      context: {
        character: role || (ctx as any).role || {},
        publicMessages: (ctx as any).visibleMessages || [],
        relevantWorldBooks: (ctx as any).selectedWorldBooks || [],
        jailbreak: session.jailbreak ? session.jailbreak.text : '',
        directorNote: (ctx as any).directorNote || '',
        sessionSummary: (ctx as any).publicSummary || '',
        hiddenRoleIds: [] as string[],
        sceneInfo: '',
      },
      instruction: payload.prompt || '',
      constraints: [] as string[],
      deadlineMs: settingsStore.getRaw().defaultDeadlineMs,
      maxRetries: settingsStore.getRaw().defaultMaxRetries,
      retryCount: 0,
      createdAt: now,
    });
  }
  return tasks;
}

// ═══════════════════════════════════════════════════════
// 挂载到全局
// ═══════════════════════════════════════════════════════
if (typeof window !== 'undefined') {
  (window as any).TavernDirector = API;

  // ── 注册为 SillyTavern 插件 ──
  const st = getST();
  const pluginMeta = {
    name: 'TavernDirector',
    version: '2.0.0',
    onLoad() {
      console.log('[TavernDirector] ✅ 已加载');

      // 自动开始监听（如果用户配置了）
      if (settingsStore.getRaw().autoStart) {
        console.log('[TavernDirector] 自动开始监听...');
        adapter.watchTavern(
          (session) => {
            // 静默缓存最新会话，等待用户通过 UI 按钮触发操作
            (window as any).__tdLastAutoSession = session;
          },
          settingsStore.getRaw().pollIntervalMs
        );
      }
    },
    onUnload() {
      adapter.stopWatching();
      settingsUnsubscribe();
      console.log('[TavernDirector] 已卸载');
    },
  };

  if (st) {
    if (typeof (st as any).registerPlugin === 'function') {
      (st as any).registerPlugin(pluginMeta);
    } else if (typeof (st as any).addPlugin === 'function') {
      (st as any).addPlugin(pluginMeta);
    }
  }

  console.log('[TavernDirector] v2.0.0 就绪');
  console.log('[TavernDirector] 适配器 ✅ | 导演 ✅ | 执行 ✅ | 回写 ✅ | 配置 ✅ | 角色选择器 ✅');
  console.log('[TavernDirector] 基于 SillyTavern.getContext() 真实 API');
  console.log('[TavernDirector] 配置持久化：localStorage（' +
    (settingsStore.getRaw().defaultModel ? '已加载' : '首次运行') +
    '）');

  // 注入浮动控制台（body retry 机制内置）
  injectFloatingPanel();
}
