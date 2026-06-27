/**
 * TavernLiveLoader —— 从酒馆当前页面实时读取会话状态
 *
 * 读取范围：
 *  - 当前聊天记录
 *  - 当前角色卡
 *  - 当前世界书（从角色扩展数据 / 全局 WI）
 *  - 当前系统提示/破限
 *  - 群聊成员
 *
 * 基于 SillyTavern 真实扩展 API: SillyTavern.getContext()
 *
 * 官方文档确认的 context 字段：
 *   context.chat         → 聊天消息数组
 *   context.characters   → 角色对象/数组
 *   context.generateRaw({systemPrompt, prompt, prefill})
 *
 * World Info（世界书）和 Preset（预设破限）没有独立的 getter 方法，
 * 需要通过以下路径尝试获取：
 *   - 世界书：context.worldInfo / character.data.extensions.world_info
 *   - 破限：   context.preset / character.system_prompt / 角色卡内置 prompt
 *   - 聊天 ID：context.chatId / context.characterId
 */

import { RawSourceData, createEmptyRawData } from './rawTypes';

// ─── SillyTavern 全局类型声明 ──────────────────────────
declare global {
  interface Window {
    SillyTavern?: STGlobal;
    ST?: STGlobal;
  }
}

interface STGlobal {
  getContext(): STContext;
}

/**
 * SillyTavern getContext() 返回的上下文对象。
 *
 * chat / characters 两个字段由官方扩展文档确认；
 * 其余字段根据 ST 源码结构推断，均为 optional。
 */
interface STContext {
  /** 聊天消息数组（官方确认） */
  chat?: STChatMessage[];
  /** 角色映射表/数组（官方确认） */
  characters?: Record<string, STCharacter> | STCharacter[];
  /** 当前聊天/角色 ID */
  chatId?: string;
  characterId?: string;
  /** 群聊 ID */
  groupId?: string;
  /** 世界书条目 */
  worldInfo?: STWorldInfo;
  /** 会话元数据 */
  chatMetadata?: Record<string, unknown>;
  /** 角色名（1v1 对话） */
  name1?: string;
  name2?: string;
  /** 生成接口 */
  generateRaw?: (params: STGenerateParams) => Promise<STGenerateResult>;
  generateQuietPrompt?: (params: STQuietPromptParams) => Promise<string>;
  /** 其它未声明字段 */
  [key: string]: unknown;
}

interface STGenerateParams {
  systemPrompt?: string;
  prompt: string;
  prefill?: string;
  [key: string]: unknown;
}

interface STGenerateResult {
  text?: string;
  response?: string;
  [key: string]: unknown;
}

interface STQuietPromptParams {
  quietPrompt: string;
  [key: string]: unknown;
}

interface STChatMessage {
  /** 发言者名 */
  name?: string;
  /** 是否为用户发言 */
  is_user?: boolean;
  /** 是否为系统消息 */
  is_system?: boolean;
  /** 消息正文 */
  mes?: string;
  /** 时间戳 */
  send_date?: number;
  /** 滑动条 */
  swipes?: string[];
  swipe_id?: number;
  /** 扩展数据 */
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

interface STCharacter {
  name?: string;
  display_name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  system_prompt?: string;
  avatar?: string;
  data?: STCharacterData;
  [key: string]: unknown;
}

interface STCharacterData {
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

interface STWorldInfo {
  entries?: Record<string, STWorldInfoEntry>;
  [key: string]: unknown;
}

interface STWorldInfoEntry {
  uid?: number;
  key?: string;
  secondary_keys?: string;
  content?: string;
  comment?: string;
  depth?: number;
  selective?: boolean;
  constant?: boolean;
  position?: string;
  order?: number;
  scan_depth?: number;
  [key: string]: unknown;
}

// ─── 工具函数 ─────────────────────────────────────────

function safeGet<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * 获取 ST 全局对象（兼容两种挂载名）
 */
function getST(): STGlobal | null {
  return window.SillyTavern || window.ST || null;
}

// ─── 主 Loader ────────────────────────────────────────

export class TavernLiveLoader {
  private lastSnapshot: RawSourceData | null = null;
  private watchInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * 从酒馆当前页面读取完整会话状态
   */
  read(): RawSourceData {
    const st = getST();
    if (!st) {
      throw new Error(
        '[TavernLiveLoader] 未检测到 SillyTavern 全局对象。请确认插件已正确加载到酒馆页面。'
      );
    }

    const ctx: STContext = safeGet(() => st.getContext(), {} as STContext);
    if (!ctx || typeof ctx !== 'object') {
      throw new Error(
        '[TavernLiveLoader] SillyTavern.getContext() 返回了无效值。请确认酒馆已在页面中正确初始化。'
      );
    }

    const raw = createEmptyRawData('tavern-live');

    // ── 聊天 ID ──────────────────────────────
    raw.extras.currentChatId =
      ctx.chatId || ctx.characterId || '';

    // ── 读取角色 ──────────────────────────────
    raw.characters = this.readCharacters(ctx);

    // ── 读取消息 ──────────────────────────────
    raw.messages = this.readMessages(ctx);

    // ── 读取世界书 ────────────────────────────
    raw.worldBooks = this.readWorldBooks(ctx, raw.characters);

    // ── 读取破限/系统提示 ─────────────────────
    const jailbreak = this.readJailbreak(ctx, raw.characters);
    raw.jailbreak = jailbreak.text;
    raw.jailbreakName = jailbreak.name;

    // ── 群聊 ID ─────────────────────────────
    if (ctx.groupId) {
      raw.extras.groupId = ctx.groupId;
    }

    this.lastSnapshot = raw;
    return raw;
  }

