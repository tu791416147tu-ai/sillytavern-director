/**
 * 破限/系统提示配置
 */

/** 破限来源 */
export type JailbreakSource = 'tavern' | 'file' | 'inline' | 'plugin-config' | 'none';

/** 破限配置 */
export interface JailbreakConfig {
  /** 破限文本 */
  text: string;
  /** 来源 */
  source: JailbreakSource;
  /** 是否启用 */
  enabled: boolean;
  /** 名称（如预设名） */
  name: string;
}

/** 创建默认空破限 */
export function createEmptyJailbreak(): JailbreakConfig {
  return {
    text: '',
    source: 'none',
    enabled: false,
    name: '未加载',
  };
}
