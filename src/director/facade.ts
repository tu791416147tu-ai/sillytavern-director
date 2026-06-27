import type { UnifiedSession } from '../models/session';
import type { Character } from '../models/character';
import { nowId, uniq } from './utils';
import { buildContextSummary, buildRoleContextBundle, selectRelevantWorldBooks } from './context';
import { buildPromptBundle, buildRolePrompt } from './prompt';
import { pickSelectedRoles, resolveWakeReasons, scoreRoles, scoreWorldBooks, sortSelectedRoles } from './scorer';
import type {
  DirectorRequest,
  DirectorConfig,
  DirectorDecision,
  DirectorPlan,
  RoleDispatchPayload,
  WakeReason,
  DispatchPriority,
} from './types';

const DEFAULT_CONFIG: DirectorConfig = {
  mode: 'sequential',
  dialogueMode: 'sequential',
  maxRoles: 3,
  maxWorldBooks: 6,
  recentMessages: 12,
  orderStrategy: 'score',
  allowParallel: true,
  includeNarrator: true,
  includeDisabled: false,
  preferSpeakerContinuity: true,
  topicThreshold: 1,
};

export class DirectorFacade {
  constructor(private readonly baseConfig: Partial<DirectorConfig> = {}) {}

  getConfig(request?: Partial<DirectorRequest>): DirectorConfig {
    return {
      ...DEFAULT_CONFIG,
      ...this.baseConfig,
      mode: request?.modeOverride || this.baseConfig.mode || DEFAULT_CONFIG.mode,
      maxRoles: request?.maxRoles ?? this.baseConfig.maxRoles ?? DEFAULT_CONFIG.maxRoles,
      maxWorldBooks: request?.maxWorldBooks ?? this.baseConfig.maxWorldBooks ?? DEFAULT_CONFIG.maxWorldBooks,
      recentMessages: request?.recentMessages ?? this.baseConfig.recentMessages ?? DEFAULT_CONFIG.recentMessages,
      orderStrategy: request?.orderStrategy ?? this.baseConfig.orderStrategy ?? DEFAULT_CONFIG.orderStrategy,
      allowParallel: request?.allowParallel ?? this.baseConfig.allowParallel ?? DEFAULT_CONFIG.allowParallel,
    };
  }

  planTurn(request: DirectorRequest): DirectorPlan {
    const config = this.getConfig(request);
    const session = request.session;

    const roleScores = scoreRoles(session, request, config);
    const selectedRoleIds = pickSelectedRoles(roleScores, config.maxRoles);
    const orderedRoleIds = sortSelectedRoles(roleScores, selectedRoleIds, config.orderStrategy);
    const selectedRoles = session.characters.filter((c) => selectedRoleIds.includes(c.id));

    const worldBookScores = scoreWorldBooks(session, request, selectedRoles, config);
    const selectedWorldBookIds = worldBookScores.slice(0, config.maxWorldBooks).map((x) => x.entryId);

    const decision: DirectorDecision = {
      mode: config.mode,
      planId: nowId('plan'),
      sessionId: session.sessionId,
      selectedRoleIds,
      orderedRoleIds,
      skippedRoleIds: session.characters.map((c) => c.id).filter((id) => !selectedRoleIds.includes(id)),
      roleScores,
      worldBookScores,
      selectedWorldBookIds,
      reason: this.makeDecisionReason(session, selectedRoles, selectedWorldBookIds),
      timestamp: Date.now(),
    };

    const contexts = this.buildContexts({
      session,
      config,
      selectedRoles,
      selectedWorldBookIds,
      request,
    });

    const payloads = this.buildPayloads({
      session,
      config,
      orderedRoleIds,
      contexts,
      decision,
    });

    const promptBundle = buildPromptBundle({ request, config, decision, payloads });

    return {
      request,
      config,
      decision,
      contexts,
      payloads,
      promptBundle,
    };
  }

  buildRolePayloads(plan: DirectorPlan): RoleDispatchPayload[] {
    return plan.payloads;
  }

  renderDirectorPrompt(plan: DirectorPlan): string {
    return plan.promptBundle.directorPrompt;
  }

  renderRolePrompt(plan: DirectorPlan, roleId: string): string {
    return plan.promptBundle.rolePrompts[roleId] || '';
  }

  summarizeSession(session: UnifiedSession) {
    return buildContextSummary(session);
  }

  private buildContexts(params: {
    session: UnifiedSession;
    config: DirectorConfig;
    selectedRoles: Character[];
    selectedWorldBookIds: string[];
    request: DirectorRequest;
  }) {
    const { session, config, selectedRoles, selectedWorldBookIds, request } = params;
    const focusWorldBooks = session.worldBooks.filter((wb) => selectedWorldBookIds.includes(wb.id));
    const contexts: Record<string, ReturnType<typeof buildRoleContextBundle>> = {};

    for (const role of selectedRoles) {
      let relevant = focusWorldBooks.length
        ? focusWorldBooks.filter((wb) => wb.target === 'global' || wb.target === 'session' || wb.characterId === role.id)
        : selectRelevantWorldBooks(session, request.latestUserMessage || '', config.maxWorldBooks, role);

      // 预选的世界书条目如果没有匹配当前角色，回退到全局选择
      if (focusWorldBooks.length > 0 && relevant.length === 0) {
        relevant = selectRelevantWorldBooks(session, request.latestUserMessage || '', config.maxWorldBooks, role);
      }

      const wakeReason = resolveWakeReasons(role, session, request, config);
      const priority = this.resolvePriority(wakeReason);
      contexts[role.id] = buildRoleContextBundle({
        session,
        role,
        config,
        selectedWorldBooks: relevant,
        wakeReason,
        priority,
      });
    }

    return contexts;
  }

  private buildPayloads(params: {
    session: UnifiedSession;
    config: DirectorConfig;
    orderedRoleIds: string[];
    contexts: Record<string, ReturnType<typeof buildRoleContextBundle>>;
    decision: DirectorDecision;
  }): RoleDispatchPayload[] {
    const { session, orderedRoleIds, contexts } = params;
    const result: RoleDispatchPayload[] = [];
    for (let index = 0; index < orderedRoleIds.length; index++) {
      const roleId = orderedRoleIds[index];
      const role = session.characters.find((c) => c.id === roleId);
      const context = contexts[roleId];
      if (!role || !context) continue;
      const payload: RoleDispatchPayload = {
        roleId,
        roleName: role.displayName,
        model: role.model || '',
        status: 'queued' as RoleDispatchPayload['status'],
        orderIndex: index,
        context,
        prompt: '',
      };
      payload.prompt = buildRolePrompt(payload);
      result.push(payload);
    }
    return result;
  }

  private makeDecisionReason(session: UnifiedSession, selectedRoles: Character[], worldBookIds: string[]): string {
    const roleNames = selectedRoles.map((r) => r.displayName).join('、') || '无';
    const wbCount = worldBookIds.length;
    return `选择角色：${roleNames}；激活世界书：${wbCount} 条；会话消息：${session.messages.filter((m) => m.visible !== false).length} 条。`;
  }

  private resolvePriority(reasons: WakeReason[]): DispatchPriority {
    if (reasons.includes('manual')) return 'high';
    if (reasons.includes('mention') || reasons.includes('speaker-continuity')) return 'normal';
    return 'low';
  }
}
