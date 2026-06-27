/**
 * UI 状态管理 —— 单一数据源
 *
 * 前端只接收这个统一状态对象，不直接碰底层逻辑。
 * 用户操作只发 action，不自己做业务判断。
 */

// ─── 前端接收的统一状态 ───────────────────────────────

export type UIStatus = 'empty' | 'loading' | 'ready' | 'error';
export type UIMode = 'live' | 'import';
export type DirectorRunState = 'idle' | 'thinking' | 'running' | 'done' | 'error';
export type PanelKey = 'worldbook' | 'jailbreak' | 'directorLog' | 'session';

export interface UISessionSnapshot {
  sessionId: string;
  mode: UIMode;
  characterCount: number;
  messageCount: number;
  worldBookCount: number;
  jailbreakLoaded: boolean;
  jailbreakName: string;
}

export interface UICharacter {
  id: string;
  name: string;
  displayName: string;
  avatar: string;
  model: string;
  status: 'enabled' | 'disabled';
  isNarrator: boolean;
  isSelected: boolean;       // 本轮是否被导演选中
  prompt: string;
  description: string;
}

export interface UIMessage {
  id: string;
  role: string;
  speaker: string;
  content: string;
  turnIndex: number;
  isDirectorDecision: boolean;  // 是否是导演决策消息（插入的调度说明）
}

export interface UIWorldBookEntry {
  id: string;
  title: string;
  keys: string[];
  content: string;
  hit: boolean;             // 本轮是否命中
  hitReason: string;        // 命中原因
  enabled: boolean;
  depth: number;
  priority: number;
}

export interface UIJailbreakInfo {
  text: string;
  source: string;
  enabled: boolean;
  name: string;
}

export interface UIDirectorLog {
  id: string;
  timestamp: number;
  planId: string;
  mode: string;
  selectedRoles: string[];
  orderedRoles: string[];
  skippedRoles: string[];
  reason: string;
  worldBookCount: number;
  duration?: number;
  error?: string;
}

export interface UIDirectorState {
  status: DirectorRunState;
  lastDecision: UIDirectorLog | null;
  logs: UIDirectorLog[];
}

export interface UIAppState {
  /** 全局状态 */
  status: UIStatus;
  mode: UIMode;
  connected: boolean;
  error: string;

  /** 会话摘要 */
  session: UISessionSnapshot;

  /** 数据 */
  characters: UICharacter[];
  messages: UIMessage[];
  worldBooks: UIWorldBookEntry[];
  jailbreak: UIJailbreakInfo;

  /** 导演状态 */
  director: UIDirectorState;

  /** 面板折叠状态 */
  panels: Record<PanelKey, boolean>;

  /** 正在加载的文本 */
  loadingText: string;
}

// ─── 前端发出的动作 ───────────────────────────────────

export type UIActionType =
  | 'SWITCH_MODE'
  | 'REFRESH'
  | 'DIRECTOR_RUN'
  | 'ROLE_TALK'
  | 'TOGGLE_ROLE'
  | 'IMPORT_FILE'
  | 'TOGGLE_PANEL'
  | 'SELECT_ROLE_PREVIEW'
  | 'CLEAR_LOGS'
  | 'STOP_DIRECTOR';

export interface UIAction {
  type: UIActionType;
  payload?: Record<string, unknown>;
}

// ─── 初始状态 ─────────────────────────────────────────

export function createInitialState(): UIAppState {
  return {
    status: 'empty',
    mode: 'live',
    connected: false,
    error: '',
    session: {
      sessionId: '',
      mode: 'live',
      characterCount: 0,
      messageCount: 0,
      worldBookCount: 0,
      jailbreakLoaded: false,
      jailbreakName: '',
    },
    characters: [],
    messages: [],
    worldBooks: [],
    jailbreak: { text: '', source: 'none', enabled: false, name: '' },
    director: {
      status: 'idle',
      lastDecision: null,
      logs: [],
    },
    panels: {
      worldbook: true,
      jailbreak: false,
      directorLog: true,
      session: true,
    },
    loadingText: '',
  };
}

// ─── 简易 Store ───────────────────────────────────────

export type StateListener = (state: UIAppState) => void;

export class UIStore {
  private state: UIAppState;
  private listeners: Set<StateListener> = new Set();

  constructor() {
    this.state = createInitialState();
  }

  getState(): UIAppState {
    return this.state;
  }

  setState(partial: Partial<UIAppState>): void {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  /** 深度合并 director 字段 */
  updateDirector(partial: Partial<UIDirectorState>): void {
    this.state = {
      ...this.state,
      director: { ...this.state.director, ...partial },
    };
    this.notify();
  }

  /** 追加导演日志 */
  appendDirectorLog(log: UIDirectorLog): void {
    this.state = {
      ...this.state,
      director: {
        ...this.state.director,
        lastDecision: log,
        logs: [log, ...this.state.director.logs].slice(0, 50), // 最多保留 50 条
      },
    };
    this.notify();
  }

  /** 切换面板折叠 */
  togglePanel(key: PanelKey): void {
    this.state = {
      ...this.state,
      panels: {
        ...this.state.panels,
        [key]: !this.state.panels[key],
      },
    };
    this.notify();
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach(fn => {
      try { fn(this.state); } catch { /* 隔离监听器异常 */ }
    });
  }
}

/** 全局单例 */
export const store = new UIStore();
