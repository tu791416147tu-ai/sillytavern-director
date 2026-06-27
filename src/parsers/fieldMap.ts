/**
 * 字段映射表 —— 把不同来源的字段名统一到内部名称
 *
 * 规则：
 *  1. 先找最常见字段（数组第一个）
 *  2. 找不到就找别名
 *  3. 再找嵌套字段（用 "." 分隔，如 "data.name"）
 *  4. 都没有就用默认值
 *
 * 新增来源只需在此表追加别名即可，无需改业务逻辑。
 */

// ─── 角色字段映射 ─────────────────────────────────────
export const CHARACTER_FIELD_MAP: Record<string, string[]> = {
  name:        ['name', 'char_name', 'character_name', 'characterName', 'title', 'display_name', 'displayName'],
  displayName: ['display_name', 'displayName', 'display_name', 'alias', 'nickname'],
  description: ['description', 'desc', 'personality', 'char_description', 'characterDescription', 'data.description'],
  prompt:      ['system_prompt', 'systemPrompt', 'prompt', 'char_prompt', 'personality', 'data.system_prompt'],
  avatar:      ['avatar', 'image', 'portrait', 'icon', 'data.avatar'],
  model:       ['model', 'preferred_model', 'ai_model', 'llm', 'data.model'],
  firstMessage:['first_mes', 'firstMessage', 'greeting', 'intro', 'data.first_mes'],
  scenario:    ['scenario', 'world_scenario', 'background', 'data.scenario'],
  mesExample:  ['mes_example', 'exampleMessages', 'chat_examples', 'examples', 'data.mes_example'],
  creator:     ['creator', 'author', 'created_by', 'data.creator'],
  tags:        ['tags', 'categories', 'keywords', 'data.tags'],
  cardVersion: ['spec', 'card_version', 'spec_version', 'data.spec'],
};

// ─── 消息字段映射 ─────────────────────────────────────
export const MESSAGE_FIELD_MAP: Record<string, string[]> = {
  id:        ['id', 'message_id', 'msg_id', 'messageId'],
  role:      ['role', 'type', 'sender_role', 'message_role'],
  speaker:   ['name', 'speaker', 'character', 'sender', 'character_name', 'characterName'],
  content:   ['content', 'text', 'mes', 'message', 'body'],
  timestamp: ['timestamp', 'time', 'created_at', 'createdAt', 'send_time', 'sendTime', 'date'],
  turnIndex: ['turn', 'turn_index', 'turnIndex', 'swipe_id', 'swipeId'],
  swipeId:   ['swipe_id', 'swipeId', 'swipe_index', 'swipeIndex'],
  swipes:    ['swipes', 'alternatives', 'alt_messages'],
  model:     ['model', 'llm', 'ai_model', 'generated_by'],
};

// ─── 世界书字段映射 ───────────────────────────────────
export const WORLDBOOK_FIELD_MAP: Record<string, string[]> = {
  id:            ['uid', 'id', 'entry_id', 'entryId', 'key'],
  title:         ['comment', 'title', 'name', 'label'],
  keys:          ['key', 'keys', 'keywords', 'triggers', 'primary_keys'],
  secondaryKeys: ['secondary_keys', 'secondaryKeys', 'alt_keys', 'secondary'],
  content:       ['content', 'text', 'entry', 'description', 'value'],
  depth:         ['depth', 'insertion_depth', 'insertionDepth', 'order'],
  triggerType:   ['trigger_type', 'triggerType', 'type'],
  priority:      ['priority', 'order', 'weight', 'rank'],
  enabled:       ['enabled', 'active', 'is_enabled', 'isEnabled', 'disable'],
  target:        ['target', 'scope', 'apply_to'],
  selective:     ['selective', 'is_selective', 'selectiveLogic'],
  constant:      ['constant', 'is_constant', 'always_on', 'alwaysOn'],
  position:      ['position', 'insert_position', 'insertPosition', 'placement'],
  scanDepth:     ['scan_depth', 'scanDepth', 'recursive_depth', 'recursiveDepth'],
};

// ─── 全局别名映射（跨所有类别） ────────────────────────
export const GLOBAL_ALIASES: Record<string, string[]> = {
  worldBooks:   ['worldBooks', 'worldbooks', 'worldInfo', 'world_info', 'worldinfo', 'lorebook', 'lore', 'entries'],
  jailbreak:    ['jailbreak', 'systemPrompt', 'system_prompt', 'preset', 'prompt', 'main_prompt'],
  characters:   ['characters', 'chars', 'char_list', 'characterList', 'participants', 'members'],
  messages:     ['messages', 'chat', 'history', 'conversation', 'dialogue', 'msgs'],
  chatId:       ['chatId', 'chat_id', 'sessionId', 'session_id', 'conversationId'],
};
