import type { DirectorDecision, DirectorPromptBundle, RoleDispatchPayload, DirectorConfig, DirectorRequest, DirectorPlan } from './types';
import { safeJoin } from './utils';

export function buildDirectorPrompt(plan: Pick<DirectorPlan, 'request' | 'decision' | 'config'>): string {
  const { request, decision, config } = plan;
  return safeJoin([
    '【身份】',
    '你是群聊导演 AI，负责决定本轮哪些角色发言，不直接代替角色发言。',
    '',
    '【当前会话】',
    `会话ID：${decision.sessionId}`,
    `调度模式：${config.dialogueMode}`,
    '',
    '【本轮决策】',
    `唤醒角色：${decision.selectedRoleIds.join('、') || '无'}`,
    `发言顺序：${decision.orderedRoleIds.join(' → ') || '无'}`,
    `激活世界书：${decision.selectedWorldBookIds.join('、') || '无'}`,
    `跳过角色：${decision.skippedRoleIds.join('、') || '无'}`,
    '',
    request.latestUserMessage ? `【用户最新输入】\n${request.latestUserMessage}` : '',
    '',
    '【输出要求】',
    '1. 只给出调度结果，不要伪装成任意角色。',
    '2. 明确指出谁先说、谁后说、谁不说。',
    '3. 简要说明选择原因。',
  ]);
}

export function buildRolePrompt(payload: RoleDispatchPayload): string {
  const { context, roleName } = payload;
  const role = context.role;

  // 按 position 分组世界书（与 promptAssembler 保持一致）
  const beforeChar = context.selectedWorldBooks.filter(w => w.position === 'before_char');
  const afterChar = context.selectedWorldBooks.filter(w => w.position === 'after_char');
  const inChat = context.selectedWorldBooks.filter(w => w.position === 'in_chat');

  function formatWB(entries: typeof context.selectedWorldBooks): string {
    if (!entries.length) return '';
    return entries.map(w => `【${w.title}】${w.content}`).join('\n\n');
  }

  const visibleChat = context.visibleMessages.map((m) => `${m.speaker}: ${m.content}`).join('\n');

  // 公共场景信息（其他在场角色）
  const otherNames = context.visibleMessages
    .map(m => m.speaker)
    .filter((s, i, arr) => s && s !== roleName && arr.indexOf(s) === i)
    .slice(0, 8);

  return safeJoin([
    // 1. 身份
    `【你的身份】`,
    `你是 ${roleName}。`,
    '',
    // 2. 角色设定
    '【角色设定】',
    role.prompt || '无',
    role.description && role.description !== role.prompt ? `\n【补充描述】\n${role.description}` : '',
    '',
    // 3. 世界书（before_char — 前置设定）
    formatWB(beforeChar),
    '',
    // 4. 导演提示
    '【本轮指令】',
    context.directorNote,
    '',
    // 5. 场景信息
    otherNames.length ? `【在场角色】\n${otherNames.join('、')}` : '',
    '',
    // 6. 公开聊天
    '【公开聊天记录】',
    visibleChat || '（暂无）',
    '',
    // 7. 世界书（in_chat — 内联参考）
    formatWB(inChat),
    '',
    // 8. 世界书（after_char — 补充设定）
    formatWB(afterChar),
    '',
    // 9. 输出要求
    '【输出要求】',
    '1. 只输出该角色的对话/动作内容，不要添加解释或前缀。',
    '2. 不要替其他角色说话或替其他角色做决定。',
    '3. 保持角色设定和语气一致。',
  ]);
}

export function buildPromptBundle(plan: Pick<DirectorPlan, 'request' | 'config' | 'decision' | 'payloads'>): DirectorPromptBundle {
  const rolePrompts: Record<string, string> = {};
  for (const payload of plan.payloads) {
    rolePrompts[payload.roleId] = buildRolePrompt(payload);
  }
  return {
    directorPrompt: buildDirectorPrompt(plan),
    rolePrompts,
  };
}
