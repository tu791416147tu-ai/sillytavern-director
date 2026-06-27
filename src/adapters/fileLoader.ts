/**
 * FileLoader —— 读取用户手动导入的本地文件
 *
 * 支持的格式：
 *  - JSON 聊天记录
 *  - JSON 世界书
 *  - JSON 角色卡
 *  - 纯文本破限
 *
 * 职责：读文件、识别类型、产出 RawSourceData 给后续 Parser。
 */

import { RawSourceData, createEmptyRawData } from './rawTypes';

// ─── 文件类型识别 ─────────────────────────────────────

export type FileCategory = 'chat-json' | 'worldbook-json' | 'character-json' | 'preset-text' | 'unknown';

/** 快速检测 JSON 对象属于哪种酒馆数据类型 */
export function detectFileCategory(
  json: Record<string, unknown>,
  fileName?: string
): FileCategory {
  const name = (fileName || '').toLowerCase();

  // 通过文件名提示
  if (name.includes('chat') || name.includes('对话') || name.includes('聊天')) {
    if (Array.isArray(json) || json.messages || json.chat || json.history) {
      return 'chat-json';
    }
  }
  if (name.includes('world') || name.includes('世界书') || name.includes('lore')) {
    return 'worldbook-json';
  }
  if (name.includes('character') || name.includes('char_') || name.includes('角色')) {
    return 'character-json';
  }
  if (name.includes('preset') || name.includes('破限') || name.includes('jailbreak') || name.includes('system')) {
    return 'preset-text';
  }

  // 通过结构检测
  if (Array.isArray(json)) {
    // 数组 → 可能是纯消息列表
    if (json.length > 0 && (json[0].content || json[0].role || json[0].mes)) {
      return 'chat-json';
    }
    // 可能是世界书条目列表
    if (json.length > 0 && (json[0].keys || json[0].key || json[0].entry)) {
      return 'worldbook-json';
    }
  }

  // 包含 messages / chat / history → 聊天记录
  if (json.messages || json.chat || json.history) {
    return 'chat-json';
  }

  // 包含 entries / worldinfo / lorebook → 世界书
  if (json.entries || json.worldinfo || json.lorebook || json.world_book) {
    return 'worldbook-json';
  }

  // 包含角色特征字段
  if (json.name && (json.personality || json.description || json.first_mes || json.scenario)) {
    return 'character-json';
  }

  return 'unknown';
}

// ─── 文件读取器 ───────────────────────────────────────

export class FileLoader {
  /**
   * 从 File 对象读取文本内容
   */
  async readAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`));
      reader.readAsText(file);
    });
  }

  /**
   * 从 File 对象读取 Data URL（用于图片）
   */
  async readAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  /**
   * 加载 JSON 文件并识别类型
   */
  async loadJSON(file: File): Promise<{
    raw: RawSourceData;
    category: FileCategory;
  }> {
    const text = await this.readAsText(file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`[FileLoader] 文件 "${file.name}" 不是有效的 JSON。`);
    }

    // 统一包装为对象（数组消息列表 → { messages: [...] }）
    let jsonObj: Record<string, unknown>;
    if (Array.isArray(parsed)) {
      jsonObj = { messages: parsed };
    } else if (typeof parsed === 'object' && parsed !== null) {
      jsonObj = parsed as Record<string, unknown>;
    } else {
      throw new Error(`[FileLoader] 文件 "${file.name}" 内容格式不支持。`);
    }

    const category = detectFileCategory(jsonObj, file.name);
    const raw = createEmptyRawData('file-import');
    raw.fileName = file.name;

    // 按类别填入 raw 结构
    this.populateRawData(raw, jsonObj, category);

    return { raw, category };
  }

  /**
   * 加载纯文本文件（破限/预设）
   */
  async loadText(file: File): Promise<RawSourceData> {
    const text = await this.readAsText(file);
    const raw = createEmptyRawData('file-import');
    raw.fileName = file.name;
    raw.jailbreak = text;
    raw.jailbreakName = file.name.replace(/\.[^.]+$/, '');
    return raw;
  }

  /**
   * 自动检测文件扩展名并选择正确的加载方式
   */
  async loadFile(file: File): Promise<{ raw: RawSourceData; category: FileCategory }> {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const textExts = ['txt', 'md', 'text'];

    if (ext === 'json') {
      return this.loadJSON(file);
    }

    if (textExts.includes(ext)) {
      const raw = await this.loadText(file);
      return { raw, category: 'preset-text' };
    }

    // 默认按 JSON 尝试
    return this.loadJSON(file);
  }

  /**
   * 按识别的类别，将 JSON 数据填入 RawSourceData 各字段
   */
  private populateRawData(
    raw: RawSourceData,
    json: Record<string, unknown>,
    category: FileCategory
  ): void {
    switch (category) {
      case 'chat-json': {
        const msgs = json.messages || json.chat || json.history || [];
        raw.messages = (Array.isArray(msgs) ? msgs : []) as Record<string, unknown>[];
        // 聊天文件可能也包含角色信息
        if (json.characters) {
          raw.characters = (
            Array.isArray(json.characters) ? json.characters : [json.characters]
          ) as Record<string, unknown>[];
        }
        break;
      }

      case 'worldbook-json': {
        const entries = json.entries || json.worldinfo || json.lorebook || json.world_book || [];
        raw.worldBooks = (Array.isArray(entries) ? entries : Object.values(entries)) as Record<string, unknown>[];
        break;
      }

      case 'character-json': {
        raw.characters = [json] as Record<string, unknown>[];
        break;
      }

      case 'preset-text': {
        raw.jailbreak = (json.system_prompt || json.jailbreak || json.prompt || json.text || '') as string;
        raw.jailbreakName = (json.name || '') as string;
        break;
      }

      default:
        // 兜底：全部塞进 extras，让 Parser 自行判断
        raw.extras.unknownJson = json;
        break;
    }
  }
}

/** 单例 */
export const fileLoader = new FileLoader();
