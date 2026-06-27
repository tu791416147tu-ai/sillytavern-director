/**
 * 插件配置持久化 —— localStorage + JSON 导出/导入
 *
 * 设计决策（多方案对比）：
 *
 * 1. 存储后端选择：
 *    | 方案                     | 刷新保留 | 换端口不丢 | 可备份 | 复杂度 |
 *    |--------------------------|:------:|:--------:|:----:|------|
 *    | localStorage             | ✅     | ❌       | 手动  | 低    |
 *    | localStorage + 导出/导入 | ✅     | ✅ (手动) | ✅   | 中    |
 *    | ST extension_settings    | ?      | ?        | ?    | API 不确定 |
 *    | IndexedDB                | ✅     | ❌       | 手动  | 高（无收益）|
 *    | Cookie                   | ✅     | ❌       | 手动  | 4KB 太小 |
 *
 *    ✅ 选 localStorage + 导出/导入：
 *      - localStorage 覆盖 95% 场景（页面刷新、ST 重启）
 *      - 导出/导入 JSON 解决换端口/清缓存后的恢复
 *      - ST 插件圈最常用的方案，用户预期一致
 *      - 零外部依赖，可在任何浏览器环境运行
 *
 * 2. 存储 key 命名：
 *    - 使用 `tavern_director_settings_v1` 而非纯 `tavern_director_settings`
 *    - 版本号后缀允许未来做 schema 迁移时共存旧数据
 *
 * 3. 数据校验：
 *    - 每次 load() 后做基本结构校验
 *    - 校验失败返回默认值并 warn，不抛错（插件必须能在无配置时正常工作）
 *
 * 4. 敏感数据：
 *    - API Key 不做加密（ST 运行在 localhost，物理访问 = 已沦陷）
 *    - 导出 JSON 时提醒用户文件含敏感信息
 */

import type { ExecutionConfig, ModelRouteConfig } from '../role-engine/types';

// ─── 配置版本号 ──────────────────────────────────────
const CURRENT_VERSION = 1;

// ─── localStorage key ────────────────────────────────
const STORAGE_KEY = 'tavern_director_settings_v1';

// ─── 持久化的配置结构 ───────────────────────────────

export interface PersistedSettings {
  /** Schema 版本（用于未来迁移） */
  version: number;

  // ── 执行配置 ────────────────────────────
  /** 执行模式 */
  mode: 'sequential' | 'parallel';
  /** 默认超时（毫秒） */
  defaultDeadlineMs: number;
  /** 默认最大重试次数 */
  defaultMaxRetries: number;
  /** 并发上限 */
  maxConcurrency: number;

  // ── 模型路由 ────────────────────────────
  /** 默认模型（全局兜底） */
  defaultModel: string;
  /** 导演专用模型 */
  directorModel: string;
  /** 角色→模型映射 { roleId: modelId } */
  roleModels: Record<string, string>;
  /** 降级模型链 */
  fallbackModels: string[];
  /** 任务级模型覆盖 */
  taskOverrides: Record<string, string>;

  // ── 破限 ────────────────────────────────
  /** 自定义破限文本（覆盖角色卡/ST 预设） */
  jailbreakText: string;
  /** 破限名称 */
  jailbreakName: string;

  // ── 世界书绑定 ──────────────────────────
  /** 世界书条目 → 角色列表 { entryId: [roleId, ...] } */
  worldbookBindings: Record<string, string[]>;

  // ── 界面偏好 ────────────────────────────
  /** 自动开始监听 */
  autoStart: boolean;
  /** 轮询间隔（毫秒） */
  pollIntervalMs: number;
}

// ─── 默认配置 ───────────────────────────────────────

export function createDefaultSettings(): PersistedSettings {
  return {
    version: CURRENT_VERSION,

    mode: 'sequential',
    defaultDeadlineMs: 30000,
    defaultMaxRetries: 2,
    maxConcurrency: 4,

    defaultModel: '',
    directorModel: '',
    roleModels: {},
    fallbackModels: [],
    taskOverrides: {},

    jailbreakText: '',
    jailbreakName: '',

    worldbookBindings: {},

    autoStart: false,
    pollIntervalMs: 2000,
  };
}

// ─── SettingsStore 类 ───────────────────────────────

export class SettingsStore {
  private settings: PersistedSettings;
  private listeners: Set<(s: PersistedSettings) => void> = new Set();

  constructor() {
    this.settings = this.load();
  }

  // ═══════════════════════════════════════════════════
  // 持久化
  // ═══════════════════════════════════════════════════

