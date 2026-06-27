/**
 * OCRParser —— 图片 OCR 解析器
 *
 * 用于处理无法从 PNG 元数据读取的角色卡图片（如截图、WebP、JPEG 等）。
 *
 * 当前版本提供两个路径：
 *  1. 浏览器内置 OCR API（实验性，Chrome 尚未默认支持）
 *  2. 外部 OCR 服务回调（用户自行接入 Tesseract.js 等服务）
 *
 * 此处提供 OCR 结果 → 角色卡结构的解析逻辑，
 * 实际 OCR 识别由外部回调完成。
 */

import type { ParsedCharacter } from './jsonParser';
import { parseCharacterText } from './textParser';

// ─── OCR 结果类型 ─────────────────────────────────────

export interface OCRResult {
  /** 识别出的全部文本 */
  text: string;
  /** 置信度 (0-1) */
  confidence: number;
  /** OCR 引擎名称 */
  engine: string;
}

// ─── OCR 回调类型 ─────────────────────────────────────

export type OCRCallback = (imageDataUrl: string) => Promise<OCRResult>;

// ─── 解析器 ───────────────────────────────────────────

export class OCRParser {
  private ocrCallback: OCRCallback | null = null;

  /**
   * 注册外部 OCR 回调
   *
   * 示例（Tesseract.js）：
   * ```
   * ocrParser.setOCRCallback(async (dataUrl) => {
   *   const { data } = await Tesseract.recognize(dataUrl, 'chi_sim+eng');
   *   return { text: data.text, confidence: data.confidence, engine: 'tesseract' };
   * });
   * ```
   */
  setOCRCallback(callback: OCRCallback | null): void {
    this.ocrCallback = callback;
  }

  /**
   * 对图片执行 OCR，并将结果解析为角色卡结构
   */
  async parseCharacterImage(imageDataUrl: string): Promise<{
    character: ParsedCharacter;
    ocrResult: OCRResult;
  }> {
    if (!this.ocrCallback) {
      throw new Error(
        '[OCRParser] 未注册 OCR 回调。请先调用 setOCRCallback() 接入 OCR 引擎。\n' +
          '推荐方案：Tesseract.js (npm install tesseract.js)'
      );
    }

    const ocrResult = await this.ocrCallback(imageDataUrl);

    if (!ocrResult.text || ocrResult.text.trim().length === 0) {
      throw new Error('[OCRParser] OCR 识别结果为空。请检查图片清晰度或更换 OCR 引擎。');
    }

    // 用 textParser 的角色文本解析逻辑处理 OCR 文本
    const character = parseCharacterText(ocrResult.text);
    character._ocrConfidence = ocrResult.confidence;
    character._ocrEngine = ocrResult.engine;

    return { character, ocrResult };
  }

  /**
   * 批量处理多张图片
   */
  async parseCharacterImages(
    imageDataUrls: string[]
  ): Promise<Array<{ character: ParsedCharacter; ocrResult: OCRResult }>> {
    const results: Array<{ character: ParsedCharacter; ocrResult: OCRResult }> = [];
    for (const url of imageDataUrls) {
      try {
        results.push(await this.parseCharacterImage(url));
      } catch (e) {
        // 单张失败不中断全部
        results.push({
          character: { name: 'OCR失败', _ocrError: String(e) },
          ocrResult: { text: '', confidence: 0, engine: 'error' },
        });
      }
    }
    return results;
  }
}

/** 单例 */
export const ocrParser = new OCRParser();
