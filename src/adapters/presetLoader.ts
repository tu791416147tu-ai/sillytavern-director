/**
 * PresetLoader —— 读取破限 / 系统提示预设
 *
 * 数据来源：
 *  - 酒馆内置预设（通过 TavernLiveLoader 已覆盖）
 *  - 用户粘贴/导入的纯文本
 *  - JSON 格式的预设导出文件
 *
 * 本 Loader 为"纯文本/粘贴"场景提供入口。
 */

import { RawSourceData, createEmptyRawData } from './rawTypes';

export class PresetLoader {
  /**
   * 从纯文本字符串加载破限
   */
  fromText(text: string, name = '手动导入'): RawSourceData {
    const raw = createEmptyRawData('preset');
    raw.jailbreak = text.trim();
    raw.jailbreakName = name;
    return raw;
  }

  /**
   * 从 JSON 对象加载（含 system_prompt / jailbreak / prompt 等字段）
   */
  fromJSON(json: Record<string, unknown>, name?: string): RawSourceData {
    const raw = createEmptyRawData('preset');
    raw.jailbreak =
      (json.system_prompt as string) ||
      (json.jailbreak as string) ||
      (json.prompt as string) ||
      (json.text as string) ||
      '';
    raw.jailbreakName =
      name || (json.name as string) || (json.preset_name as string) || '未命名预设';
    raw.extras.presetJSON = json;
    return raw;
  }

  /**
   * 从酒馆当前激活的预设加载（快捷方式：直接调用 TavernLiveLoader 的破限部分）
   */
  fromCurrentTavern(): RawSourceData {
    const raw = createEmptyRawData('preset');
    try {
      const st = (window as unknown as Record<string, unknown>).SillyTavern as
        | { getPreset?: () => Record<string, unknown> }
        | undefined;
      if (st?.getPreset) {
        const preset = st.getPreset();
        raw.jailbreak =
          (preset.system_prompt as string) ||
          (preset.jailbreak as string) ||
          (preset.prompt as string) ||
          '';
        raw.jailbreakName = (preset.name as string) || '当前预设';
      }
    } catch {
      /* 静默回退 */
    }
    return raw;
  }
}

/** 单例 */
export const presetLoader = new PresetLoader();