  /**
   * 从 localStorage 加载配置。
   * 数据损坏或缺失时返回默认值。
   */
  load(): PersistedSettings {
    try {
      if (typeof localStorage === 'undefined') {
        console.warn('[SettingsStore] localStorage 不可用，使用默认配置');
        return createDefaultSettings();
      }

      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        console.log('[SettingsStore] 首次运行，使用默认配置');
        return createDefaultSettings();
      }

      const parsed = JSON.parse(raw);

      // 基本结构校验
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('配置数据格式无效');
      }

      // 版本迁移（未来扩展）
      if (parsed.version !== CURRENT_VERSION) {
        console.log(
          `[SettingsStore] 配置版本 ${parsed.version} → ${CURRENT_VERSION}，执行迁移`
        );
        return this.migrate(parsed);
      }

      // 合并默认值（填充新增字段）
      const defaults = createDefaultSettings();
      const merged = { ...defaults, ...parsed };

      return merged;
    } catch (e) {
      console.warn('[SettingsStore] 加载配置失败，使用默认值:', e);
      return createDefaultSettings();
    }
  }

  /**
   * 保存配置到 localStorage。
   */
  save(): boolean {
    try {
      if (typeof localStorage === 'undefined') {
        console.warn('[SettingsStore] localStorage 不可用，配置未保存');
        return false;
      }

      this.settings.version = CURRENT_VERSION;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings, null, 2));
      console.log('[SettingsStore] 配置已保存');
      return true;
    } catch (e) {
      console.error('[SettingsStore] 保存配置失败:', e);
      return false;
    }
  }

  /**
   * 导出配置为 JSON 字符串（供下载/备份）。
   */
  exportJSON(): string {
    const copy = { ...this.settings };
    copy.version = CURRENT_VERSION;
    return JSON.stringify(copy, null, 2);
  }

  /**
   * 从 JSON 字符串导入配置。
   * 导入后自动保存。
   */
  importJSON(json: string): { success: boolean; message: string } {
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== 'object') {
        return { success: false, message: 'JSON 格式无效：不是有效的对象' };
      }

      const defaults = createDefaultSettings();
      const merged = { ...defaults, ...parsed, version: CURRENT_VERSION };
      this.settings = this.validateAndFix(merged);
      this.save();
      this.notify();

      return { success: true, message: '配置导入成功' };
    } catch (e) {
      return { success: false, message: `导入失败: ${String(e)}` };
    }
  }

  /**
   * 重置为默认配置。
   * 重置后自动保存。
   */
  reset(): void {
    this.settings = createDefaultSettings();
    this.save();
    this.notify();
    console.log('[SettingsStore] 配置已重置为默认值');
  }

  // ═══════════════════════════════════════════════════
  // 读取
  // ═══════════════════════════════════════════════════

  getSettings(): PersistedSettings {
    return { ...this.settings };
  }

  /** 获取精简版（不可变），防止外部误改 */
  getRaw(): Readonly<PersistedSettings> {
    // 返回深层拷贝，防止外部代码绕过 setter 直接修改内部状态
    return JSON.parse(JSON.stringify(this.settings));
  }

  // ═══════════════════════════════════════════════════
  // 分段更新（只改部分字段，自动保存）
  // ═══════════════════════════════════════════════════

  /**
   * 更新执行/路由配置
   */
  updateExecutionConfig(partial: Partial<{
    mode: 'sequential' | 'parallel';
    defaultDeadlineMs: number;
    defaultMaxRetries: number;
    maxConcurrency: number;
  }>): void {
    Object.assign(this.settings, partial);
    this.save();
    this.notify();
  }

  /**
   * 更新模型路由配置
   */
  updateModelRoute(partial: Partial<{
    defaultModel: string;
    directorModel: string;
    fallbackModels: string[];
    taskOverrides: Record<string, string>;
  }>): void {
    if (partial.defaultModel !== undefined) this.settings.defaultModel = partial.defaultModel;
    if (partial.directorModel !== undefined) this.settings.directorModel = partial.directorModel;
    if (partial.fallbackModels !== undefined) this.settings.fallbackModels = partial.fallbackModels;
    if (partial.taskOverrides !== undefined) this.settings.taskOverrides = partial.taskOverrides;
    this.save();
    this.notify();
  }

  /**
   * 设置角色专属模型
   */
  setRoleModel(roleId: string, modelId: string): void {
    this.settings.roleModels[roleId] = modelId;
    this.save();
    this.notify();
  }

  /**
   * 删除角色模型绑定
   */
  removeRoleModel(roleId: string): void {
    delete this.settings.roleModels[roleId];
    this.save();
    this.notify();
  }

  /**
   * 批量设置角色模型映射
   */
  setRoleModels(map: Record<string, string>): void {
    this.settings.roleModels = { ...map };
    this.save();
    this.notify();
  }

  /**
   * 设置破限文本
   */
  setJailbreak(text: string, name?: string): void {
    this.settings.jailbreakText = text;
    if (name !== undefined) this.settings.jailbreakName = name;
    this.save();
    this.notify();
  }

  /**
   * 设置世界书绑定
   */
  setWorldbookBinding(entryId: string, roleIds: string[]): void {
    if (roleIds.length === 0) {
      delete this.settings.worldbookBindings[entryId];
    } else {
      this.settings.worldbookBindings[entryId] = [...roleIds];
    }
    this.save();
    this.notify();
  }

  /**
   * 批量设置世界书绑定
   */
  setWorldbookBindings(bindings: Record<string, string[]>): void {
    this.settings.worldbookBindings = { ...bindings };
    this.save();
    this.notify();
  }

  /**
   * 获取世界书绑定
   */
  getWorldbookBindings(): Record<string, string[]> {
    return { ...this.settings.worldbookBindings };
  }

  /**
   * 更新界面偏好
   */
  updateUIPrefs(partial: { autoStart?: boolean; pollIntervalMs?: number }): void {
    if (partial.autoStart !== undefined) this.settings.autoStart = partial.autoStart;
    if (partial.pollIntervalMs !== undefined) this.settings.pollIntervalMs = partial.pollIntervalMs;
    this.save();
    this.notify();
  }

  // ═══════════════════════════════════════════════════
  // 派生：生成 ExecutionConfig
  // ═══════════════════════════════════════════════════

  /**
   * 从持久化配置生成 ExecutionConfig（供 ExecutionEngine 使用）
   */
  toExecutionConfig(): ExecutionConfig {
    return {
      mode: this.settings.mode,
      defaultDeadlineMs: this.settings.defaultDeadlineMs,
      defaultMaxRetries: this.settings.defaultMaxRetries,
      maxConcurrency: this.settings.maxConcurrency,
      modelRoute: this.toModelRouteConfig(),
    };
  }

  /**
   * 从持久化配置生成 ModelRouteConfig
   */
  toModelRouteConfig(): ModelRouteConfig {
    return {
      defaultModel: this.settings.defaultModel,
      roleModels: { ...this.settings.roleModels },
      fallbackModels: [...this.settings.fallbackModels],
      directorModel: this.settings.directorModel,
      taskOverrides: { ...this.settings.taskOverrides },
    };
  }

  // ═══════════════════════════════════════════════════
  // 变更监听
  // ═══════════════════════════════════════════════════

  /**
   * 订阅配置变更。返回取消订阅函数。
   */
  subscribe(listener: (s: PersistedSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ═══════════════════════════════════════════════════
  // 内部
  // ═══════════════════════════════════════════════════

  private notify(): void {
    const snap = this.getSettings();
    this.listeners.forEach(fn => {
      try { fn(snap); } catch { /* 隔离监听器异常 */ }
    });
  }

  /**
   * 版本迁移入口（当前仅 v1，未来扩展）
   */
  private migrate(old: Record<string, unknown>): PersistedSettings {
    const defaults = createDefaultSettings();
    // v0 → v1: 无旧数据需要转换，直接合并
    const merged = { ...defaults, ...old, version: CURRENT_VERSION };
    return this.validateAndFix(merged);
  }

  /**
   * 校验并修复配置中的非法值
   */
  private validateAndFix(settings: PersistedSettings): PersistedSettings {
    const fixed = { ...settings };
    if (fixed.defaultDeadlineMs < 1000) fixed.defaultDeadlineMs = 30000;
    if (fixed.defaultDeadlineMs > 300000) fixed.defaultDeadlineMs = 300000;
    if (fixed.defaultMaxRetries < 0) fixed.defaultMaxRetries = 0;
    if (fixed.defaultMaxRetries > 10) fixed.defaultMaxRetries = 10;
    if (fixed.maxConcurrency < 1) fixed.maxConcurrency = 1;
    if (fixed.maxConcurrency > 16) fixed.maxConcurrency = 16;
    if (fixed.pollIntervalMs < 500) fixed.pollIntervalMs = 2000;
    if (fixed.pollIntervalMs > 30000) fixed.pollIntervalMs = 30000;
    if (!fixed.mode || !['sequential', 'parallel'].includes(fixed.mode)) {
      fixed.mode = 'sequential';
    }
    return fixed;
  }
}

// ─── 全局单例 ──────────────────────────────────────

export const settingsStore = new SettingsStore();
