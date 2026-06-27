/**
 * useSession —— 连接第一模块（数据适配层）
 *
 * 从 window.TavernDirector 获取 UnifiedSession，
 * 映射为 UI 可用的 UIAppState 片段。
 */

import type { UIAppState, UICharacter, UIMessage, UIWorldBookEntry, UIJailbreakInfo, UISessionSnapshot } from '../store/uiState';

// ─── 数据映射 ─────────────────────────────────────────

export function mapSessionToUI(session: Record<string, unknown> | null): Pick<
  UIAppState,
  'session' | 'characters' | 'messages' | 'worldBooks' | 'jailbreak'
> {
  if (!session) {
    return emptySessionData();
  }

  return {
    session: mapSessionSnapshot(session),
    characters: mapCharacters(session),
    messages: mapMessages(session),
    worldBooks: mapWorldBooks(session),
    jailbreak: mapJailbreak(session),
  };
}

function emptySessionData() {
  return {
    session: {
      sessionId: '', mode: 'live' as const,
      characterCount: 0, messageCount: 0, worldBookCount: 0,
      jailbreakLoaded: false, jailbreakName: '',
    },
    characters: [] as UICharacter[],
    messages: [] as UIMessage[],
    worldBooks: [] as UIWorldBookEntry[],
    jailbreak: { text: '', source: 'none' as const, enabled: false, name: '' },
  };
}

function mapSessionSnapshot(s: Record<string, unknown>): UISessionSnapshot {
  const chars = (s.characters as unknown[]) || [];
  const msgs = (s.messages as unknown[]) || [];
  const wbs = (s.worldBooks as unknown[]) || [];
  const jb = (s.jailbreak || {}) as Record<string, unknown>;

  return {
    sessionId: String(s.sessionId || ''),
    mode: (s.mode === 'live' ? 'live' : 'import') as 'live' | 'import',
    characterCount: chars.length,
    messageCount: msgs.length,
    worldBookCount: wbs.length,
    jailbreakLoaded: Boolean(jb.enabled && jb.text),
    jailbreakName: String(jb.name || ''),
  };
}

function mapCharacters(s: Record<string, unknown>): UICharacter[] {
  const chars = (s.characters || []) as Record<string, unknown>[];
  return chars.map(c => ({
    id: String(c.id || ''),
    name: String(c.name || ''),
    displayName: String(c.displayName || c.name || ''),
    avatar: String(c.avatar || ''),
    model: String(c.model || ''),
    status: (c.status === 'disabled' ? 'disabled' : 'enabled') as 'enabled' | 'disabled',
    isNarrator: Boolean(c.isNarrator),
    isSelected: false,
    prompt: String(c.prompt || ''),
    description: String(c.description || ''),
  }));
}

function mapMessages(s: Record<string, unknown>): UIMessage[] {
  const msgs = (s.messages || []) as Record<string, unknown>[];
  return msgs.map((m, i) => ({
    id: String(m.id || `ui_msg_${i}`),
    role: String(m.role || 'system'),
    speaker: String(m.speaker || m.name || ''),
    content: String(m.content || ''),
    turnIndex: Number(m.turnIndex ?? i),
    isDirectorDecision: false,
  }));
}

function mapWorldBooks(s: Record<string, unknown>): UIWorldBookEntry[] {
  const wbs = (s.worldBooks || []) as Record<string, unknown>[];
  return wbs.map(w => ({
    id: String(w.id || ''),
    title: String(w.title || ''),
    keys: Array.isArray(w.keys) ? w.keys.map(String) : [],
    content: String(w.content || ''),
    hit: false,
    hitReason: '',
    enabled: w.enabled !== false,
    depth: Number(w.depth ?? 0),
    priority: Number(w.priority ?? 10),
  }));
}

function mapJailbreak(s: Record<string, unknown>): UIJailbreakInfo {
  const jb = (s.jailbreak || {}) as Record<string, unknown>;
  return {
    text: String(jb.text || ''),
    source: String(jb.source || 'none'),
    enabled: Boolean(jb.enabled),
    name: String(jb.name || ''),
  };
}

// ─── 连接第一模块 ─────────────────────────────────────

export function fetchFromModule1(): Pick<
  UIAppState,
  'session' | 'characters' | 'messages' | 'worldBooks' | 'jailbreak' | 'mode' | 'connected' | 'status'
> | null {
  const TD1 = (window as unknown as Record<string, unknown>).TavernDirector as
    | { getSnapshot?: () => Record<string, unknown>; getSummary?: () => Record<string, unknown> }
    | undefined;

  if (!TD1?.getSnapshot) {
    return null;
  }

  try {
    const session = TD1.getSnapshot();
    if (!session) return null;

    const mapped = mapSessionToUI(session);

    return {
      ...mapped,
      mode: mapped.session.mode,
      connected: true,
      status: 'ready' as const,
    };
  } catch (e) {
    console.error('[useSession] 读取第一模块失败:', e);
    return null;
  }
}

export function startLiveSync(
  onUpdate: (data: Pick<UIAppState, 'session' | 'characters' | 'messages' | 'worldBooks' | 'jailbreak' | 'mode' | 'connected' | 'status'>) => void,
  intervalMs = 2000
): () => void {
  const TD1 = (window as unknown as Record<string, unknown>).TavernDirector as
    | { startLiveMode?: (cb: (data: Record<string, unknown>) => void, ms: number) => void;
        stopLiveMode?: () => void }
    | undefined;

  if (TD1?.startLiveMode) {
    TD1.startLiveMode((data: Record<string, unknown>) => {
      const session = (data as Record<string, unknown>).session || data;
      const mapped = mapSessionToUI(session as Record<string, unknown>);
      onUpdate({
        ...mapped,
        mode: mapped.session.mode,
        connected: true,
        status: 'ready' as const,
      });
    }, intervalMs);

    return () => {
      TD1.stopLiveMode?.();
    };
  }

  // 兜底：定时轮询
  const timer = setInterval(() => {
    const data = fetchFromModule1();
    if (data) onUpdate(data);
  }, intervalMs);

  return () => clearInterval(timer);
}
