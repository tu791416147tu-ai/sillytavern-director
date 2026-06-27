/**
 * 统一会话结构 —— 所有数据源的最终归一格式
 *
 * 无论数据来自酒馆实时连接、手动导入的聊天存档、
 * 角色卡文件、世界书还是破限文本，最终都必须收敛为这个结构。
 */

import { Character } from './character';
import { Message } from './message';
import { WorldBookEntry } from './worldbook';
import { JailbreakConfig } from './jailbreak';

// ─── 对话模式 ───────────────────────────────────────
export type DialogueMode = 'sequential' | 'parallel';

// ─── 适配器运行模式 ──────────────────────────────────
export type AdapterMode = 'live' | 'import';

// ─── 来源元数据 ──────────────────────────────────────
export interface SourceMeta {
  /** 酒馆版本号（实时模式） */
  tavernVersion: string;
  /** 导入时间戳 */
  importedAt: string;
  /** 导入的原始文件名列表 */
  fileNames: string[];
  /** 数据来源标签，方便调试 */
  source: 'tavern-live' | 'file-import' | 'image-card' | 'preset' | 'unknown';
  /** 附加的原始格式名（如 "character-card-v2", "world-info-v3"） */
  formatHint?: string;
}

// ─── 会话级配置 ──────────────────────────────────────
export interface SessionSettings {
  /** 对话模式 */
  dialogueMode: DialogueMode;
  /** 导演模型标识 */
  directorModel: string;
  /** 各角色模型映射 { charId: modelName } */
  roleModels: Record<string, string>;
  /** 其他扩展配置 */
  [key: string]: unknown;
}

// ─── 统一会话结构 ────────────────────────────────────
export interface UnifiedSession {
  /** 会话唯一 ID */
  sessionId: string;
  /** 运行模式 */
  mode: AdapterMode;
  /** 角色列表 */
  characters: Character[];
  /** 消息列表 */
  messages: Message[];
  /** 世界书条目列表 */
  worldBooks: WorldBookEntry[];
  /** 破限/系统提示配置 */
  jailbreak: JailbreakConfig;
  /** 会话级别设置 */
  settings: SessionSettings;
  /** 来源元数据 */
  sourceMeta: SourceMeta;
}
