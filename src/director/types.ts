import type { UnifiedSession, AdapterMode } from '../models/session';
import type { Character } from '../models/character';
import type { Message } from '../models/message';
import type { WorldBookEntry } from '../models/worldbook';

export type DirectorMode = 'sequential' | 'parallel' | 'manual' | 'silent';
export type DispatchPriority = 'high' | 'normal' | 'low';
export type WakeReason = 'mention' | 'speaker-continuity' | 'topic-match' | 'manual' | 'narrator' | 'fallback' | 'cooldown-heavy' | 'cooldown-light';
export type RoleDispatchStatus = 'pending' | 'queued' | 'running' | 'done' | 'skipped' | 'failed';
export type OrderStrategy = 'score' | 'fixed' | 'round-robin';

export interface DirectorRequest {
  session: UnifiedSession;
  latestUserMessage?: string;
  manualSpeakerId?: string;
  manualSpeakerIds?: string[];
  modeOverride?: DirectorMode;
  maxRoles?: number;
  maxWorldBooks?: number;
  recentMessages?: number;
  orderStrategy?: OrderStrategy;
  seed?: number;
  allowParallel?: boolean;
}

export interface DirectorConfig {
  mode: DirectorMode;
  dialogueMode: 'sequential' | 'parallel';
  maxRoles: number;
  maxWorldBooks: number;
  recentMessages: number;
  orderStrategy: OrderStrategy;
  allowParallel: boolean;
  includeNarrator: boolean;
  includeDisabled: boolean;
  preferSpeakerContinuity: boolean;
  topicThreshold: number;
}

export interface RoleSelectionScore {
  roleId: string;
  score: number;
  reasons: WakeReason[];
  priority: DispatchPriority;
}

export interface WorldBookSelectionScore {
  entryId: string;
  score: number;
  reasons: string[];
}

export interface DirectorDecision {
  mode: DirectorMode;
  planId: string;
  sessionId: string;
  selectedRoleIds: string[];
  orderedRoleIds: string[];
  skippedRoleIds: string[];
  roleScores: RoleSelectionScore[];
  worldBookScores: WorldBookSelectionScore[];
  selectedWorldBookIds: string[];
  reason: string;
  timestamp: number;
}

export interface RoleContextBundle {
  role: Character;
  visibleMessages: Message[];
  selectedWorldBooks: WorldBookEntry[];
  publicSummary: string;
  directorNote: string;
  wakeReason: WakeReason[];
  priority: DispatchPriority;
}

export interface RoleDispatchPayload {
  roleId: string;
  roleName: string;
  model: string;
  status: RoleDispatchStatus;
  orderIndex: number;
  context: RoleContextBundle;
  prompt: string;
}

export interface DirectorPromptBundle {
  directorPrompt: string;
  rolePrompts: Record<string, string>;
}

export interface DirectorPlan {
  request: DirectorRequest;
  config: DirectorConfig;
  decision: DirectorDecision;
  contexts: Record<string, RoleContextBundle>;
  payloads: RoleDispatchPayload[];
  promptBundle: DirectorPromptBundle;
}

export interface ContextSummary {
  sessionId: string;
  mode: AdapterMode;
  characterCount: number;
  messageCount: number;
  worldBookCount: number;
  latestSpeaker: string;
  latestMessage: string;
}
