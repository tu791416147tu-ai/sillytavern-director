/**
 * useDirector —— 连接第二模块（导演调度层）
 *
 * 把 window.TavernDirector 的 planTurn 结果
 * 映射为 UI 可展示的导演日志和角色选中状态。
 */

import type { UIDirectorLog, UICharacter, UIWorldBookEntry } from '../store/uiState';

// ─── 调用导演层 ───────────────────────────────────────

export interface DirectorRunOptions {
  latestUserMessage?: string;
  manualSpeakerId?: string;
  maxRoles?: number;
  modeOverride?: string;
}

export function runDirector(options: DirectorRunOptions): {
  directorLog: UIDirectorLog;
  updatedCharacters: UICharacter[];
  updatedWorldBooks: UIWorldBookEntry[];
} | null {
  // 统一从 window.TavernDirector 获取所有模块
  const TD = (window as unknown as Record<string, unknown>).TavernDirector as
    | {
        getSnapshot?: () => Record<string, unknown>;
        quickPlan?: (session: Record<string, unknown>, opts: Record<string, unknown>) => Record<string, unknown>;
        autoPlan?: (opts: Record<string, unknown>) => Record<string, unknown>;
        director?: {
          planTurn?: (session: Record<string, unknown>, opts: Record<string, unknown>) => Record<string, unknown>;
          autoPlan?: (opts: Record<string, unknown>) => Record<string, unknown>;
        };
      }
    | undefined;

  if (!TD) {
    console.error('[useDirector] 未找到插件 (window.TavernDirector)');
    return null;
  }

  // 优先用顶层 quickPlan/autoPlan，其次用 director 子模块
  const quickPlan = TD.quickPlan || TD.director?.planTurn;
  const autoPlan = TD.autoPlan || TD.director?.autoPlan;

  if (!autoPlan && !quickPlan) {
    console.error('[useDirector] 未找到导演调度方法');
    return null;
  }

  const startTime = performance.now();

  try {
    let plan: Record<string, unknown>;

    if (quickPlan) {
      const session = TD.getSnapshot?.() || {};
      plan = quickPlan(session, options as Record<string, unknown>);
    } else {
      plan = autoPlan!(options as Record<string, unknown>) as Record<string, unknown>;
    }

    if (!plan) return null;

    const duration = Math.round(performance.now() - startTime);
    const decision = (plan.decision || {}) as Record<string, unknown>;

    const directorLog: UIDirectorLog = {
      id: String(decision.planId || `log_${Date.now()}`),
      timestamp: Date.now(),
      planId: String(decision.planId || ''),
      mode: String(decision.mode || 'sequential'),
      selectedRoles: (decision.selectedRoleIds as string[]) || [],
      orderedRoles: (decision.orderedRoleIds as string[]) || [],
      skippedRoles: (decision.skippedRoleIds as string[]) || [],
      reason: String(decision.reason || ''),
      worldBookCount: ((decision.selectedWorldBookIds as unknown[]) || []).length,
      duration,
    };

    // 更新角色选中状态
    const selectedSet = new Set(directorLog.selectedRoles);
    const updatedCharacters: UICharacter[] = [];  // 由调用方合并

    // 更新世界书命中状态
    const wbHitSet = new Set((decision.selectedWorldBookIds as string[]) || []);
    const updatedWorldBooks: UIWorldBookEntry[] = [];

    return { directorLog, updatedCharacters, updatedWorldBooks };
  } catch (e) {
    console.error('[useDirector] 调度执行失败:', e);
    return null;
  }
}

// ─── 标记角色和世界书选中状态 ─────────────────────────

export function markDirectorSelections(
  characters: UICharacter[],
  worldBooks: UIWorldBookEntry[],
  selectedRoleIds: string[],
  selectedWBIds: string[]
): { characters: UICharacter[]; worldBooks: UIWorldBookEntry[] } {
  const roleSet = new Set(selectedRoleIds);
  const wbSet = new Set(selectedWBIds);

  return {
    characters: characters.map(c => ({
      ...c,
      isSelected: roleSet.has(c.id),
    })),
    worldBooks: worldBooks.map(w => ({
      ...w,
      hit: wbSet.has(w.id),
      hitReason: wbSet.has(w.id) ? '导演选中' : '',
    })),
  };
}
