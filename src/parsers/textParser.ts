/**
 * TextParser —— 纯文本解析器
 *
 * 处理场景：
 *  - 破限/系统提示纯文本
 *  - 用户粘贴的角色描述文本
 *  - 纯文本聊天记录（按行/段落解析）
 *
 * 纯文本没有结构信息，解析策略是尽力而为的启发式规则。
 */

import type { ParsedMessage, ParsedCharacter } from './jsonParser';

// ─── 破限文本 —— 直接透传 ─────────────────────────────

export function parseJailbreakText(text: string, name = ''): {
  jailbreak: string;
  jailbreakName: string;
} {
  return {
    jailbreak: text.trim(),
    jailbreakName: name || '未命名破限',
  };
}

// ─── 角色文本 —— 按分段猜测字段 ──────────────────────

/**
 * 将纯文本角色描述解析为半结构化对象
 *
 * 启发式：
 *  - 第一行可能是名字
 *  - "描述"、"性格"、"背景" 等关键词后面的段落是对应字段
 */
export function parseCharacterText(text: string): ParsedCharacter {
  const parsed: Record<string, unknown> = {};
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // 第一行当名字
  if (lines.length > 0 && lines[0].length < 50) {
    parsed.name = lines[0].replace(/^[#\s*【】「」]+|[#\s*【】「」]+$/g, '').trim();
    lines.shift();
  }

  // 按关键词分段
  const sections: Record<string, string[]> = {};
  let currentSection = 'description';

  const sectionMarkers: Record<string, string[]> = {
    name:        ['名字', '名称', '姓名', 'name'],
    description: ['描述', '简介', '概述', 'description', '背景', '设定'],
    personality: ['性格', '个性', 'personality'],
    scenario:    ['场景', '世界观', 'scenario', '背景故事'],
    prompt:      ['提示', '系统提示', 'prompt', 'system'],
    firstMessage:['开场', '首条消息', 'first_mes', '问候', 'greeting'],
  };

  for (const line of lines) {
    let matched = false;
    for (const [section, markers] of Object.entries(sectionMarkers)) {
      for (const marker of markers) {
        if (line.includes(marker) && line.length < 40) {
          currentSection = section;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) {
      if (!sections[currentSection]) sections[currentSection] = [];
      sections[currentSection].push(line);
    }
  }

  // 组装
  parsed.name = sections.name?.[0] || parsed.name || '未命名角色';
  parsed.description = (sections.description || []).join('\n');
  parsed.personality = (sections.personality || []).join('\n');
  parsed.scenario = (sections.scenario || []).join('\n');
  parsed.prompt = (sections.prompt || []).join('\n');
  parsed.firstMessage = (sections.firstMessage || []).join('\n');
  parsed._raw = { sections };

  return parsed as ParsedCharacter;
}

// ─── 聊天文本 —— 按 "角色名: 内容" 格式解析 ──────────

/**
 * 解析纯文本聊天记录
 *
 * 支持格式：
 *  角色A: 你好
 *  角色B: 你好呀
 *
 *  或：
 *  [角色A] 你好
 *  [角色B] 你好呀
 */
export function parseChatText(text: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  const lines = text.split('\n');

  // 正则匹配 "名字: 内容" 或 "[名字] 内容"
  const linePattern = /^(?:\[([^\]]+)\]|([^:\n【】]+)[:：])\s*(.+)/;
  let turnIndex = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(linePattern);
    if (match) {
      const speaker = (match[1] || match[2] || '未知').trim();
      const content = (match[3] || '').trim();
      messages.push({
        speaker,
        content,
        role: speaker === '用户' || speaker === 'User' || speaker === 'user' ? 'user' : 'character',
        turnIndex: turnIndex++,
        timestamp: Date.now() / 1000,
        visible: true,
      });
    } else {
      // 没有匹配到发言者格式，视为系统/叙述文本
      messages.push({
        speaker: '系统',
        content: trimmed,
        role: 'system',
        turnIndex: turnIndex++,
        timestamp: Date.now() / 1000,
        visible: true,
      });
    }
  }

  return messages;
}
