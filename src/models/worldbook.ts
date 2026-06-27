/**
 * 统一世界书条目结构
 */

/** 触发类型 */
export type TriggerType = 'keyword' | 'manual' | 'director';

/** 目标范围 */
export type WorldBookTarget = 'global' | 'character' | 'session';

/** 世界书条目 */
export interface WorldBookEntry {
  /** 条目唯一 ID */
  id: string;
  /** 条目标题 */
  title: string;
  /** 触发关键词列表 */
  keys: string[];
  /** 条目正文内容 */
  content: string;
  /** 插入深度（0 = 最前） */
  depth: number;
  /** 触发方式 */
  triggerType: TriggerType;
  /** 优先级（越高越先匹配） */
  priority: number;
  /** 是否启用 */
  enabled: boolean;
  /** 作用范围 */
  target: WorldBookTarget;
  /** 关联的角色 ID（target 为 character 时） */
  characterId?: string;
  /** 选择性标记（用于分组过滤） */
  selective: boolean;
  /** 二级关键词 */
  secondaryKeys: string[];
  /** 恒定插入（不受触发词限制） */
  constant: boolean;
  /** 插入位置：before/after 角色定义 */
  position: 'before_char' | 'after_char' | 'in_chat';
  /** 递归扫描深度 */
  scanDepth: number;
  /** 扩展字段 */
  meta: Record<string, unknown>;
}