  /**
   * 获取最后读取的快照（不重新读取）
   */
  getSnapshot(): RawSourceData | null {
    return this.lastSnapshot;
  }

  /**
   * 监听变化：每隔 intervalMs 轮询一次，
   * 数据有变化时回调 onChange
   */
  watch(onChange: (data: RawSourceData) => void, intervalMs = 2000): () => void {
    this.stopWatch();

    // 先立即触发一次
    try {
      onChange(this.read());
    } catch {
      /* 静默失败，等下次轮询 */
    }

    this.watchInterval = setInterval(() => {
      try {
        const prev = this.lastSnapshot;
        const current = this.read();
        if (!prev || this.hasChanged(prev, current)) {
          onChange(current);
        }
      } catch {
        /* 轮询失败不中断定时器 */
      }
    }, intervalMs);

    return () => this.stopWatch();
  }

  /**
   * 停止监听
   */
  stopWatch(): void {
    if (this.watchInterval !== null) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
  }

  // ── 各读取子模块（便于独立测试/覆写） ────────

  /**
   * 从 context 读取角色列表。
   *
   * context.characters 可能是对象（keyed by name/id）或数组。
   */
  private readCharacters(ctx: STContext): Record<string, unknown>[] {
    return safeGet(() => {
      const chars = ctx.characters;
      if (!chars) return [];

      // 如果是对象（key → character），取 values
      if (!Array.isArray(chars)) {
        return Object.values(chars).map(
          c => ({ ...c } as Record<string, unknown>)
        );
      }

      // 已是数组
      return chars.map(c => ({ ...c } as Record<string, unknown>));
    }, []);
  }

  /**
   * 从 context 读取聊天消息列表。
   *
   * ST 消息原始字段: name, is_user, is_system, mes, send_date, swipes, swipe_id, extra
   * 保留全部原始字段，由后续 normalizer 统一为标准 Message 格式。
   */
  private readMessages(ctx: STContext): Record<string, unknown>[] {
    return safeGet(() => {
      const chat = ctx.chat;
      if (!Array.isArray(chat)) return [];
      return chat.map(m => ({ ...m } as Record<string, unknown>));
    }, []);
  }

  /**
   * 从 context 读取世界书条目。
   *
   * 尝试路径（按优先级）：
   *   1. context.worldInfo.entries            — 全局世界书
   *   2. 各角色 data.extensions.world_info    — 角色绑定的世界书
   *   3. 角色 data.extensions.world           — 另一种常见的 key
   */
  private readWorldBooks(
    ctx: STContext,
    rawChars: Record<string, unknown>[]
  ): Record<string, unknown>[] {
    const entries: Record<string, unknown>[] = [];

    // 路径1：全局世界书
    try {
      const wi = ctx.worldInfo;
      if (wi?.entries && typeof wi.entries === 'object') {
        entries.push(
          ...Object.values(wi.entries).map(
            e => ({ ...e } as Record<string, unknown>)
          )
        );
      }
    } catch { /* 忽略 */ }

    // 路径2/3：从角色扩展数据中提取角色绑定的世界书
    if (entries.length === 0) {
      for (const rawChar of rawChars) {
        try {
          const data = rawChar.data as Record<string, unknown> | undefined;
          const ext = data?.extensions as Record<string, unknown> | undefined;
          const wi = (ext?.world_info || ext?.world) as
            | Record<string, Record<string, unknown>>
            | undefined;
          if (wi && typeof wi === 'object') {
            entries.push(
              ...Object.values(wi).map(
                e => ({ ...e } as Record<string, unknown>)
              )
            );
          }
        } catch { /* 继续下一个角色 */ }
      }
    }

    return entries;
  }

  /**
   * 从 context 读取破限/系统提示文本。
   *
   * 尝试路径（按优先级）：
   *   1. 第一个角色的 system_prompt 字段
   *   2. context 中可能存在的预设信息
   */
  private readJailbreak(
    ctx: STContext,
    rawChars: Record<string, unknown>[]
  ): { text: string; name: string } {
    // 路径1：首个角色的 system_prompt
    if (rawChars.length > 0) {
      const sysPrompt = rawChars[0].system_prompt as string | undefined;
      if (sysPrompt && sysPrompt.trim()) {
        return { text: sysPrompt, name: rawChars[0].name as string || '' };
      }
    }

    // 路径2：尝试从 context 中获取全局预设（ST 部分版本支持）
    try {
      const preset = (ctx as any).preset || (ctx as any).chatMetadata?.preset;
      if (preset) {
        const text = preset.system_prompt || preset.jailbreak || preset.prompt || '';
        if (text.trim()) {
          return { text, name: preset.name || '全局预设' };
        }
      }
    } catch { /* ctx.preset 不可用 */ }

    return { text: '', name: '' };
  }

  // ── 变化检测 ──────────────────────────────

  /**
   * 简单 diff：比较关键数组长度和文本
   */
  private hasChanged(prev: RawSourceData, curr: RawSourceData): boolean {
    return (
      prev.characters.length !== curr.characters.length ||
      prev.messages.length !== curr.messages.length ||
      prev.worldBooks.length !== curr.worldBooks.length ||
      prev.jailbreak !== curr.jailbreak ||
      JSON.stringify(prev.extras) !== JSON.stringify(curr.extras)
    );
  }
}

/** 单例 */
export const tavernLiveLoader = new TavernLiveLoader();
