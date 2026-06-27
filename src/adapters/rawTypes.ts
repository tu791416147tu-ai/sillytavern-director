/**
 * 原始来源数据 —— Loader 层的输出，Parser 层的输入
 *
 * 这个结构是"半成品"，字段名保留原始来源的命名，
 * 由后续的 Parser + Normalizer 将其转化为 UnifiedSession。
 */

export interface RawMessage {
  [key: string]: unknown;
}

export interface RawCharacter {
  [key: string]: unknown;
}

export interface RawWorldBookEntry {
  [key: string]: unknown;
}

/** Loader 产出的原始数据 */
export interface RawSourceData {
  /** 数据来源标识 */
  source: 'tavern-live' | 'file-import' | 'image-card' | 'preset' | 'unknown';
  /** 来源文件名（导入模式） */
  fileName?: string;
  /** 原始角色数据 */
  characters: RawCharacter[];
  /** 原始消息数据 */
  messages: RawMessage[];
  /** 原始世界书数据 */
  worldBooks: RawWorldBookEntry[];
  /** 原始破限文本 */
  jailbreak: string;
  /** 破限名称 */
  jailbreakName: string;
  /** 酒馆版本 */
  tavernVersion: string;
  /** 其他未分类原始数据 */
  extras: Record<string, unknown>;
}

/** 创建空 RawSourceData */
export function createEmptyRawData(source: RawSourceData['source'] = 'unknown'): RawSourceData {
  return {
    source,
    characters: [],
    messages: [],
    worldBooks: [],
    jailbreak: '',
    jailbreakName: '',
    tavernVersion: '',
    extras: {},
  };
}
