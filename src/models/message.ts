/**
 * 统一消息结构
 */

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'character';

/** 消息元数据 */
export interface MessageMeta {
  /** 原始模型名 */
  model?: string;
  /** token 数 */
  tokenCount?: number;
  /** 是否被编辑过 */
  edited?: boolean;
  /** 替代版本（swipe 功能） */
  swipeIndex?: number;
  /** 总 swipe 数 */
  swipeTotal?: number;
  /** 其他 */
  [key: string]: unknown;
}

/** 统一消息 */
export interface Message {
  /** 消息唯一 ID */
  id: string;
  /** 消息角色 */
  role: MessageRole;
  /** 发言者名称 */
  speaker: string;
  /** 消息正文 */
  content: string;
  /** Unix 时间戳（秒） */
  timestamp: number;
  /** 对话轮次索引（从 0 开始） */
  turnIndex: number;
  /** 是否可见（用于隐藏/删除） */
  visible: boolean;
  /** 如果是群聊，标记属于哪个子会话 */
  groupId?: string;
  /** 扩展元数据 */
  meta: MessageMeta;
}
