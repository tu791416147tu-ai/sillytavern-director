/**
 * ImageCardLoader —— 读取角色卡图片（PNG 内嵌 JSON）
 *
 * SillyTavern 角色卡 PNG 在 tEXt 块中存储 base64 编码的角色 JSON 数据。
 *
 * 职责：
 *  1. 读取 PNG 文件
 *  2. 从 tEXt 块中提取 "ccv3" 或 "chara" 键
 *  3. 解码 base64 → JSON
 *  4. 产出 RawSourceData
 *
 * 注意：OCR 识别（非 PNG 嵌入的角色卡图片）由 ocrParser 负责，
 *       本 Loader 只处理 PNG 内嵌元数据的情况。
 */

import { RawSourceData, createEmptyRawData } from './rawTypes';
import { detectFileCategory } from './fileLoader';

// ─── PNG 块解析 ───────────────────────────────────────

interface PNGChunk {
  type: string;
  data: Uint8Array;
}

/**
 * 从 PNG 文件的 tEXt 块中提取键值对
 */
function extractPNGTextChunks(buffer: ArrayBuffer): Record<string, string> {
  const result: Record<string, string> = {};
  const bytes = new Uint8Array(buffer);

  // 检查 PNG 签名
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== signature[i]) {
      throw new Error('[ImageCardLoader] 文件不是有效的 PNG。');
    }
  }

  let offset = 8;

  while (offset < bytes.length) {
    // 读取长度（4 字节大端序）
    const length =
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3];
    offset += 4;

    // 读取块类型（4 字节 ASCII）
    const type = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    offset += 4;

    // 读取块数据
    const data = bytes.slice(offset, offset + length);
    offset += length;

    // 跳过 CRC（4 字节）
    offset += 4;

    // tEXt 块：keyword\0text
    if (type === 'tEXt') {
      const text = new TextDecoder().decode(data);
      const nullIdx = text.indexOf('\0');
      if (nullIdx > 0) {
        const key = text.slice(0, nullIdx);
        const value = text.slice(nullIdx + 1);
        result[key] = value;
      }
    }

    // IEND 块：文件结束
    if (type === 'IEND') break;
  }

  return result;
}

// ─── 主 Loader ────────────────────────────────────────

export class ImageCardLoader {
  /**
   * 从 File 对象加载角色卡图片
   *
   * 先尝试提取 PNG 内嵌的 v3 格式数据（ccv3 块），
   * 如果没有，再尝试旧版 v2 格式（chara 块）。
   */
  async load(file: File): Promise<{ raw: RawSourceData; format: 'v3' | 'v2' | 'unknown' }> {
    const buffer = await file.arrayBuffer();
    const isPNG = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');

    if (!isPNG) {
      // 非 PNG 图片 → 交给 OCR Parser，这里只挂标记
      const raw = createEmptyRawData('image-card');
      raw.fileName = file.name;
      raw.extras.needsOCR = true;
      raw.extras.mimeType = file.type;
      raw.extras.imageDataUrl = await this.readAsDataURL(file);
      return { raw, format: 'unknown' };
    }

    // ── PNG: 提取 tEXt 块 ──────────────────────
    const textChunks = extractPNGTextChunks(buffer);

    // v3 格式（ccv3）
    if (textChunks['ccv3']) {
      try {
        const jsonStr = atob(textChunks['ccv3']);
        const json = JSON.parse(jsonStr);
        const raw = createEmptyRawData('image-card');
        raw.fileName = file.name;
        raw.characters = [json as Record<string, unknown>];
        raw.extras.cardFormat = 'v3';
        raw.extras.imageDataUrl = await this.readAsDataURL(file);
        return { raw, format: 'v3' };
      } catch (e) {
        throw new Error(`[ImageCardLoader] PNG ccv3 块解析失败: ${e}`);
      }
    }

    // v2 格式（chara）
    if (textChunks['chara']) {
      try {
        const jsonStr = atob(textChunks['chara']);
        const json = JSON.parse(jsonStr);
        const raw = createEmptyRawData('image-card');
        raw.fileName = file.name;
        raw.characters = [json as Record<string, unknown>];
        raw.extras.cardFormat = 'v2';
        raw.extras.imageDataUrl = await this.readAsDataURL(file);
        return { raw, format: 'v2' };
      } catch (e) {
        throw new Error(`[ImageCardLoader] PNG chara 块解析失败: ${e}`);
      }
    }

    throw new Error(
      '[ImageCardLoader] PNG 中未找到角色卡数据（ccv3 或 chara 块）。' +
        '如果是纯截图，请使用 OCR 导入方式。'
    );
  }

  private async readAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error(`读取图片失败: ${file.name}`));
      reader.readAsDataURL(file);
    });
  }
}

/** 单例 */
export const imageCardLoader = new ImageCardLoader();
