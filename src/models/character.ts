/**
 * 统一角色结构
 */

/** 角色启用状态 */
export type CharacterStatus = 'enabled' | 'disabled';

/** 角色元数据（扩展字段） */
export interface CharacterMeta {
  /** 原始角色卡版本 */
  cardVersion?: string;
  /** 创建者 */
  creator?: string;
  /** 标签 */
  tags?: string[];
  /** 其他未归一字段 */
  [key: string]: unknown;
}

/** 统一角色 */
export interface Character {
  /** 内部唯一 ID */
  id: string;
  /** 归一化后的角色名 */
  name: string;
  /** 显示名（可与 name 不同，如昵称） */
  displayName: string;
  /** 头像 URI（base64 或路径） */
  avatar: string;
  /** 角色使用的模型 */
  model: string;
  /** 角色系统提示 / 人物设定 */
  prompt: string;
  /** 角色描述（与 prompt 互补的简短描述） */
  description: string;
  /** 关联的世界书条目 ID 列表 */
  lorebookRefs: string[];
  /** 启用状态 */
  status: CharacterStatus;
  /** 群聊中是否为主持人 */
  isNarrator: boolean;
  /** 扩展元数据 */
  meta: CharacterMeta;
}
