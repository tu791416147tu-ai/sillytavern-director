/**
 * 酒馆导演插件 —— 统一入口
 *
 * 三模块整体架构：
 *   模块一：数据适配层 (adapters/ parsers/ normalizers/ validators/)
 *   模块二：导演调度层 (director/)
 *   模块三：前端UI壳子 (store/ hooks/) → plugin/shell.html
 *
 * 所有对外 API 从这里统一暴露。
 */

// ═══════════════════════════════════════════════════════
// 模块一：数据适配层
// ═══════════════════════════════════════════════════════

export { AdapterFacade, adapter } from './adapters/facade';
export type { SessionSummary } from './adapters/facade';

export {
  TavernLiveLoader, tavernLiveLoader,
  FileLoader, fileLoader, detectFileCategory,
  ImageCardLoader, imageCardLoader,
  PresetLoader, presetLoader,
} from './adapters';
export type { FileCategory, RawSourceData, RawMessage, RawCharacter, RawWorldBookEntry } from './adapters';

export { parseRawData, parseJailbreakText, parseCharacterText, parseChatText, OCRParser, ocrParser } from './parsers';
export type { ParsedCharacter, ParsedMessage, ParsedWorldBookEntry, ParsedData, OCRResult, OCRCallback } from './parsers';

export {
  normalizeCharacter, normalizeCharacters, generateCharId,
  normalizeMessage, normalizeMessages, generateMsgId,
  normalizeWorldBookEntry, normalizeWorldBookEntries, generateWBId,
} from './normalizers';

export { validateSession, validateOrThrow } from './validators/validateSession';
export type { ValidationResult, ValidationIssue, ValidationSeverity } from './validators/validateSession';

// ═══════════════════════════════════════════════════════
// 模块二：导演调度层
// ═══════════════════════════════════════════════════════

export { DirectorFacade } from './director/facade';

export type {
  DirectorMode, DispatchPriority, WakeReason, RoleDispatchStatus, OrderStrategy,
  DirectorRequest, DirectorConfig,
  RoleSelectionScore, WorldBookSelectionScore,
  DirectorDecision, RoleContextBundle, RoleDispatchPayload,
  DirectorPromptBundle, DirectorPlan, ContextSummary,
} from './director/types';

export {
  nowId, clamp, uniq, normalizeText, textContainsAny, takeLast, safeJoin, keywordHitScore,
} from './director/utils';

export {
  buildContextSummary, selectVisibleMessages, selectRelevantWorldBooks,
  buildRoleContextBundle, summarizeMessages,
} from './director/context';

export { scoreRoles, scoreWorldBooks, pickSelectedRoles, sortSelectedRoles, resolveWakeReasons } from './director/scorer';
export { buildDirectorPrompt, buildRolePrompt, buildPromptBundle } from './director/prompt';

// ═══════════════════════════════════════════════════════
// 模块三：前端UI壳子
// ═══════════════════════════════════════════════════════

export { UIStore, store, createInitialState } from './store/uiState';
export type {
  UIAppState, UIStatus, UIMode, DirectorRunState, PanelKey,
  UISessionSnapshot, UICharacter, UIMessage, UIWorldBookEntry,
  UIJailbreakInfo, UIDirectorLog, UIDirectorState, UIAction, UIActionType,
} from './store/uiState';

export { mapSessionToUI, fetchFromModule1, startLiveSync } from './hooks/useSession';
export { runDirector, markDirectorSelections } from './hooks/useDirector';
export type { DirectorRunOptions } from './hooks/useDirector';

// ═══════════════════════════════════════════════════════
// 共享模型类型
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// 模块四：角色执行层
// ═══════════════════════════════════════════════════════

export {
  buildRoleContext, buildAllRoleContexts, estimateContextTokens,
  ModelRouter, createModelRouter,
  assembleRolePrompt, assembleDirectorPrompt,
  estimatePromptTokens, isPromptOverLimit, trimPromptToLimit,
  ExecutionEngine,
  normalizeOutput, normalizeOutputs, detectEcho,
  Writer, createWriter,
  DEFAULT_EXECUTION_CONFIG,
} from './role-engine';

export type {
  ExecutionMode, TaskStatus, OutputStatus, RouteLevel,
  RoleContext, RoleTask, RoleOutput,
  ModelRouteConfig, ExecutionConfig, ExecutionReport,
  ContextBuildOptions,
  RouteResult,
  PromptAssembleOptions,
  GenerateCallback, GenerateResult,
  NormalizeOptions,
  WriteCallback, WriteCompleteCallback, WriteMessage,
} from './role-engine';

// ═══════════════════════════════════════════════════════
// 共享模型类型
// ═══════════════════════════════════════════════════════

export type {
  UnifiedSession, AdapterMode, DialogueMode, SessionSettings, SourceMeta,
  Character, CharacterStatus, CharacterMeta,
  Message, MessageRole, MessageMeta,
  WorldBookEntry, TriggerType, WorldBookTarget,
  JailbreakConfig, JailbreakSource,
} from './models';
export { createEmptyJailbreak } from './models';
