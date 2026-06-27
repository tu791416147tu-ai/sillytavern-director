/**
 * AdapterFacade —— 数据适配层的统一对外 API
 *
 * 串联 Loader → Parser → Normalizer → Validator 整条流水线。
 */

import type { UnifiedSession, AdapterMode, SourceMeta, SessionSettings } from '../models/session';
import type { Character } from '../models/character';
import type { Message } from '../models/message';
import type { WorldBookEntry } from '../models/worldbook';
import type { JailbreakConfig } from '../models/jailbreak';
import { createEmptyJailbreak } from '../models/jailbreak';

import {
  tavernLiveLoader,
  fileLoader,
  imageCardLoader,
  presetLoader,
} from './index';
import type { RawSourceData, FileCategory } from './index';

import { parseRawData } from '../parsers/jsonParser';
import type { ParsedData } from '../parsers/jsonParser';

import {
  normalizeCharacters,
  normalizeMessages,
  normalizeWorldBookEntries,
  resetCharCounter,
  resetMsgCounter,
  resetWBCounter,
} from '../normalizers';

import { validateSession } from '../validators/validateSession';
import type { ValidationResult } from '../validators/validateSession';

// ─── 会话摘要 ─────────────────────────────────────────

export interface SessionSummary {
  mode: AdapterMode;
  characterCount: number;
  messageCount: number;
  worldBookCount: number;
  jailbreakLoaded: boolean;
  jailbreakName: string;
}

// ─── 适配器外观类 ─────────────────────────────────────

export class AdapterFacade {
  private currentSession: UnifiedSession | null = null;

  // ═══════════════════════════════════════════════════
  // 实时模式
  // ═══════════════════════════════════════════════════

  readFromTavern(): UnifiedSession {
    const raw = tavernLiveLoader.read();
    return this.pipeline(raw, 'live');
  }

  watchTavern(onChange: (session: UnifiedSession) => void, intervalMs = 2000): () => void {
    return tavernLiveLoader.watch((raw) => {
      try {
        const session = this.pipeline(raw, 'live');
        onChange(session);
      } catch (e) {
        console.error('[AdapterFacade] 监听回调异常:', e);
      }
    }, intervalMs);
  }

  stopWatching(): void { tavernLiveLoader.stopWatch(); }

  // ═══════════════════════════════════════════════════
  // 导入模式
  // ═══════════════════════════════════════════════════

  async importJSON(file: File): Promise<{ session: UnifiedSession; category: FileCategory }> {
    const { raw, category } = await fileLoader.loadJSON(file);
    const session = this.pipeline(raw, 'import', [file.name]);
    return { session, category };
  }

  async importText(file: File): Promise<UnifiedSession> {
    const raw = await fileLoader.loadText(file);
    return this.pipeline(raw, 'import', [file.name]);
  }

  async importImageCard(file: File): Promise<UnifiedSession> {
    const { raw } = await imageCardLoader.load(file);
    return this.pipeline(raw, 'import', [file.name]);
  }

  async importFile(file: File): Promise<{ session: UnifiedSession; category: FileCategory }> {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (ext === 'json') return this.importJSON(file);
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
      const session = await this.importImageCard(file);
      return { session, category: 'character-json' };
    }
    if (['txt', 'md', 'text'].includes(ext)) {
      const session = await this.importText(file);
      return { session, category: 'preset-text' };
    }
    return this.importJSON(file);
  }

  importPresetFromText(text: string, name?: string): UnifiedSession {
    const raw = presetLoader.fromText(text, name);
    return this.pipeline(raw, 'import', [name || '粘贴文本']);
  }

  // ═══════════════════════════════════════════════════
  // 状态查询
  // ═══════════════════════════════════════════════════

  getCurrentSession(): UnifiedSession | null { return this.currentSession; }

  getSummary(session?: UnifiedSession): SessionSummary {
    const s = session || this.currentSession;
    if (!s) {
      return {
        mode: 'import', characterCount: 0, messageCount: 0,
        worldBookCount: 0, jailbreakLoaded: false, jailbreakName: '',
      };
    }
    return {
      mode: s.mode,
      characterCount: s.characters.length,
      messageCount: s.messages.length,
      worldBookCount: s.worldBooks.length,
      jailbreakLoaded: s.jailbreak.enabled && s.jailbreak.text.length > 0,
      jailbreakName: s.jailbreak.name || '',
    };
  }

  validate(session: UnifiedSession): ValidationResult {
    return validateSession(session);
  }

  resetCounters(): void {
    resetCharCounter();
    resetMsgCounter();
    resetWBCounter();
  }

  // ═══════════════════════════════════════════════════
  // 内部流水线
  // ═══════════════════════════════════════════════════

  private pipeline(raw: RawSourceData, mode: AdapterMode, fileNames: string[] = []): UnifiedSession {
    const parsed = parseRawData(raw);
    const characters = normalizeCharacters(parsed.characters);
    const messages = normalizeMessages(parsed.messages);
    const worldBooks = normalizeWorldBookEntries(parsed.worldBooks);

    const session = this.assembleSession(raw, parsed, { characters, messages, worldBooks }, mode, fileNames);
    this.currentSession = session;
    return session;
  }

  private assembleSession(
    raw: RawSourceData,
    parsed: ParsedData,
    normalized: { characters: Character[]; messages: Message[]; worldBooks: WorldBookEntry[] },
    mode: AdapterMode,
    fileNames: string[]
  ): UnifiedSession {
    const jailbreak: JailbreakConfig = {
      text: raw.jailbreak || parsed.jailbreak || '',
      source: raw.source === 'tavern-live' ? 'tavern' : 'file',
      enabled: raw.source === 'tavern-live' || (!!(raw.jailbreak || parsed.jailbreak)),
      name: raw.jailbreakName || parsed.jailbreakName || '未加载',
    };

    const sourceMeta: SourceMeta = {
      tavernVersion: raw.tavernVersion || '',
      importedAt: mode === 'import' ? new Date().toISOString() : '',
      fileNames,
      source: raw.source,
    };

    const sessionId =
      (parsed.sessionMeta.chatId as string) ||
      (parsed.sessionMeta.sessionId as string) ||
      `session-${Date.now()}`;

    const settings: SessionSettings = {
      dialogueMode: 'sequential',
      directorModel: '',
      roleModels: {},
    };

    return { sessionId, mode, characters: normalized.characters, messages: normalized.messages, worldBooks: normalized.worldBooks, jailbreak, settings, sourceMeta };
  }
}

export const adapter = new AdapterFacade();
