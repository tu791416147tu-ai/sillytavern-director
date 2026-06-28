(function () {
    'use strict';

    /**
     * 原始来源数据 —— Loader 层的输出，Parser 层的输入
     *
     * 这个结构是"半成品"，字段名保留原始来源的命名，
     * 由后续的 Parser + Normalizer 将其转化为 UnifiedSession。
     */
    /** 创建空 RawSourceData */
    function createEmptyRawData(source = 'unknown') {
        return {
            source,
            characters: [],
            messages: [],
            worldBooks: [],
            jailbreak: '',
            jailbreakName: '',
            tavernVersion: '',
            extras: {},
        };
    }

    /**
     * TavernLiveLoader —— 从酒馆当前页面实时读取会话状态
     *
     * 读取范围：
     *  - 当前聊天记录
     *  - 当前角色卡
     *  - 当前世界书（从角色扩展数据 / 全局 WI）
     *  - 当前系统提示/破限
     *  - 群聊成员
     *
     * 基于 SillyTavern 真实扩展 API: SillyTavern.getContext()
     *
     * 官方文档确认的 context 字段：
     *   context.chat         → 聊天消息数组
     *   context.characters   → 角色对象/数组
     *   context.generateRaw({systemPrompt, prompt, prefill})
     *
     * World Info（世界书）和 Preset（预设破限）没有独立的 getter 方法，
     * 需要通过以下路径尝试获取：
     *   - 世界书：context.worldInfo / character.data.extensions.world_info
     *   - 破限：   context.preset / character.system_prompt / 角色卡内置 prompt
     *   - 聊天 ID：context.chatId / context.characterId
     */
    // ─── 工具函数 ─────────────────────────────────────────
    function safeGet(fn, fallback) {
        try {
            return fn();
        }
        catch {
            return fallback;
        }
    }
    /**
     * 获取 ST 全局对象（兼容两种挂载名）
     */
    function getST$1() {
        return window.SillyTavern || window.ST || null;
    }
    // ─── 主 Loader ────────────────────────────────────────
    class TavernLiveLoader {
        constructor() {
            this.lastSnapshot = null;
            this.watchInterval = null;
        }
        /**
         * 从酒馆当前页面读取完整会话状态
         */
        read() {
            const st = getST$1();
            if (!st) {
                throw new Error('[TavernLiveLoader] 未检测到 SillyTavern 全局对象。请确认插件已正确加载到酒馆页面。');
            }
            const ctx = safeGet(() => st.getContext(), {});
            if (!ctx || typeof ctx !== 'object') {
                throw new Error('[TavernLiveLoader] SillyTavern.getContext() 返回了无效值。请确认酒馆已在页面中正确初始化。');
            }
            const raw = createEmptyRawData('tavern-live');
            // ── 聊天 ID ──────────────────────────────
            raw.extras.currentChatId =
                ctx.chatId || ctx.characterId || '';
            // ── 读取角色 ──────────────────────────────
            raw.characters = this.readCharacters(ctx);
            // ── 读取消息 ──────────────────────────────
            raw.messages = this.readMessages(ctx);
            // ── 读取世界书 ────────────────────────────
            raw.worldBooks = this.readWorldBooks(ctx, raw.characters);
            // ── 读取破限/系统提示 ─────────────────────
            const jailbreak = this.readJailbreak(ctx, raw.characters);
            raw.jailbreak = jailbreak.text;
            raw.jailbreakName = jailbreak.name;
            // ── 群聊 ID ─────────────────────────────
            if (ctx.groupId) {
                raw.extras.groupId = ctx.groupId;
            }
            this.lastSnapshot = raw;
            return raw;
        }
        /**
         * 获取最后读取的快照（不重新读取）
         */
        getSnapshot() {
            return this.lastSnapshot;
        }
        /**
         * 监听变化：每隔 intervalMs 轮询一次，
         * 数据有变化时回调 onChange
         */
        watch(onChange, intervalMs = 2000) {
            this.stopWatch();
            // 先立即触发一次
            try {
                onChange(this.read());
            }
            catch {
                /* 静默失败，等下次轮询 */
            }
            this.watchInterval = setInterval(() => {
                try {
                    const prev = this.lastSnapshot;
                    const current = this.read();
                    if (!prev || this.hasChanged(prev, current)) {
                        onChange(current);
                    }
                }
                catch {
                    /* 轮询失败不中断定时器 */
                }
            }, intervalMs);
            return () => this.stopWatch();
        }
        /**
         * 停止监听
         */
        stopWatch() {
            if (this.watchInterval !== null) {
                clearInterval(this.watchInterval);
                this.watchInterval = null;
            }
        }
        // ── 各读取子模块（便于独立测试/覆写） ────────
        /**
         * 从 context 读取角色列表。
         *
         * context.characters 可能是对象（keyed by name/id）或数组。
         */
        readCharacters(ctx) {
            return safeGet(() => {
                const chars = ctx.characters;
                if (!chars)
                    return [];
                // 如果是对象（key → character），取 values
                if (!Array.isArray(chars)) {
                    return Object.values(chars).map(c => ({ ...c }));
                }
                // 已是数组
                return chars.map(c => ({ ...c }));
            }, []);
        }
        /**
         * 从 context 读取聊天消息列表。
         *
         * ST 消息原始字段: name, is_user, is_system, mes, send_date, swipes, swipe_id, extra
         * 保留全部原始字段，由后续 normalizer 统一为标准 Message 格式。
         */
        readMessages(ctx) {
            return safeGet(() => {
                const chat = ctx.chat;
                if (!Array.isArray(chat))
                    return [];
                return chat.map(m => ({ ...m }));
            }, []);
        }
        /**
         * 从 context 读取世界书条目。
         *
         * 尝试路径（按优先级）：
         *   1. context.worldInfo.entries            — 全局世界书
         *   2. 各角色 data.extensions.world_info    — 角色绑定的世界书
         *   3. 角色 data.extensions.world           — 另一种常见的 key
         */
        readWorldBooks(ctx, rawChars) {
            const entries = [];
            // 路径1：全局世界书
            try {
                const wi = ctx.worldInfo;
                if (wi?.entries && typeof wi.entries === 'object') {
                    entries.push(...Object.values(wi.entries).map(e => ({ ...e })));
                }
            }
            catch { /* 忽略 */ }
            // 路径2/3：从角色扩展数据中提取角色绑定的世界书
            if (entries.length === 0) {
                for (const rawChar of rawChars) {
                    try {
                        const data = rawChar.data;
                        const ext = data?.extensions;
                        const wi = (ext?.world_info || ext?.world);
                        if (wi && typeof wi === 'object') {
                            entries.push(...Object.values(wi).map(e => ({ ...e })));
                        }
                    }
                    catch { /* 继续下一个角色 */ }
                }
            }
            return entries;
        }
        /**
         * 从 context 读取破限/系统提示文本。
         *
         * 尝试路径（按优先级）：
         *   1. 第一个角色的 system_prompt 字段
         *   2. context 中可能存在的预设信息
         */
        readJailbreak(ctx, rawChars) {
            // 路径1：首个角色的 system_prompt
            if (rawChars.length > 0) {
                const sysPrompt = rawChars[0].system_prompt;
                if (sysPrompt && sysPrompt.trim()) {
                    return { text: sysPrompt, name: rawChars[0].name || '' };
                }
            }
            // 路径2：尝试从 context 中获取全局预设（ST 部分版本支持）
            try {
                const preset = ctx.preset || ctx.chatMetadata?.preset;
                if (preset) {
                    const text = preset.system_prompt || preset.jailbreak || preset.prompt || '';
                    if (text.trim()) {
                        return { text, name: preset.name || '全局预设' };
                    }
                }
            }
            catch { /* ctx.preset 不可用 */ }
            return { text: '', name: '' };
        }
        // ── 变化检测 ──────────────────────────────
        /**
         * 简单 diff：比较关键数组长度和文本
         */
        hasChanged(prev, curr) {
            return (prev.characters.length !== curr.characters.length ||
                prev.messages.length !== curr.messages.length ||
                prev.worldBooks.length !== curr.worldBooks.length ||
                prev.jailbreak !== curr.jailbreak ||
                JSON.stringify(prev.extras) !== JSON.stringify(curr.extras));
        }
    }
    /** 单例 */
    const tavernLiveLoader = new TavernLiveLoader();

    /**
     * FileLoader —— 读取用户手动导入的本地文件
     *
     * 支持的格式：
     *  - JSON 聊天记录
     *  - JSON 世界书
     *  - JSON 角色卡
     *  - 纯文本破限
     *
     * 职责：读文件、识别类型、产出 RawSourceData 给后续 Parser。
     */
    /** 快速检测 JSON 对象属于哪种酒馆数据类型 */
    function detectFileCategory(json, fileName) {
        const name = (fileName || '').toLowerCase();
        // 通过文件名提示
        if (name.includes('chat') || name.includes('对话') || name.includes('聊天')) {
            if (Array.isArray(json) || json.messages || json.chat || json.history) {
                return 'chat-json';
            }
        }
        if (name.includes('world') || name.includes('世界书') || name.includes('lore')) {
            return 'worldbook-json';
        }
        if (name.includes('character') || name.includes('char_') || name.includes('角色')) {
            return 'character-json';
        }
        if (name.includes('preset') || name.includes('破限') || name.includes('jailbreak') || name.includes('system')) {
            return 'preset-text';
        }
        // 通过结构检测
        if (Array.isArray(json)) {
            // 数组 → 可能是纯消息列表
            if (json.length > 0 && (json[0].content || json[0].role || json[0].mes)) {
                return 'chat-json';
            }
            // 可能是世界书条目列表
            if (json.length > 0 && (json[0].keys || json[0].key || json[0].entry)) {
                return 'worldbook-json';
            }
        }
        // 包含 messages / chat / history → 聊天记录
        if (json.messages || json.chat || json.history) {
            return 'chat-json';
        }
        // 包含 entries / worldinfo / lorebook → 世界书
        if (json.entries || json.worldinfo || json.lorebook || json.world_book) {
            return 'worldbook-json';
        }
        // 包含角色特征字段
        if (json.name && (json.personality || json.description || json.first_mes || json.scenario)) {
            return 'character-json';
        }
        return 'unknown';
    }
    // ─── 文件读取器 ───────────────────────────────────────
    class FileLoader {
        /**
         * 从 File 对象读取文本内容
         */
        async readAsText(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`));
                reader.readAsText(file);
            });
        }
        /**
         * 从 File 对象读取 Data URL（用于图片）
         */
        async readAsDataURL(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`));
                reader.readAsDataURL(file);
            });
        }
        /**
         * 加载 JSON 文件并识别类型
         */
        async loadJSON(file) {
            const text = await this.readAsText(file);
            let parsed;
            try {
                parsed = JSON.parse(text);
            }
            catch {
                throw new Error(`[FileLoader] 文件 "${file.name}" 不是有效的 JSON。`);
            }
            // 统一包装为对象（数组消息列表 → { messages: [...] }）
            let jsonObj;
            if (Array.isArray(parsed)) {
                jsonObj = { messages: parsed };
            }
            else if (typeof parsed === 'object' && parsed !== null) {
                jsonObj = parsed;
            }
            else {
                throw new Error(`[FileLoader] 文件 "${file.name}" 内容格式不支持。`);
            }
            const category = detectFileCategory(jsonObj, file.name);
            const raw = createEmptyRawData('file-import');
            raw.fileName = file.name;
            // 按类别填入 raw 结构
            this.populateRawData(raw, jsonObj, category);
            return { raw, category };
        }
        /**
         * 加载纯文本文件（破限/预设）
         */
        async loadText(file) {
            const text = await this.readAsText(file);
            const raw = createEmptyRawData('file-import');
            raw.fileName = file.name;
            raw.jailbreak = text;
            raw.jailbreakName = file.name.replace(/\.[^.]+$/, '');
            return raw;
        }
        /**
         * 自动检测文件扩展名并选择正确的加载方式
         */
        async loadFile(file) {
            const ext = file.name.split('.').pop()?.toLowerCase() || '';
            const textExts = ['txt', 'md', 'text'];
            if (ext === 'json') {
                return this.loadJSON(file);
            }
            if (textExts.includes(ext)) {
                const raw = await this.loadText(file);
                return { raw, category: 'preset-text' };
            }
            // 默认按 JSON 尝试
            return this.loadJSON(file);
        }
        /**
         * 按识别的类别，将 JSON 数据填入 RawSourceData 各字段
         */
        populateRawData(raw, json, category) {
            switch (category) {
                case 'chat-json': {
                    const msgs = json.messages || json.chat || json.history || [];
                    raw.messages = (Array.isArray(msgs) ? msgs : []);
                    // 聊天文件可能也包含角色信息
                    if (json.characters) {
                        raw.characters = (Array.isArray(json.characters) ? json.characters : [json.characters]);
                    }
                    break;
                }
                case 'worldbook-json': {
                    const entries = json.entries || json.worldinfo || json.lorebook || json.world_book || [];
                    raw.worldBooks = (Array.isArray(entries) ? entries : Object.values(entries));
                    break;
                }
                case 'character-json': {
                    raw.characters = [json];
                    break;
                }
                case 'preset-text': {
                    raw.jailbreak = (json.system_prompt || json.jailbreak || json.prompt || json.text || '');
                    raw.jailbreakName = (json.name || '');
                    break;
                }
                default:
                    // 兜底：全部塞进 extras，让 Parser 自行判断
                    raw.extras.unknownJson = json;
                    break;
            }
        }
    }
    /** 单例 */
    const fileLoader = new FileLoader();

    /**
     * ImageCardLoader —— 读取角色卡图片（PNG 内嵌 JSON）
     *
     * SillyTavern 角色卡 PNG 在 tEXt 块中存储 base64 编码的角色 JSON 数据。
     *
     * 职责：
     *  1. 读取 PNG 文件
     *  2. 从 tEXt 块中提取 "ccv3" 或 "chara" 键
     *  3. 解码 base64 → JSON
     *  4. 产出 RawSourceData
     *
     * 注意：OCR 识别（非 PNG 嵌入的角色卡图片）由 ocrParser 负责，
     *       本 Loader 只处理 PNG 内嵌元数据的情况。
     */
    /**
     * 从 PNG 文件的 tEXt 块中提取键值对
     */
    function extractPNGTextChunks(buffer) {
        const result = {};
        const bytes = new Uint8Array(buffer);
        // 检查 PNG 签名
        const signature = [137, 80, 78, 71, 13, 10, 26, 10];
        for (let i = 0; i < 8; i++) {
            if (bytes[i] !== signature[i]) {
                throw new Error('[ImageCardLoader] 文件不是有效的 PNG。');
            }
        }
        let offset = 8;
        while (offset < bytes.length) {
            // 读取长度（4 字节大端序）
            const length = (bytes[offset] << 24) |
                (bytes[offset + 1] << 16) |
                (bytes[offset + 2] << 8) |
                bytes[offset + 3];
            offset += 4;
            // 读取块类型（4 字节 ASCII）
            const type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
            offset += 4;
            // 读取块数据
            const data = bytes.slice(offset, offset + length);
            offset += length;
            // 跳过 CRC（4 字节）
            offset += 4;
            // tEXt 块：keyword\0text
            if (type === 'tEXt') {
                const text = new TextDecoder().decode(data);
                const nullIdx = text.indexOf('\0');
                if (nullIdx > 0) {
                    const key = text.slice(0, nullIdx);
                    const value = text.slice(nullIdx + 1);
                    result[key] = value;
                }
            }
            // IEND 块：文件结束
            if (type === 'IEND')
                break;
        }
        return result;
    }
    // ─── 主 Loader ────────────────────────────────────────
    class ImageCardLoader {
        /**
         * 从 File 对象加载角色卡图片
         *
         * 先尝试提取 PNG 内嵌的 v3 格式数据（ccv3 块），
         * 如果没有，再尝试旧版 v2 格式（chara 块）。
         */
        async load(file) {
            const buffer = await file.arrayBuffer();
            const isPNG = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
            if (!isPNG) {
                // 非 PNG 图片 → 交给 OCR Parser，这里只挂标记
                const raw = createEmptyRawData('image-card');
                raw.fileName = file.name;
                raw.extras.needsOCR = true;
                raw.extras.mimeType = file.type;
                raw.extras.imageDataUrl = await this.readAsDataURL(file);
                return { raw, format: 'unknown' };
            }
            // ── PNG: 提取 tEXt 块 ──────────────────────
            const textChunks = extractPNGTextChunks(buffer);
            // v3 格式（ccv3）
            if (textChunks['ccv3']) {
                try {
                    const jsonStr = atob(textChunks['ccv3']);
                    const json = JSON.parse(jsonStr);
                    const raw = createEmptyRawData('image-card');
                    raw.fileName = file.name;
                    raw.characters = [json];
                    raw.extras.cardFormat = 'v3';
                    raw.extras.imageDataUrl = await this.readAsDataURL(file);
                    return { raw, format: 'v3' };
                }
                catch (e) {
                    throw new Error(`[ImageCardLoader] PNG ccv3 块解析失败: ${e}`);
                }
            }
            // v2 格式（chara）
            if (textChunks['chara']) {
                try {
                    const jsonStr = atob(textChunks['chara']);
                    const json = JSON.parse(jsonStr);
                    const raw = createEmptyRawData('image-card');
                    raw.fileName = file.name;
                    raw.characters = [json];
                    raw.extras.cardFormat = 'v2';
                    raw.extras.imageDataUrl = await this.readAsDataURL(file);
                    return { raw, format: 'v2' };
                }
                catch (e) {
                    throw new Error(`[ImageCardLoader] PNG chara 块解析失败: ${e}`);
                }
            }
            throw new Error('[ImageCardLoader] PNG 中未找到角色卡数据（ccv3 或 chara 块）。' +
                '如果是纯截图，请使用 OCR 导入方式。');
        }
        async readAsDataURL(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error(`读取图片失败: ${file.name}`));
                reader.readAsDataURL(file);
            });
        }
    }
    /** 单例 */
    const imageCardLoader = new ImageCardLoader();

    /**
     * PresetLoader —— 读取破限 / 系统提示预设
     *
     * 数据来源：
     *  - 酒馆内置预设（通过 TavernLiveLoader 已覆盖）
     *  - 用户粘贴/导入的纯文本
     *  - JSON 格式的预设导出文件
     *
     * 本 Loader 为"纯文本/粘贴"场景提供入口。
     */
    class PresetLoader {
        /**
         * 从纯文本字符串加载破限
         */
        fromText(text, name = '手动导入') {
            const raw = createEmptyRawData('preset');
            raw.jailbreak = text.trim();
            raw.jailbreakName = name;
            return raw;
        }
        /**
         * 从 JSON 对象加载（含 system_prompt / jailbreak / prompt 等字段）
         */
        fromJSON(json, name) {
            const raw = createEmptyRawData('preset');
            raw.jailbreak =
                json.system_prompt ||
                    json.jailbreak ||
                    json.prompt ||
                    json.text ||
                    '';
            raw.jailbreakName =
                name || json.name || json.preset_name || '未命名预设';
            raw.extras.presetJSON = json;
            return raw;
        }
        /**
         * 从酒馆当前激活的预设加载（快捷方式：直接调用 TavernLiveLoader 的破限部分）
         */
        fromCurrentTavern() {
            const raw = createEmptyRawData('preset');
            try {
                const st = window.SillyTavern;
                if (st?.getPreset) {
                    const preset = st.getPreset();
                    raw.jailbreak =
                        preset.system_prompt ||
                            preset.jailbreak ||
                            preset.prompt ||
                            '';
                    raw.jailbreakName = preset.name || '当前预设';
                }
            }
            catch {
                /* 静默回退 */
            }
            return raw;
        }
    }
    /** 单例 */
    const presetLoader = new PresetLoader();

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
    const CHARACTER_FIELD_MAP = {
        name: ['name', 'char_name', 'character_name', 'characterName', 'title', 'display_name', 'displayName'],
        displayName: ['display_name', 'displayName', 'display_name', 'alias', 'nickname'],
        description: ['description', 'desc', 'personality', 'char_description', 'characterDescription', 'data.description'],
        prompt: ['system_prompt', 'systemPrompt', 'prompt', 'char_prompt', 'personality', 'data.system_prompt'],
        avatar: ['avatar', 'image', 'portrait', 'icon', 'data.avatar'],
        model: ['model', 'preferred_model', 'ai_model', 'llm', 'data.model'],
        firstMessage: ['first_mes', 'firstMessage', 'greeting', 'intro', 'data.first_mes'],
        scenario: ['scenario', 'world_scenario', 'background', 'data.scenario'],
        mesExample: ['mes_example', 'exampleMessages', 'chat_examples', 'examples', 'data.mes_example'],
        creator: ['creator', 'author', 'created_by', 'data.creator'],
        tags: ['tags', 'categories', 'keywords', 'data.tags'],
        cardVersion: ['spec', 'card_version', 'spec_version', 'data.spec'],
    };
    // ─── 消息字段映射 ─────────────────────────────────────
    const MESSAGE_FIELD_MAP = {
        id: ['id', 'message_id', 'msg_id', 'messageId'],
        role: ['role', 'type', 'sender_role', 'message_role'],
        speaker: ['name', 'speaker', 'character', 'sender', 'character_name', 'characterName'],
        content: ['content', 'text', 'mes', 'message', 'body'],
        timestamp: ['timestamp', 'time', 'created_at', 'createdAt', 'send_time', 'sendTime', 'date'],
        turnIndex: ['turn', 'turn_index', 'turnIndex', 'swipe_id', 'swipeId'],
        swipeId: ['swipe_id', 'swipeId', 'swipe_index', 'swipeIndex'],
        swipes: ['swipes', 'alternatives', 'alt_messages'],
        model: ['model', 'llm', 'ai_model', 'generated_by'],
    };
    // ─── 世界书字段映射 ───────────────────────────────────
    const WORLDBOOK_FIELD_MAP = {
        id: ['uid', 'id', 'entry_id', 'entryId', 'key'],
        title: ['comment', 'title', 'name', 'label'],
        keys: ['key', 'keys', 'keywords', 'triggers', 'primary_keys'],
        secondaryKeys: ['secondary_keys', 'secondaryKeys', 'alt_keys', 'secondary'],
        content: ['content', 'text', 'entry', 'description', 'value'],
        depth: ['depth', 'insertion_depth', 'insertionDepth', 'order'],
        triggerType: ['trigger_type', 'triggerType', 'type'],
        priority: ['priority', 'order', 'weight', 'rank'],
        enabled: ['enabled', 'active', 'is_enabled', 'isEnabled', 'disable'],
        target: ['target', 'scope', 'apply_to'],
        selective: ['selective', 'is_selective', 'selectiveLogic'],
        constant: ['constant', 'is_constant', 'always_on', 'alwaysOn'],
        position: ['position', 'insert_position', 'insertPosition', 'placement'],
        scanDepth: ['scan_depth', 'scanDepth', 'recursive_depth', 'recursiveDepth'],
    };
    // ─── 全局别名映射（跨所有类别） ────────────────────────
    const GLOBAL_ALIASES = {
        worldBooks: ['worldBooks', 'worldbooks', 'worldInfo', 'world_info', 'worldinfo', 'lorebook', 'lore', 'entries'],
        jailbreak: ['jailbreak', 'systemPrompt', 'system_prompt', 'preset', 'prompt', 'main_prompt'],
        characters: ['characters', 'chars', 'char_list', 'characterList', 'participants', 'members'],
        messages: ['messages', 'chat', 'history', 'conversation', 'dialogue', 'msgs']};

    /**
     * JSONParser —— JSON 格式数据解析器
     *
     * 职责：
     *  1. 接收 RawSourceData（来自任意 Loader）
     *  2. 根据字段映射表提取并重命名字段
     *  3. 产出"半归一化"的中间结构，交给 Normalizer 完成最终归一化
     *
     * 核心理念：用 fieldMap 做映射，不硬编码字段名。
     */
    // ─── 映射解析工具 ─────────────────────────────────────
    /**
     * 根据映射表从原始对象中查找值
     * 优先级：按映射数组顺序，先找到就返回
     */
    function resolveField(obj, aliases, defaultValue = undefined) {
        for (const alias of aliases) {
            // 支持点分隔的嵌套路径，如 "data.description"
            const value = getNested(obj, alias);
            if (value !== undefined && value !== null) {
                return value;
            }
        }
        return defaultValue;
    }
    function getNested(obj, path) {
        const parts = path.split('.');
        let current = obj;
        for (const part of parts) {
            if (current == null || typeof current !== 'object')
                return undefined;
            current = current[part];
        }
        return current;
    }
    /**
     * 将整个映射表应用到对象上，产出新对象
     */
    function applyFieldMap(obj, fieldMap) {
        const result = {};
        for (const [targetKey, aliases] of Object.entries(fieldMap)) {
            result[targetKey] = resolveField(obj, aliases);
        }
        // 保留未映射的原始字段到 meta
        const mappedKeys = new Set(Object.values(fieldMap).flat());
        for (const [key, value] of Object.entries(obj)) {
            if (!mappedKeys.has(key)) {
                if (!result._raw)
                    result._raw = {};
                result._raw[key] = value;
            }
        }
        return result;
    }
    /**
     * 解析 RawSourceData → 中间结构
     */
    function parseRawData(raw) {
        const result = {
            characters: [],
            messages: [],
            worldBooks: [],
            jailbreak: raw.jailbreak || '',
            jailbreakName: raw.jailbreakName || '',
            sessionMeta: {},
            extras: { ...raw.extras },
        };
        // ── 解析角色 ──────────────────────────────
        for (const rawChar of raw.characters) {
            const parsed = applyFieldMap(rawChar, CHARACTER_FIELD_MAP);
            result.characters.push(parsed);
        }
        // ── 解析消息 ──────────────────────────────
        for (const rawMsg of raw.messages) {
            const parsed = applyFieldMap(rawMsg, MESSAGE_FIELD_MAP);
            // 修复：SillyTavern v2 格式的 mes 字段
            if (parsed.content === undefined && rawMsg.mes !== undefined) {
                parsed.content = rawMsg.mes;
            }
            // 修复 role
            if (parsed.role === undefined) {
                if (rawMsg.is_system === true) {
                    parsed.role = 'system';
                }
                else if (rawMsg.is_user === true || rawMsg.role === 'user') {
                    parsed.role = 'user';
                }
                else if (rawMsg.role === 'assistant' || rawMsg.role === 'bot' || rawMsg.role === 'ai') {
                    parsed.role = 'assistant';
                }
                else if (rawMsg.name || rawMsg.speaker) {
                    parsed.role = 'character';
                }
            }
            result.messages.push(parsed);
        }
        // ── 解析世界书 ────────────────────────────
        for (const rawEntry of raw.worldBooks) {
            const parsed = applyFieldMap(rawEntry, WORLDBOOK_FIELD_MAP);
            // 特殊处理 keys：可能是逗号分隔的字符串
            if (typeof parsed.keys === 'string') {
                parsed.keys = parsed.keys.split(',').map(k => k.trim()).filter(Boolean);
            }
            if (typeof parsed.secondaryKeys === 'string') {
                parsed.secondaryKeys = parsed.secondaryKeys
                    .split(',')
                    .map(k => k.trim())
                    .filter(Boolean);
            }
            // 修复 enabled：disable 字段要取反
            if (parsed.enabled === undefined && rawEntry.disable !== undefined) {
                parsed.enabled = !rawEntry.disable;
            }
            result.worldBooks.push(parsed);
        }
        // ── 处理 extras 中的未归类数据 ─────────────
        // 如果原始数据在 extras 中有完整 JSON 还没被处理
        const unknownJson = raw.extras.unknownJson;
        if (unknownJson) {
            // 尝试找到角色、消息、世界书
            const charsKey = resolveField(unknownJson, GLOBAL_ALIASES.characters);
            if (Array.isArray(charsKey) && result.characters.length === 0) {
                for (const c of charsKey) {
                    result.characters.push(applyFieldMap(c, CHARACTER_FIELD_MAP));
                }
            }
            const msgsKey = resolveField(unknownJson, GLOBAL_ALIASES.messages);
            if (Array.isArray(msgsKey) && result.messages.length === 0) {
                for (const m of msgsKey) {
                    result.messages.push(applyFieldMap(m, MESSAGE_FIELD_MAP));
                }
            }
            const wbKey = resolveField(unknownJson, GLOBAL_ALIASES.worldBooks);
            if (Array.isArray(wbKey) && result.worldBooks.length === 0) {
                for (const w of wbKey) {
                    result.worldBooks.push(applyFieldMap(w, WORLDBOOK_FIELD_MAP));
                }
            }
        }
        // ── 检查 jailbreak ─────────────────────────
        if (!result.jailbreak && unknownJson) {
            result.jailbreak = resolveField(unknownJson, GLOBAL_ALIASES.jailbreak) || '';
        }
        return result;
    }

    /**
     * normalizeCharacter —— 角色归一化
     *
     * 输入：Parser 产出的 ParsedCharacter（半归一化对象）
     * 输出：Character（统一角色结构）
     */
    let charCounter = 0;
    /** 生成唯一角色 ID */
    function generateCharId() {
        return `char_${Date.now()}_${++charCounter}`;
    }
    /** 重置计数器（测试用） */
    function resetCharCounter() {
        charCounter = 0;
    }
    /**
     * 将单个 ParsedCharacter 归一化为 Character
     */
    function normalizeCharacter(raw, index = 0) {
        const name = String(raw.name || `未命名角色_${index + 1}`);
        const character = {
            id: String(raw.id || generateCharId()),
            name,
            displayName: String(raw.displayName || raw.name || name),
            avatar: String(raw.avatar || ''),
            model: String(raw.model || ''),
            prompt: String(raw.prompt || raw.personality || raw.description || ''),
            description: String(raw.description || ''),
            lorebookRefs: normalizeStringArray(raw.lorebookRefs || raw.lorebook_refs || []),
            status: normalizeStatus(raw),
            isNarrator: Boolean(raw.isNarrator || raw.is_narrator || false),
            meta: normalizeCharacterMeta(raw),
        };
        return character;
    }
    /**
     * 批量归一化角色
     */
    function normalizeCharacters(raws) {
        return raws.map((r, i) => normalizeCharacter(r, i));
    }
    // ─── 辅助函数 ─────────────────────────────────────────
    function normalizeStatus(raw) {
        const val = raw.status || raw.enabled;
        if (val === false || val === 'disabled' || val === 'inactive')
            return 'disabled';
        return 'enabled';
    }
    function normalizeCharacterMeta(raw) {
        const meta = {};
        if (raw.cardVersion !== undefined)
            meta.cardVersion = String(raw.cardVersion);
        if (raw.creator !== undefined)
            meta.creator = String(raw.creator);
        if (raw.tags !== undefined) {
            meta.tags = normalizeStringArray(raw.tags);
        }
        // 保留所有未映射的原始字段
        if (raw._raw) {
            Object.assign(meta, raw._raw);
        }
        // 保留扩展字段
        for (const [key, value] of Object.entries(raw)) {
            if (!['id', 'name', 'displayName', 'avatar', 'model', 'prompt',
                'description', 'lorebookRefs', 'status', 'enabled', 'isNarrator',
                'cardVersion', 'creator', 'tags', '_raw', 'personality',
                'lorebook_refs', 'is_narrator', 'firstMessage', 'scenario',
                'mesExample'].includes(key)) {
                meta[key] = value;
            }
        }
        return meta;
    }
    function normalizeStringArray(value) {
        if (Array.isArray(value))
            return value.map(String);
        if (typeof value === 'string')
            return value.split(',').map(s => s.trim()).filter(Boolean);
        return [];
    }

    /**
     * normalizeMessage —— 消息归一化
     *
     * 输入：Parser 产出的 ParsedMessage（半归一化对象）
     * 输出：Message（统一消息结构）
     */
    let msgCounter = 0;
    function generateMsgId() {
        return `msg_${Date.now()}_${++msgCounter}`;
    }
    function resetMsgCounter() {
        msgCounter = 0;
    }
    /**
     * 将单条 ParsedMessage 归一化为 Message
     */
    function normalizeMessage(raw, index = 0) {
        const message = {
            id: String(raw.id || generateMsgId()),
            role: normalizeRole(raw),
            speaker: String(raw.speaker || raw.name || '未知'),
            content: String(raw.content || ''),
            timestamp: normalizeTimestamp(raw),
            turnIndex: normalizeTurnIndex(raw, index),
            visible: raw.visible !== false && raw.visible !== 'false',
            groupId: raw.groupId ? String(raw.groupId) : undefined,
            meta: normalizeMessageMeta(raw),
        };
        return message;
    }
    /**
     * 批量归一化消息，自动处理 turnIndex 排序
     */
    function normalizeMessages(raws) {
        const normalized = raws.map((r, i) => normalizeMessage(r, i));
        // 按时间戳排序，然后重设 turnIndex
        normalized.sort((a, b) => a.timestamp - b.timestamp);
        normalized.forEach((m, i) => {
            m.turnIndex = i;
        });
        return normalized;
    }
    // ─── 辅助函数 ─────────────────────────────────────────
    function normalizeRole(raw) {
        const role = String(raw.role || '').toLowerCase();
        const roleMap = {
            user: 'user',
            human: 'user',
            assistant: 'assistant',
            bot: 'assistant',
            ai: 'assistant',
            model: 'assistant',
            system: 'system',
            character: 'character',
            char: 'character',
            narrator: 'character',
        };
        if (roleMap[role])
            return roleMap[role];
        // 根据 speaker 名推测
        const speaker = String(raw.speaker || raw.name || '').toLowerCase();
        if (speaker === 'user' || speaker === '用户')
            return 'user';
        if (speaker === 'system' || speaker === '系统')
            return 'system';
        // 默认：有 speaker 名就是角色消息
        if (raw.speaker || raw.name)
            return 'character';
        return 'system';
    }
    function normalizeTimestamp(raw) {
        const ts = raw.timestamp;
        if (typeof ts === 'number') {
            // 毫秒级时间戳（> 1e12）转秒
            return ts > 1e12 ? Math.floor(ts / 1000) : ts;
        }
        if (typeof ts === 'string') {
            const parsed = Date.parse(ts);
            return isNaN(parsed) ? Date.now() / 1000 : Math.floor(parsed / 1000);
        }
        // 没有时间戳就用当前时间
        return Math.floor(Date.now() / 1000);
    }
    function normalizeTurnIndex(raw, fallback) {
        if (typeof raw.turnIndex === 'number')
            return raw.turnIndex;
        if (typeof raw.turn === 'number')
            return raw.turn;
        if (typeof raw.swipeId === 'number')
            return raw.swipeId;
        return fallback;
    }
    function normalizeMessageMeta(raw) {
        const meta = {};
        if (raw.model !== undefined)
            meta.model = String(raw.model);
        if (raw.tokenCount !== undefined)
            meta.tokenCount = Number(raw.tokenCount);
        if (raw.edited !== undefined)
            meta.edited = Boolean(raw.edited);
        if (raw.swipeId !== undefined || raw.swipeIndex !== undefined) {
            meta.swipeIndex = Number(raw.swipeId || raw.swipeIndex || 0);
        }
        if (raw.swipes !== undefined) {
            const s = raw.swipes;
            meta.swipeTotal = Array.isArray(s) ? s.length : Number(s);
        }
        // 保留未映射的原始字段
        if (raw._raw) {
            Object.assign(meta, raw._raw);
        }
        return meta;
    }

    /**
     * normalizeWorldbook —— 世界书条目归一化
     *
     * 输入：Parser 产出的 ParsedWorldBookEntry（半归一化对象）
     * 输出：WorldBookEntry（统一世界书条目结构）
     */
    let wbCounter = 0;
    function generateWBId() {
        return `wb_${Date.now()}_${++wbCounter}`;
    }
    function resetWBCounter() {
        wbCounter = 0;
    }
    /**
     * 将单条 ParsedWorldBookEntry 归一化为 WorldBookEntry
     */
    function normalizeWorldBookEntry(raw, index = 0) {
        const entry = {
            id: String(raw.id || raw.uid || generateWBId()),
            title: String(raw.title || raw.comment || `条目_${index + 1}`),
            keys: normalizeKeys(raw.keys),
            content: String(raw.content || ''),
            depth: normalizeDepth(raw),
            triggerType: normalizeTriggerType(raw),
            priority: Number(raw.priority ?? raw.order ?? raw.weight ?? 10),
            enabled: normalizeEnabled(raw),
            target: normalizeTarget(raw),
            characterId: raw.characterId ? String(raw.characterId) : undefined,
            selective: Boolean(raw.selective ?? false),
            secondaryKeys: normalizeKeys(raw.secondaryKeys),
            constant: Boolean(raw.constant ?? false),
            position: normalizePosition(raw),
            scanDepth: Number(raw.scanDepth ?? raw.scan_depth ?? 2),
            meta: raw._raw || {},
        };
        return entry;
    }
    /**
     * 批量归一化世界书
     */
    function normalizeWorldBookEntries(raws) {
        return raws.map((r, i) => normalizeWorldBookEntry(r, i));
    }
    // ─── 辅助函数 ─────────────────────────────────────────
    function normalizeKeys(value) {
        if (Array.isArray(value))
            return value.map(String).filter(Boolean);
        if (typeof value === 'string')
            return value.split(',').map(k => k.trim()).filter(Boolean);
        return [];
    }
    function normalizeDepth(raw) {
        const d = raw.depth ?? raw.order ?? raw.insertionDepth ?? 0;
        return Number(d) || 0;
    }
    function normalizeTriggerType(raw) {
        const t = String(raw.triggerType || raw.type || '').toLowerCase();
        if (t === 'manual')
            return 'manual';
        if (t === 'director')
            return 'director';
        // 默认是关键词触发
        if (raw.keys && (Array.isArray(raw.keys) ? raw.keys.length > 0 : true)) {
            return 'keyword';
        }
        return 'keyword';
    }
    function normalizeEnabled(raw) {
        if (raw.enabled !== undefined)
            return Boolean(raw.enabled);
        if (raw.active !== undefined)
            return Boolean(raw.active);
        if (raw.disable !== undefined)
            return !Boolean(raw.disable);
        return true; // 默认启用
    }
    function normalizeTarget(raw) {
        const t = String(raw.target || raw.scope || '').toLowerCase();
        if (t === 'character' || t === 'char')
            return 'character';
        if (t === 'session' || t === 'chat')
            return 'session';
        return 'global';
    }
    function normalizePosition(raw) {
        const p = String(raw.position || raw.insertPosition || '').toLowerCase();
        if (p === 'before_char' || p === 'before')
            return 'before_char';
        if (p === 'in_chat' || p === 'chat' || p === 'in-chat')
            return 'in_chat';
        return 'after_char';
    }

    /**
     * validateSession —— 会话校验器
     *
     * 在校验 UnifiedSession 的结构完整性和数据合法性。
     * 校验失败返回明确的错误信息列表，绝不静默吞错。
     */
    // ─── 工厂函数 ─────────────────────────────────────────
    function issue(severity, path, message) {
        return { severity, path, message };
    }
    function makeResult(issues) {
        return {
            valid: issues.every(i => i.severity !== 'error'),
            issues,
            errors: issues.filter(i => i.severity === 'error'),
            warnings: issues.filter(i => i.severity === 'warning'),
            infos: issues.filter(i => i.severity === 'info'),
        };
    }
    // ─── 顶层校验 ─────────────────────────────────────────
    function validateSession(session) {
        const issues = [];
        // ── 必填字段 ──────────────────────────────
        if (!session.sessionId) {
            issues.push(issue('error', 'sessionId', '会话 ID 不能为空'));
        }
        if (!session.mode) {
            issues.push(issue('error', 'mode', '运行模式不能为空'));
        }
        else if (!['live', 'import'].includes(session.mode)) {
            issues.push(issue('error', 'mode', `未知的运行模式: "${session.mode}"`));
        }
        // ── 校验角色 ──────────────────────────────
        issues.push(...validateCharacters(session.characters, session.mode));
        // ── 校验消息 ──────────────────────────────
        issues.push(...validateMessages(session.messages));
        // ── 校验世界书 ────────────────────────────
        issues.push(...validateWorldBooks(session.worldBooks));
        // ── 校验破限 ──────────────────────────────
        issues.push(...validateJailbreak(session.jailbreak, session.mode));
        // ── 校验来源元数据 ─────────────────────────
        if (!session.sourceMeta) {
            issues.push(issue('warning', 'sourceMeta', '缺少来源元数据，建议补充以便调试'));
        }
        else {
            if (!session.sourceMeta.source) {
                issues.push(issue('warning', 'sourceMeta.source', '未标记数据来源'));
            }
            if (session.mode === 'import' && session.sourceMeta.fileNames.length === 0) {
                issues.push(issue('info', 'sourceMeta.fileNames', '导入模式但未记录文件名'));
            }
        }
        return makeResult(issues);
    }
    // ─── 角色校验 ─────────────────────────────────────────
    function validateCharacters(characters, mode) {
        const issues = [];
        if (!Array.isArray(characters)) {
            issues.push(issue('error', 'characters', '角色列表必须为数组'));
            return issues;
        }
        if (characters.length === 0) {
            issues.push(issue('warning', 'characters', '没有加载任何角色（允许空白草稿状态）'));
            return issues;
        }
        const seenNames = new Set();
        characters.forEach((char, i) => {
            const p = `characters[${i}]`;
            // 名字不能为空
            if (!char.name || char.name.trim() === '') {
                issues.push(issue('error', `${p}.name`, '角色名不能为空'));
            }
            else {
                // 检查重名
                const normalized = char.name.trim().toLowerCase();
                if (seenNames.has(normalized)) {
                    issues.push(issue('warning', `${p}.name`, `角色名 "${char.name}" 重复`));
                }
                seenNames.add(normalized);
            }
            // ID 不能为空
            if (!char.id) {
                issues.push(issue('error', `${p}.id`, '角色 ID 不能为空'));
            }
            // 状态检查
            if (!char.status) {
                issues.push(issue('info', `${p}.status`, `角色 "${char.name}" 未设置状态，默认启用`));
            }
            // 提示检查（角色 prompt 是核心字段）
            if (!char.prompt && !char.description) {
                issues.push(issue('info', `${p}.prompt`, `角色 "${char.name}" 缺少系统提示和描述，可能影响对话质量`));
            }
        });
        return issues;
    }
    // ─── 消息校验 ─────────────────────────────────────────
    function validateMessages(messages) {
        const issues = [];
        if (!Array.isArray(messages)) {
            issues.push(issue('error', 'messages', '消息列表必须为数组'));
            return issues;
        }
        if (messages.length === 0) {
            issues.push(issue('info', 'messages', '聊天记录为空'));
            return issues;
        }
        let lastTurnIndex = -1;
        messages.forEach((msg, i) => {
            const p = `messages[${i}]`;
            // 内容检查
            if (msg.content === undefined || msg.content === null) {
                issues.push(issue('warning', `${p}.content`, `消息 #${i} 内容为空`));
            }
            // 角色消息必须有 speaker
            if (msg.role === 'character' && (!msg.speaker || msg.speaker.trim() === '')) {
                issues.push(issue('error', `${p}.speaker`, `角色消息 #${i} 缺少发言者 (speaker)`));
            }
            // 顺序检查
            if (typeof msg.turnIndex === 'number') {
                if (msg.turnIndex < lastTurnIndex && msg.turnIndex >= 0) {
                    issues.push(issue('warning', `${p}.turnIndex`, `消息顺序异常: turnIndex ${msg.turnIndex} < ${lastTurnIndex}`));
                }
                if (msg.turnIndex >= 0) {
                    lastTurnIndex = msg.turnIndex;
                }
            }
            // role 检查
            const validRoles = ['user', 'assistant', 'system', 'character'];
            if (!validRoles.includes(msg.role)) {
                issues.push(issue('warning', `${p}.role`, `未知消息角色: "${msg.role}"`));
            }
        });
        // 检查是否有连续同角色消息（可能是数据问题）
        let prevRole = '';
        let consecutiveCount = 0;
        messages.forEach((msg, i) => {
            if (msg.role === prevRole && msg.role === 'assistant') {
                consecutiveCount++;
                if (consecutiveCount >= 3) {
                    issues.push(issue('info', `messages[${i}].role`, `连续 ${consecutiveCount + 1} 条 assistant 消息，请确认是否为预期行为`));
                    consecutiveCount = 0; // 只报一次
                }
            }
            else {
                prevRole = msg.role;
                consecutiveCount = 0;
            }
        });
        return issues;
    }
    // ─── 世界书校验 ───────────────────────────────────────
    function validateWorldBooks(entries) {
        const issues = [];
        if (!Array.isArray(entries)) {
            issues.push(issue('error', 'worldBooks', '世界书列表必须为数组'));
            return issues;
        }
        if (entries.length === 0) {
            // 世界书可以为空，这不是错误
            return issues;
        }
        entries.forEach((entry, i) => {
            const p = `worldBooks[${i}]`;
            // 内容不能全空
            if (!entry.content || entry.content.trim() === '') {
                issues.push(issue('warning', `${p}.content`, `世界书条目 "${entry.title || '未命名'}" 内容为空`));
            }
            // key 最好至少一个（非 constant 模式下）
            if ((!entry.keys || entry.keys.length === 0) && !entry.constant) {
                issues.push(issue('info', `${p}.keys`, `世界书条目 "${entry.title}" 没有设置触发关键词，且非恒定插入，可能永远不会触发`));
            }
            // 标题检查
            if (!entry.title || entry.title.trim() === '') {
                issues.push(issue('warning', `${p}.title`, `世界书条目 #${i} 缺少标题`));
            }
            // 深度范围检查
            if (entry.depth < 0 || entry.depth > 99) {
                issues.push(issue('warning', `${p}.depth`, `世界书条目 "${entry.title}" 深度 ${entry.depth} 超出常规范围 [0-99]`));
            }
        });
        return issues;
    }
    // ─── 破限校验 ─────────────────────────────────────────
    function validateJailbreak(jailbreak, mode) {
        const issues = [];
        if (!jailbreak) {
            issues.push(issue('info', 'jailbreak', '破限未加载'));
            return issues;
        }
        if (!jailbreak.text || jailbreak.text.trim() === '') {
            if (jailbreak.enabled) {
                issues.push(issue('warning', 'jailbreak.text', '破限已启用但内容为空'));
            }
            else {
                issues.push(issue('info', 'jailbreak.text', '破限未加载（已标记为未启用）'));
            }
        }
        if (jailbreak.source === 'none' && mode === 'live') {
            issues.push(issue('info', 'jailbreak.source', '实时模式未检测到激活的破限/预设'));
        }
        return issues;
    }

    /**
     * AdapterFacade —— 数据适配层的统一对外 API
     *
     * 串联 Loader → Parser → Normalizer → Validator 整条流水线。
     */
    // ─── 适配器外观类 ─────────────────────────────────────
    class AdapterFacade {
        constructor() {
            this.currentSession = null;
        }
        // ═══════════════════════════════════════════════════
        // 实时模式
        // ═══════════════════════════════════════════════════
        readFromTavern() {
            const raw = tavernLiveLoader.read();
            return this.pipeline(raw, 'live');
        }
        watchTavern(onChange, intervalMs = 2000) {
            return tavernLiveLoader.watch((raw) => {
                try {
                    const session = this.pipeline(raw, 'live');
                    onChange(session);
                }
                catch (e) {
                    console.error('[AdapterFacade] 监听回调异常:', e);
                }
            }, intervalMs);
        }
        stopWatching() { tavernLiveLoader.stopWatch(); }
        // ═══════════════════════════════════════════════════
        // 导入模式
        // ═══════════════════════════════════════════════════
        async importJSON(file) {
            const { raw, category } = await fileLoader.loadJSON(file);
            const session = this.pipeline(raw, 'import', [file.name]);
            return { session, category };
        }
        async importText(file) {
            const raw = await fileLoader.loadText(file);
            return this.pipeline(raw, 'import', [file.name]);
        }
        async importImageCard(file) {
            const { raw } = await imageCardLoader.load(file);
            return this.pipeline(raw, 'import', [file.name]);
        }
        async importFile(file) {
            const ext = file.name.split('.').pop()?.toLowerCase() || '';
            if (ext === 'json')
                return this.importJSON(file);
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
        importPresetFromText(text, name) {
            const raw = presetLoader.fromText(text, name);
            return this.pipeline(raw, 'import', [name || '粘贴文本']);
        }
        // ═══════════════════════════════════════════════════
        // 状态查询
        // ═══════════════════════════════════════════════════
        getCurrentSession() { return this.currentSession; }
        getSummary(session) {
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
        validate(session) {
            return validateSession(session);
        }
        resetCounters() {
            resetCharCounter();
            resetMsgCounter();
            resetWBCounter();
        }
        // ═══════════════════════════════════════════════════
        // 内部流水线
        // ═══════════════════════════════════════════════════
        pipeline(raw, mode, fileNames = []) {
            const parsed = parseRawData(raw);
            const characters = normalizeCharacters(parsed.characters);
            const messages = normalizeMessages(parsed.messages);
            const worldBooks = normalizeWorldBookEntries(parsed.worldBooks);
            const session = this.assembleSession(raw, parsed, { characters, messages, worldBooks }, mode, fileNames);
            this.currentSession = session;
            return session;
        }
        assembleSession(raw, parsed, normalized, mode, fileNames) {
            const jailbreak = {
                text: raw.jailbreak || parsed.jailbreak || '',
                source: raw.source === 'tavern-live' ? 'tavern' : 'file',
                enabled: raw.source === 'tavern-live' || (!!(raw.jailbreak || parsed.jailbreak)),
                name: raw.jailbreakName || parsed.jailbreakName || '未加载',
            };
            const sourceMeta = {
                tavernVersion: raw.tavernVersion || '',
                importedAt: mode === 'import' ? new Date().toISOString() : '',
                fileNames,
                source: raw.source,
            };
            const sessionId = parsed.sessionMeta.chatId ||
                parsed.sessionMeta.sessionId ||
                `session-${Date.now()}`;
            const settings = {
                dialogueMode: 'sequential',
                directorModel: '',
                roleModels: {},
            };
            return { sessionId, mode, characters: normalized.characters, messages: normalized.messages, worldBooks: normalized.worldBooks, jailbreak, settings, sourceMeta };
        }
    }
    const adapter = new AdapterFacade();

    function nowId(prefix) {
        return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }
    function uniq(arr) {
        return [...new Set(arr)];
    }
    function normalizeText(input) {
        return (input || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }
    function textContainsAny(text, needles) {
        if (!text || needles.length === 0)
            return false;
        const hay = normalizeText(text);
        return needles.some((needle) => needle && hay.includes(normalizeText(needle)));
    }
    function takeLast(items, limit) {
        if (limit <= 0)
            return [];
        return items.slice(Math.max(0, items.length - limit));
    }
    function safeJoin(parts, sep = '\n') {
        return parts.filter((x) => Boolean(x && String(x).trim())).join(sep);
    }
    function keywordHitScore(text, keywords) {
        if (!text || !keywords.length)
            return 0;
        const hay = normalizeText(text);
        let score = 0;
        for (const kw of keywords) {
            const token = normalizeText(kw);
            if (!token)
                continue;
            if (hay.includes(token))
                score += Math.max(1, Math.min(5, token.length / 2));
        }
        return score;
    }

    function buildContextSummary(session) {
        const messages = session.messages.filter((m) => m.visible !== false);
        const latest = messages[messages.length - 1];
        return {
            sessionId: session.sessionId,
            mode: session.mode,
            characterCount: session.characters.length,
            messageCount: messages.length,
            worldBookCount: session.worldBooks.filter((w) => w.enabled !== false).length,
            latestSpeaker: latest?.speaker || '',
            latestMessage: latest?.content || '',
        };
    }
    function selectVisibleMessages(session, limit) {
        const visible = session.messages.filter((m) => m.visible !== false);
        return takeLast(visible, Math.max(1, limit));
    }
    function selectRelevantWorldBooks(session, focusText, maxCount, role) {
        const enabled = session.worldBooks.filter((entry) => entry.enabled !== false);
        const scored = enabled
            .map((entry) => {
            let score = 0;
            const reasons = [];
            score += keywordHitScore(focusText, entry.keys);
            if (score > 0)
                reasons.push('关键词命中');
            score += keywordHitScore(focusText, entry.secondaryKeys) * 0.5;
            if (entry.constant) {
                score += 2;
                reasons.push('恒定插入');
            }
            if (entry.target === 'character' && role && entry.characterId === role.id) {
                score += 5;
                reasons.push('角色绑定');
            }
            if (entry.target === 'global') {
                score += 1;
                reasons.push('全局条目');
            }
            if (entry.triggerType === 'manual')
                score += 0.5;
            if (entry.triggerType === 'director')
                score += 1.5;
            return { entry, score, reasons };
        })
            .sort((a, b) => b.score - a.score || b.entry.priority - a.entry.priority || a.entry.depth - b.entry.depth)
            .filter((item) => item.score > 0 || item.entry.constant);
        return scored.slice(0, Math.max(0, maxCount)).map((x) => x.entry);
    }
    function buildRoleContextBundle(params) {
        const { session, role, config, selectedWorldBooks, wakeReason, priority } = params;
        const visibleMessages = selectVisibleMessages(session, config.recentMessages);
        const publicSummary = summarizeMessages(visibleMessages);
        const directorNote = safeJoin([
            `本轮身份：${role.displayName}`,
            `唤醒原因：${wakeReason.join(' / ') || 'fallback'}`,
            `优先级：${priority}`,
            selectedWorldBooks.length ? `相关世界书：${selectedWorldBooks.map((w) => w.title).join('、')}` : '相关世界书：无',
        ]);
        return {
            role,
            visibleMessages,
            selectedWorldBooks,
            publicSummary,
            directorNote,
            wakeReason,
            priority,
        };
    }
    function summarizeMessages(messages) {
        if (!messages.length)
            return '无公开聊天记录';
        const lines = messages.map((m) => {
            const speaker = m.speaker || m.role;
            const content = String(m.content || '').replace(/\s+/g, ' ').trim();
            return `${speaker}: ${content}`;
        });
        return safeJoin(lines, '\n');
    }
    function buildRoleFocusText(role, session, latestUserMessage) {
        const latest = session.messages.filter((m) => m.visible !== false).slice(-8);
        const previous = latest.map((m) => `${m.speaker} ${m.content}`).join('\n');
        return safeJoin([
            role.name,
            role.displayName,
            role.description,
            role.prompt,
            latestUserMessage,
            previous,
        ]);
    }
    function inferPriority(score) {
        if (score >= 9)
            return 'high';
        if (score >= 4)
            return 'normal';
        return 'low';
    }
    function matchesSpeaker(role, session) {
        const visible = session.messages.filter((m) => m.visible !== false);
        const latest = visible[visible.length - 1];
        if (!latest)
            return false;
        return latest.speaker === role.displayName || latest.speaker === role.name;
    }
    function matchesMention(role, text) {
        if (!text)
            return false;
        return textContainsAny(text, [role.displayName, role.name]);
    }

    function buildDirectorPrompt(plan) {
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
    function buildRolePrompt(payload) {
        const { context, roleName } = payload;
        const role = context.role;
        // 按 position 分组世界书（与 promptAssembler 保持一致）
        const beforeChar = context.selectedWorldBooks.filter(w => w.position === 'before_char');
        const afterChar = context.selectedWorldBooks.filter(w => w.position === 'after_char');
        const inChat = context.selectedWorldBooks.filter(w => w.position === 'in_chat');
        function formatWB(entries) {
            if (!entries.length)
                return '';
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
    function buildPromptBundle(plan) {
        const rolePrompts = {};
        for (const payload of plan.payloads) {
            rolePrompts[payload.roleId] = buildRolePrompt(payload);
        }
        return {
            directorPrompt: buildDirectorPrompt(plan),
            rolePrompts,
        };
    }

    function scoreRoles(session, request, config) {
        const manual = new Set([request.manualSpeakerId, ...(request.manualSpeakerIds || [])].filter(Boolean));
        const visibleMsgs = session.messages.filter((m) => m.visible !== false);
        const latestUserMessage = request.latestUserMessage || visibleMsgs[visibleMsgs.length - 1]?.content || '';
        return session.characters
            .filter((role) => config.includeDisabled || role.status !== 'disabled')
            .map((role) => {
            let score = 0;
            const reasons = [];
            if (manual.has(role.id)) {
                score += 100;
                reasons.push('manual');
            }
            if (role.isNarrator && config.includeNarrator) {
                score += 20;
                reasons.push('narrator');
            }
            if (matchesMention(role, latestUserMessage)) {
                score += 18;
                reasons.push('mention');
            }
            if (config.preferSpeakerContinuity && matchesSpeaker(role, session)) {
                score += 8;
                reasons.push('speaker-continuity');
            }
            // 发言冷却：最近 2 轮已多次发言的角色降权，防止同一角色连续霸屏
            if (!manual.has(role.id)) {
                const recentSpeakers = session.messages
                    .filter(m => m.visible !== false)
                    .slice(-4)
                    .map(m => m.speaker);
                const recentCount = recentSpeakers.filter(s => s === role.displayName || s === role.name).length;
                if (recentCount >= 2) {
                    score *= 0.25;
                    reasons.push('cooldown-heavy');
                }
                else if (recentCount >= 1) {
                    score *= 0.55;
                    reasons.push('cooldown-light');
                }
            }
            const focusText = buildRoleFocusText(role, session, request.latestUserMessage);
            score += keywordHitScore(focusText, [role.name, role.displayName]) * 0.6;
            score += keywordHitScore(latestUserMessage, [role.name, role.displayName]) * 0.4;
            if (role.prompt)
                score += 0.5;
            if (role.description)
                score += 0.25;
            if (score <= 0) {
                score += 1;
                reasons.push('fallback');
            }
            else if (!reasons.length) {
                reasons.push('topic-match');
            }
            const priority = inferPriority(score);
            return { roleId: role.id, score, reasons: uniq(reasons), priority };
        })
            .sort((a, b) => b.score - a.score || a.roleId.localeCompare(b.roleId));
    }
    function scoreWorldBooks(session, request, selectedRoles, config) {
        const focusText = [
            request.latestUserMessage,
            ...session.messages.filter((m) => m.visible !== false).slice(-config.recentMessages).map((m) => `${m.speaker} ${m.content}`),
            ...selectedRoles.map((r) => `${r.name} ${r.displayName} ${r.prompt} ${r.description}`),
        ].filter(Boolean).join('\n');
        return session.worldBooks
            .filter((entry) => entry.enabled !== false)
            .map((entry) => {
            let score = 0;
            const reasons = [];
            score += keywordHitScore(focusText, entry.keys);
            if (score > 0)
                reasons.push('primary-keyword');
            const secondary = keywordHitScore(focusText, entry.secondaryKeys);
            if (secondary > 0) {
                score += secondary * 0.5;
                reasons.push('secondary-keyword');
            }
            if (entry.constant) {
                score += 2;
                reasons.push('constant');
            }
            if (entry.target === 'character') {
                const hit = selectedRoles.some((r) => r.id === entry.characterId);
                if (hit) {
                    score += 4;
                    reasons.push('character-target');
                }
            }
            if (entry.triggerType === 'director') {
                score += 1.5;
                reasons.push('director-trigger');
            }
            if (entry.position === 'in_chat')
                score += 0.4;
            if (entry.depth === 0)
                score += 0.2;
            return { entryId: entry.id, score, reasons };
        })
            .sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId));
    }
    function pickSelectedRoles(scores, maxRoles) {
        // maxRoles <= 0 表示不自动选择角色（如 silent 模式）
        if (maxRoles <= 0)
            return [];
        return scores.slice(0, maxRoles).map((item) => item.roleId);
    }
    // 各会话的 round-robin 旋转位置（模块级持久化）
    const roundRobinState = new Map();
    function sortSelectedRoles(scores, selectedRoleIds, strategy) {
        const selected = scores.filter((s) => selectedRoleIds.includes(s.roleId));
        if (strategy === 'fixed')
            return selectedRoleIds;
        if (strategy === 'round-robin') {
            // 从模块级状态读取上一轮位置，本轮从下一个开始旋转
            const sorted = selected.map((s) => s.roleId).sort((a, b) => a.localeCompare(b));
            // 用排序后的角色列表作为 key（同一组角色共享旋转状态）
            const key = sorted.join(',');
            const lastIdx = roundRobinState.get(key) ?? -1;
            const start = (lastIdx + 1) % sorted.length;
            // 旋转后的顺序：start...end, 0...start-1
            const rotated = sorted.slice(start).concat(sorted.slice(0, start));
            // 持久化下一轮索引
            roundRobinState.set(key, start);
            return rotated;
        }
        return selected.sort((a, b) => b.score - a.score || a.roleId.localeCompare(b.roleId)).map((s) => s.roleId);
    }
    function resolveWakeReasons(role, session, request, config) {
        const reasons = [];
        const latestVis = session.messages.filter((m) => m.visible !== false);
        const latestText = request.latestUserMessage || latestVis[latestVis.length - 1]?.content || '';
        if (request.manualSpeakerId === role.id || (request.manualSpeakerIds || []).includes(role.id))
            reasons.push('manual');
        if (matchesMention(role, latestText))
            reasons.push('mention');
        if (config.preferSpeakerContinuity && matchesSpeaker(role, session))
            reasons.push('speaker-continuity');
        const focusText = buildRoleFocusText(role, session, request.latestUserMessage);
        if (normalizeText(focusText).includes(normalizeText(role.name)) || normalizeText(focusText).includes(normalizeText(role.displayName))) {
            reasons.push('topic-match');
        }
        if (!reasons.length)
            reasons.push('fallback');
        return uniq(reasons);
    }

    const DEFAULT_CONFIG = {
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
    class DirectorFacade {
        constructor(baseConfig = {}) {
            this.baseConfig = baseConfig;
        }
        getConfig(request) {
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
        planTurn(request) {
            const config = this.getConfig(request);
            const session = request.session;
            const roleScores = scoreRoles(session, request, config);
            const selectedRoleIds = pickSelectedRoles(roleScores, config.maxRoles);
            const orderedRoleIds = sortSelectedRoles(roleScores, selectedRoleIds, config.orderStrategy);
            const selectedRoles = session.characters.filter((c) => selectedRoleIds.includes(c.id));
            const worldBookScores = scoreWorldBooks(session, request, selectedRoles, config);
            const selectedWorldBookIds = worldBookScores.slice(0, config.maxWorldBooks).map((x) => x.entryId);
            const decision = {
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
        buildRolePayloads(plan) {
            return plan.payloads;
        }
        renderDirectorPrompt(plan) {
            return plan.promptBundle.directorPrompt;
        }
        renderRolePrompt(plan, roleId) {
            return plan.promptBundle.rolePrompts[roleId] || '';
        }
        summarizeSession(session) {
            return buildContextSummary(session);
        }
        buildContexts(params) {
            const { session, config, selectedRoles, selectedWorldBookIds, request } = params;
            const focusWorldBooks = session.worldBooks.filter((wb) => selectedWorldBookIds.includes(wb.id));
            const contexts = {};
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
        buildPayloads(params) {
            const { session, orderedRoleIds, contexts } = params;
            const result = [];
            for (let index = 0; index < orderedRoleIds.length; index++) {
                const roleId = orderedRoleIds[index];
                const role = session.characters.find((c) => c.id === roleId);
                const context = contexts[roleId];
                if (!role || !context)
                    continue;
                const payload = {
                    roleId,
                    roleName: role.displayName,
                    model: role.model || '',
                    status: 'queued',
                    orderIndex: index,
                    context,
                    prompt: '',
                };
                payload.prompt = buildRolePrompt(payload);
                result.push(payload);
            }
            return result;
        }
        makeDecisionReason(session, selectedRoles, worldBookIds) {
            const roleNames = selectedRoles.map((r) => r.displayName).join('、') || '无';
            const wbCount = worldBookIds.length;
            return `选择角色：${roleNames}；激活世界书：${wbCount} 条；会话消息：${session.messages.filter((m) => m.visible !== false).length} 条。`;
        }
        resolvePriority(reasons) {
            if (reasons.includes('manual'))
                return 'high';
            if (reasons.includes('mention') || reasons.includes('speaker-continuity'))
                return 'normal';
            return 'low';
        }
    }

    /**
     * ModelRouter —— 模型路由器
     *
     * 决定每个角色任务使用哪个模型。
     *
     * 设计决策：
     *
     * 1. 三层路由 vs 单层映射：
     *    - 单层映射：{roleId: model} 查表 → 简单但无降级
     *    - 三层路由：默认 → 角色专属 → 任务覆盖 → 降级链 → 报错
     *    ✅ 选三层路由：角色多模型混用是核心卖点，降级链保证鲁棒性
     *
     * 2. 降级策略：
     *    - 方案A：失败直接报错 → 用户体验差
     *    - 方案B：失败切 fallbackModels[0] → 简单但有概率二次失败
     *    - 方案C：失败沿降级链逐次尝试 → 最大化成功率
     *    ✅ 选C：在 fallbackModels 链上逐次降级，每个模型有独立超时
     *
     * 3. 模型名来源：
     *    - 在 SillyTavern 中，模型名是 ST 的连接标识符（如 "openai/gpt-4o"）
     *    - 本路由只返回模型名字符串，实际 API 调用由 ST 的 generate 接口完成
     *    ✅ 与 ST 的模型系统解耦：路由不关心后端是 OpenAI/Claude/本地模型
     */
    // ─── 路由器 ───────────────────────────────────────────
    class ModelRouter {
        constructor(config) {
            /** 记录每个模型最近的失败次数，用于自动降级 */
            this.failureCounts = new Map();
            /** 自动降级阈值：连续失败 N 次后自动切换到降级链 */
            this.autoDegradeThreshold = 3;
            this.config = config;
        }
        /**
         * 为任务选择模型
         *
         * 路由优先级：
         *  1. taskOverrides[taskId]  → 任务级覆盖（最高优先）
         *  2. roleModels[roleId]     → 角色专属模型
         *  3. defaultModel           → 全局默认
         *  4. fallbackModels[0]      → 降级链首位
         *  5. 抛出错误               → 无可用的模型
         */
        route(task) {
            // 层1: 任务级覆盖
            if (task.modelId) {
                return this.makeResult(task.modelId, 'task', `任务 ${task.taskId} 指定模型`);
            }
            const taskOverride = this.config.taskOverrides[task.taskId];
            if (taskOverride) {
                return this.makeResult(taskOverride, 'task', `任务级配置覆盖`);
            }
            // 层2: 角色专属模型
            const roleModel = this.config.roleModels[task.roleId];
            if (roleModel) {
                // 检查该模型是否因连续失败被临时降级
                if (this.shouldAutoDegrade(roleModel)) {
                    const fallback = this.findFallback(task);
                    return this.makeResult(fallback, 'fallback', `角色模型 ${roleModel} 近期失败过多，自动降级到 ${fallback}`);
                }
                return this.makeResult(roleModel, 'role', `角色 ${task.roleName} 专属模型`);
            }
            // 层3: 全局默认
            if (this.config.defaultModel) {
                if (this.shouldAutoDegrade(this.config.defaultModel)) {
                    const fallback = this.findFallback(task);
                    return this.makeResult(fallback, 'fallback', `默认模型 ${this.config.defaultModel} 近期失败过多，自动降级`);
                }
                return this.makeResult(this.config.defaultModel, 'default', '全局默认模型');
            }
            // 层4: 降级链
            if (this.config.fallbackModels.length > 0) {
                return this.makeResult(this.findFallback(task), 'fallback', '使用降级模型');
            }
            throw new Error(`[ModelRouter] 无法为角色 "${task.roleName}" (${task.roleId}) 分配模型。` +
                '请检查 ExecutionConfig 中的 modelRoute 配置。');
        }
        /**
         * 获取降级模型（用于重试）
         * 在降级链中找下一个未失败过度的模型
         */
        getFallbackForRetry(currentModelId, task) {
            const idx = this.config.fallbackModels.indexOf(currentModelId);
            // 从当前位置之后找
            for (let i = idx + 1; i < this.config.fallbackModels.length; i++) {
                const candidate = this.config.fallbackModels[i];
                if (!this.shouldAutoDegrade(candidate)) {
                    return candidate;
                }
            }
            return null;
        }
        /**
         * 记录模型调用失败
         */
        recordFailure(modelId) {
            const count = (this.failureCounts.get(modelId) || 0) + 1;
            this.failureCounts.set(modelId, count);
        }
        /**
         * 记录模型调用成功（重置失败计数）
         */
        recordSuccess(modelId) {
            this.failureCounts.delete(modelId);
        }
        /**
         * 更新路由配置（运行时动态调整）
         */
        updateConfig(partial) {
            this.config = { ...this.config, ...partial };
        }
        getConfig() {
            return { ...this.config };
        }
        // ── 内部 ─────────────────────────────────
        makeResult(modelId, level, reason) {
            return { modelId, level, isFallback: level === 'fallback', reason };
        }
        shouldAutoDegrade(modelId) {
            return (this.failureCounts.get(modelId) || 0) >= this.autoDegradeThreshold;
        }
        findFallback(task) {
            for (const fb of this.config.fallbackModels) {
                if (!this.shouldAutoDegrade(fb))
                    return fb;
            }
            throw new Error(`[ModelRouter] 角色 "${task.roleName}" 的所有降级模型均已失败，无法继续。`);
        }
    }

    /**
     * ExecutionEngine —— 执行引擎
     *
     * 负责真正发起模型调用，支持顺序/并行两种模式。
     *
     * 设计决策：
     *
     * 1. 模型调用方式：
     *    - 方案A：executor 内直接调 fetch/ST API → 耦合 ST，不可测试
     *    - 方案B：接受回调函数 (prompt, model) => text → 解耦，可测试，后端无关
     *    ✅ 选B：GenerateCallback 由插件层注入，executor 不关心底层是 ST/OpenAI/本地
     *
     * 2. 超时处理：
     *    - 方案A：AbortController → 标准但浏览器端有兼容问题
     *    - 方案B：Promise.race + setTimeout → 简单可靠，但无法真正中断底层请求
     *    ✅ 选B：Promise.race 在 JS 环境最可靠，虽然无法中断底层 TCP 连接，
     *       但对用户体验来说"超时就放弃"的效果是一样的
     *
     * 3. 重试策略：
     *    - 方案A：固定重试 N 次 → 简单
     *    - 方案B：指数退避 → 适合网络波动但增加延迟
     *    - 方案C：立即重试 + 切模型 → 最大化成功率
     *    ✅ 选C：第一次重试用原模型（可能是临时网络问题），
     *       第二次重试切降级模型（可能是模型本身的问题），最大化成功率
     *
     * 4. 并发控制：
     *    - 在并行模式下，不是无限制并发，而是用 maxConcurrency 限制
     *    - 用分批 Promise.all 实现：每批最多 maxConcurrency 个并发
     *    ✅ 防止同时发起 20 个 API 调用导致限流
     */
    // ─── 执行引擎 ─────────────────────────────────────────
    class ExecutionEngine {
        constructor(config) {
            this.generateCallback = null;
            this.config = config;
            this.modelRouter = new ModelRouter(config.modelRoute);
        }
        /**
         * 设置生成回调（由插件层注入）
         */
        setGenerateCallback(callback) {
            this.generateCallback = callback;
        }
        /**
         * 获取内部模型路由器（用于外部查询路由信息）
         */
        getModelRouter() {
            return this.modelRouter;
        }
        /**
         * 执行一批角色任务
         *
         * 根据 config.mode 自动选择顺序或并行模式。
         * 返回 ExecutionReport 包含所有输出和统计信息。
         */
        async execute(tasks) {
            if (!this.generateCallback) {
                throw new Error('[ExecutionEngine] 未设置 generateCallback。请先调用 setGenerateCallback()。');
            }
            const startTime = performance.now();
            const validTasks = tasks.filter(t => t.status !== 'skipped');
            if (validTasks.length === 0) {
                return this.emptyReport(startTime);
            }
            // 按 mode 选择执行策略
            let outputs;
            if (this.config.mode === 'parallel') {
                outputs = await this.executeParallel(validTasks);
            }
            else {
                outputs = await this.executeSequential(validTasks);
            }
            return this.buildReport(outputs, startTime);
        }
        /**
         * 顺序执行：一个接一个
         *
         * 每个角色能看到前面角色的输出（由调用方在 context 中体现），
         * executor 只保证执行顺序，不修改 context。
         */
        async executeSequential(tasks) {
            const outputs = [];
            for (const task of [...tasks].sort((a, b) => a.order - b.order)) {
                const output = await this.executeOneTask(task);
                outputs.push(output);
            }
            return outputs;
        }
        /**
         * 并行执行：分批并发
         *
         * 所有并行的角色共享同一份 context 快照（调用方负责一致性）。
         * 用 maxConcurrency 限制并发数，防止 API 限流。
         */
        async executeParallel(tasks) {
            const sorted = [...tasks].sort((a, b) => a.order - b.order);
            const outputs = [];
            const maxCon = Math.max(1, this.config.maxConcurrency);
            // 分批执行
            for (let i = 0; i < sorted.length; i += maxCon) {
                const batch = sorted.slice(i, i + maxCon);
                const batchResults = await Promise.all(batch.map(task => this.executeOneTask(task)));
                outputs.push(...batchResults);
            }
            // 恢复原始顺序
            return outputs.sort((a, b) => {
                const ta = tasks.find(t => t.taskId === a.taskId);
                const tb = tasks.find(t => t.taskId === b.taskId);
                return (ta?.order ?? 0) - (tb?.order ?? 0);
            });
        }
        /**
         * 执行单个任务（含重试和降级逻辑）
         */
        async executeOneTask(task) {
            const taskStart = performance.now();
            let currentModelId = '';
            let lastError = '';
            // 获取初始模型
            try {
                const route = this.modelRouter.route(task);
                currentModelId = route.modelId;
            }
            catch (e) {
                return this.makeFailedOutput(task, '', 0, String(e));
            }
            const maxAttempts = 1 + (task.maxRetries ?? this.config.defaultMaxRetries);
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                try {
                    const result = await this.callWithTimeout(task, currentModelId);
                    const latency = Math.round(performance.now() - taskStart);
                    // 成功：重置该模型的失败计数
                    this.modelRouter.recordSuccess(currentModelId);
                    return {
                        taskId: task.taskId,
                        roleId: task.roleId,
                        roleName: task.roleName,
                        content: result.text, // 原始文本，调用方再归一化
                        status: 'success',
                        modelId: currentModelId,
                        tokensUsed: result.tokensUsed,
                        latencyMs: latency,
                        raw: result.text,
                        normSteps: [],
                        error: '',
                        timestamp: Date.now(),
                    };
                }
                catch (e) {
                    lastError = String(e);
                    this.modelRouter.recordFailure(currentModelId);
                    // 最后一次尝试：切降级模型
                    if (attempt < maxAttempts - 1) {
                        const fallback = this.modelRouter.getFallbackForRetry(currentModelId, task);
                        if (fallback) {
                            currentModelId = fallback;
                            continue; // 用降级模型重试
                        }
                    }
                }
            }
            // 所有尝试均失败
            const latency = Math.round(performance.now() - taskStart);
            return this.makeFailedOutput(task, currentModelId, latency, lastError);
        }
        /**
         * 带超时的单次模型调用
         */
        async callWithTimeout(task, modelId) {
            const deadline = task.deadlineMs || this.config.defaultDeadlineMs;
            const result = await Promise.race([
                this.generateCallback(task.instruction, modelId, deadline),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`模型调用超时 (${deadline}ms)`)), deadline)),
            ]);
            return result;
        }
        // ── 辅助 ─────────────────────────────────
        makeSkippedOutput(task) {
            return {
                taskId: task.taskId, roleId: task.roleId, roleName: task.roleName,
                content: '', status: 'skipped', modelId: '', tokensUsed: 0,
                latencyMs: 0, raw: '', normSteps: ['任务被跳过'], error: '', timestamp: Date.now(),
            };
        }
        makeFailedOutput(task, modelId, latencyMs, error) {
            return {
                taskId: task.taskId, roleId: task.roleId, roleName: task.roleName,
                content: '', status: 'failed', modelId, tokensUsed: 0,
                latencyMs, raw: '', normSteps: [], error, timestamp: Date.now(),
            };
        }
        buildReport(outputs, startTime) {
            const totalLatency = Math.round(performance.now() - startTime);
            return {
                reportId: nowId('report'),
                sessionId: '',
                outputs,
                successCount: outputs.filter(o => o.status === 'success').length,
                failedCount: outputs.filter(o => o.status === 'failed').length,
                skippedCount: outputs.filter(o => o.status === 'skipped').length,
                totalLatencyMs: totalLatency,
                totalTokens: outputs.reduce((sum, o) => sum + o.tokensUsed, 0),
                mode: this.config.mode,
                timestamp: Date.now(),
            };
        }
        emptyReport(startTime) {
            return {
                reportId: nowId('report'), sessionId: '',
                outputs: [], successCount: 0, failedCount: 0, skippedCount: 0,
                totalLatencyMs: Math.round(performance.now() - startTime),
                totalTokens: 0, mode: this.config.mode, timestamp: Date.now(),
            };
        }
    }

    /**
     * OutputNormalizer —— 输出归一器
     *
     * 把模型原始回复清洗成干净的角色台词。
     *
     * 设计决策：
     *
     * 1. 清洗策略：
     *    - 方案A：纯正则 → 快、免费、可预测，覆盖 90% 场景
     *    - 方案B：LLM 二次清洗 → 更准但多一次 API 调用，延迟翻倍
     *    - 方案C：正则主力 + LLM 兜底（正则结果可疑时触发）→ 平衡
     *    ✅ 选A（MVP），预留C的接口：正则覆盖绝大多数脏输出模式，
     *       LLM 兜底的触发条件很难定义清楚（什么叫"可疑"？），先不做。
     *
     * 2. 空输出处理：
     *    - 方案A：直接标记 failed → 简单但可能浪费（模型其实回复了只是格式不对）
     *    - 方案B：标记 degraded，返回原始文本供调试 → 不丢失信息
     *    ✅ 选B：保留 raw 字段，让调用方决定是否接受降级结果
     *
     * 3. 重复检测：
     *    - 方案A：完全禁止重复 → 太严格，角色可能合理地说相同的话
     *    - 方案B：只检测"回声重复"（和输入原文一模一样）→ 精准
     *    ✅ 选B：只过滤明显的回声/复制粘贴，不干预合理的相似表达
     */
    const DEFAULT_NORMALIZE_OPTIONS = {
        stripRoleNamePrefix: true,
        stripThinkingTags: true,
        stripMetaDiscourse: true,
        maxLength: 2000,
        minLength: 1,
        trimIncomplete: false, // 默认不裁，保留完整回复
        roleNames: [],
    };
    // ─── 主归一化函数 ─────────────────────────────────────
    /**
     * 清洗单条角色输出
     *
     * 返回清洗后的结果 + 步骤日志，方便调试。
     */
    function normalizeOutput(output, options = {}) {
        const opts = { ...DEFAULT_NORMALIZE_OPTIONS, ...options };
        const steps = [];
        let content = output.raw || output.content;
        if (!content || content.trim().length === 0) {
            return {
                ...output,
                content: '',
                status: 'failed',
                normSteps: ['空输出，无法归一化'],
                error: output.error || '模型返回空内容',
            };
        }
        const originalLength = content.length;
        // Step 1: 基础清理
        content = content.trim();
        steps.push(`原始长度: ${originalLength} 字符`);
        // Step 2: 移除思考标签
        if (opts.stripThinkingTags) {
            const beforeThought = content.length;
            content = stripThinkingTags(content);
            if (content.length < beforeThought) {
                steps.push(`移除思考标签: -${beforeThought - content.length} 字符`);
            }
        }
        // Step 3: 移除角色名前缀
        if (opts.stripRoleNamePrefix) {
            const allNames = [output.roleName, ...opts.roleNames];
            const beforePrefix = content.length;
            content = stripRolePrefix(content, allNames);
            if (content.length < beforePrefix) {
                steps.push(`移除角色名前缀: -${beforePrefix - content.length} 字符`);
            }
        }
        // Step 4: 移除元话语
        if (opts.stripMetaDiscourse) {
            const beforeMeta = content.length;
            content = stripMetaDiscourse(content);
            if (content.length < beforeMeta) {
                steps.push(`移除元话语: -${beforeMeta - content.length} 字符`);
            }
        }
        // Step 5: 清洗多余空白
        content = normalizeWhitespace(content);
        // Step 6: 长度截断
        if (content.length > opts.maxLength) {
            content = content.slice(0, opts.maxLength);
            if (opts.trimIncomplete) {
                content = trimToLastCompleteSentence(content);
            }
            steps.push(`截断到 ${opts.maxLength} 字符`);
        }
        // Step 7: 最终修剪
        content = content.trim();
        // Step 8: 结果判断
        if (content.length < opts.minLength) {
            steps.push(`⚠ 输出过短 (${content.length} 字符)，标记为失败`);
            return {
                ...output,
                content,
                status: 'failed',
                normSteps: steps,
                error: '归一化后内容为空或过短',
            };
        }
        steps.push(`归一化完成: ${content.length} 字符`);
        return {
            ...output,
            content,
            status: output.status, // 保持原始状态，不因归一化改变
            normSteps: steps,
        };
    }
    /**
     * 批量归一化
     */
    function normalizeOutputs(outputs, options = {}) {
        return outputs.map(o => normalizeOutput(o, options));
    }
    // ─── 清洗规则 ─────────────────────────────────────────
    /**
     * 移除思考标签
     *
     * 匹配模式：
     *  思考...
     *  [思考]...[思考]
     *  thinking...
     *  <thinking>...</thinking>
     */
    function stripThinkingTags(text) {
        // XML 风格标签（完整）
        text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
        // XML 风格标签（不完整/自闭合）
        text = text.replace(/<think(?:ing)?\s*\/>/gi, '');
        // 中文方括号风格
        text = text.replace(/【思考】[\s\S]*?【\/?思考】?/g, '');
        text = text.replace(/\[思考\][\s\S]*?\[\/?思考\]?/g, '');
        // 单行思考前缀
        text = text.replace(/^(?:思考|thinking|thought)\s*[:：]\s*.+$/gim, '');
        // SillyTavern 风格: 思考...  (单行)
        text = text.replace(/^思考[：:]\s*.+$/gim, '');
        return text;
    }
    /**
     * 移除角色名前缀
     *
     * 匹配模式：
     *  角色A: 你好 → 你好
     *  【角色A】你好 → 你好
     *  角色A：你好 → 你好
     */
    function stripRolePrefix(text, roleNames) {
        for (const name of roleNames) {
            if (!name)
                continue;
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // 只在开头匹配
            const pattern = new RegExp(`^${escaped}\\s*[:：]\\s*`, 'i');
            if (pattern.test(text)) {
                text = text.replace(pattern, '');
                break; // 只移除一个匹配
            }
            // 方括号/中文括号包裹
            const bracketPattern = new RegExp(`^[【\\[]\\s*${escaped}\\s*[】\\]]\\s*`, 'i');
            if (bracketPattern.test(text)) {
                text = text.replace(bracketPattern, '');
                break;
            }
        }
        return text;
    }
    /**
     * 移除 AI 元话语
     *
     * 匹配模式：
     *  "作为AI..."
     *  "我来回答..."
     *  "根据设定..."
     *  "好的，我将扮演..."
     *  "(点头)" "(微笑)" 等动作描述
     */
    function stripMetaDiscourse(text) {
        const patterns = [
            // 中文元话语
            /^(?:作为(?:一个|一名)?(?:AI|人工智能|语言模型|角色扮演)[，,]?\s*)+/gi,
            /^(?:好的[，,]\s*)?(?:我来?|让我来?)(?:回答|扮演|饰演|表演|演示)/gi,
            /^(?:根据(?:设定|角色|剧本|上下文)[，,]?\s*)+/gi,
            /^(?:我会|我将)(?:扮演|饰演|回答|按照)/gi,
            /^(?:以下是|下面是)(?:我的)?(?:回答|扮演|回复)/gi,
            // 英文元话语
            /^(?:as\s+(?:an?\s+)?(?:AI|language\s+model)[，,]\s*)+/gi,
            /^(?:I\s+will|let\s+me)\s+(?:answer|play|roleplay|respond)/gi,
            /^(?:here\s+(?:is|are)\s+(?:my\s+)?(?:response|answer|reply))/gi,
        ];
        for (const pattern of patterns) {
            text = text.replace(pattern, '');
        }
        return text.trim();
    }
    /**
     * 规范化空白
     */
    function normalizeWhitespace(text) {
        // 合并多个连续换行为双换行
        text = text.replace(/\n{3,}/g, '\n\n');
        // 去除行首尾空白
        text = text.split('\n').map(l => l.trim()).join('\n');
        // 合并多个连续空格
        text = text.replace(/[ \t]{2,}/g, ' ');
        return text;
    }
    /**
     * 裁剪到最后一个完整句子
     */
    function trimToLastCompleteSentence(text) {
        const sentenceEnd = /[。！？.!?\n](?=[^。！？.!?\n]*$)/;
        const match = text.match(sentenceEnd);
        if (match && match.index !== undefined && match.index > text.length * 0.3) {
            return text.slice(0, match.index + 1);
        }
        return text;
    }

    /**
     * Writer —— 回写适配器
     *
     * 把角色执行结果写回聊天系统和 UI。
     *
     * 设计决策：
     *
     * 1. 回写目标：
     *    - 方案A：直接写 ST 全局状态 → 简单但绕过 ST 的消息管理
     *    - 方案B：通过回调注入，由插件层决定写到哪里 → 解耦
     *    ✅ 选B：WriteCallback 让 writer 不关心目标是 ST/内部缓存/文件
     *
     * 2. 回写时机：
     *    - 方案A：每个角色生成完立即回写 → 实时但顺序模式下后发言的角色看不到前者的内容
     *    - 方案B：全部生成完后统一回写 → 一致但延迟
     *    - 方案C：顺序模式逐条回写，并行模式统一回写 → 因地制宜
     *    ✅ 选C：顺序模式时每个角色应看到前者的输出，所以逐条回写；
     *       并行模式时所有角色基于同一快照，统一回写更合理
     *
     * 3. 写回内容格式：
     *    - 方案A：只写纯文本 → 丢信息
     *    - 方案B：写 Message 对象 + 元数据 → 完整可追踪
     *    ✅ 选B：附带 modelId/tokens/latency 等元数据，方便调试和日志
     */
    // ─── Writer 类 ────────────────────────────────────────
    class Writer {
        constructor() {
            this.writeCallback = null;
            this.completeCallback = null;
        }
        /**
         * 设置回写回调
         */
        setWriteCallback(callback) {
            this.writeCallback = callback;
        }
        /**
         * 设置完成回调
         */
        setCompleteCallback(callback) {
            this.completeCallback = callback;
        }
        /**
         * 写入单条角色输出
         */
        async writeOne(output, turnIndex) {
            if (!this.writeCallback)
                return null;
            const msg = {
                id: `role_${output.taskId}_${Date.now()}`,
                role: 'character',
                speaker: output.roleName,
                content: output.content,
                turnIndex,
                timestamp: Date.now(),
                visible: true,
                modelId: output.modelId,
                tokensUsed: output.tokensUsed,
                latencyMs: output.latencyMs,
                isDirectorMessage: false,
            };
            await this.writeCallback(msg);
            return msg;
        }
        /**
         * 写入导演决策消息
         */
        async writeDirectorNote(note, turnIndex, modelId = '') {
            if (!this.writeCallback)
                return null;
            const msg = {
                id: `director_${Date.now()}`,
                role: 'system',
                speaker: '🎬 导演',
                content: note,
                turnIndex,
                timestamp: Date.now(),
                visible: true,
                modelId,
                tokensUsed: 0,
                latencyMs: 0,
                isDirectorMessage: true,
            };
            await this.writeCallback(msg);
            return msg;
        }
        /**
         * 构造失败消息对象（供 writeReport 内部使用）
         */
        makeFailMessage(output, turnIndex) {
            return {
                id: `fail_${output.taskId}`,
                role: 'system',
                speaker: '⚠️ 系统',
                content: `角色 "${output.roleName}" 生成失败: ${output.error || '未知错误'}`,
                turnIndex,
                timestamp: Date.now(),
                visible: true,
                modelId: output.modelId,
                tokensUsed: 0,
                latencyMs: output.latencyMs,
                isDirectorMessage: false,
            };
        }
        /**
         * 按模式写入整批结果
         *
         * 顺序模式：逐条写入（后面的角色能看到前面的输出）
         * 并行模式：统一批量写入
         */
        async writeReport(report, baseTurnIndex, mode) {
            const written = [];
            const successes = report.outputs.filter(o => o.status === 'success');
            if (mode === 'sequential') {
                // 逐条写入，按报告中的实际位置递增 turnIndex（含失败和成功）
                let turnOffset = 0;
                for (const output of report.outputs) {
                    if (output.status === 'success') {
                        const msg = await this.writeOne(output, baseTurnIndex + turnOffset);
                        if (msg)
                            written.push(msg);
                        turnOffset++;
                    }
                    else if (output.status === 'failed') {
                        const failMsg = this.makeFailMessage(output, baseTurnIndex + turnOffset);
                        if (this.writeCallback) {
                            await this.writeCallback(failMsg);
                            written.push(failMsg);
                        }
                        turnOffset++;
                    }
                    // skipped 不占 turnIndex
                }
            }
            else {
                // 并行模式：所有成功输出同一 turnIndex
                for (const output of successes) {
                    const msg = await this.writeOne(output, baseTurnIndex);
                    if (msg)
                        written.push(msg);
                }
                // 失败消息用 baseTurnIndex（并行模式下所有输出同一轮）
                const failures = report.outputs.filter(o => o.status === 'failed');
                for (const failed of failures) {
                    const failMsg = this.makeFailMessage(failed, baseTurnIndex);
                    if (this.writeCallback) {
                        await this.writeCallback(failMsg);
                        written.push(failMsg);
                    }
                }
            }
            // 触发完成回调
            this.completeCallback?.(report);
            return written;
        }
        /**
         * 更新 UI 日志（通过 window 事件）
         */
        notifyUI(report) {
            try {
                window.dispatchEvent(new CustomEvent('tavern-director:execution-complete', {
                    detail: {
                        successCount: report.successCount,
                        failedCount: report.failedCount,
                        skippedCount: report.skippedCount,
                        totalLatencyMs: report.totalLatencyMs,
                        totalTokens: report.totalTokens,
                        outputs: report.outputs.map(o => ({
                            roleName: o.roleName,
                            content: o.content.slice(0, 100),
                            status: o.status,
                            modelId: o.modelId,
                        })),
                    },
                }));
            }
            catch {
                // 静默失败（不在浏览器环境）
            }
        }
    }
    // ─── 工厂 ─────────────────────────────────────────────
    function createWriter(writeCallback, completeCallback) {
        const w = new Writer();
        return w;
    }

    /**
     * 插件配置持久化 —— localStorage + JSON 导出/导入
     *
     * 设计决策（多方案对比）：
     *
     * 1. 存储后端选择：
     *    | 方案                     | 刷新保留 | 换端口不丢 | 可备份 | 复杂度 |
     *    |--------------------------|:------:|:--------:|:----:|------|
     *    | localStorage             | ✅     | ❌       | 手动  | 低    |
     *    | localStorage + 导出/导入 | ✅     | ✅ (手动) | ✅   | 中    |
     *    | ST extension_settings    | ?      | ?        | ?    | API 不确定 |
     *    | IndexedDB                | ✅     | ❌       | 手动  | 高（无收益）|
     *    | Cookie                   | ✅     | ❌       | 手动  | 4KB 太小 |
     *
     *    ✅ 选 localStorage + 导出/导入：
     *      - localStorage 覆盖 95% 场景（页面刷新、ST 重启）
     *      - 导出/导入 JSON 解决换端口/清缓存后的恢复
     *      - ST 插件圈最常用的方案，用户预期一致
     *      - 零外部依赖，可在任何浏览器环境运行
     *
     * 2. 存储 key 命名：
     *    - 使用 `tavern_director_settings_v1` 而非纯 `tavern_director_settings`
     *    - 版本号后缀允许未来做 schema 迁移时共存旧数据
     *
     * 3. 数据校验：
     *    - 每次 load() 后做基本结构校验
     *    - 校验失败返回默认值并 warn，不抛错（插件必须能在无配置时正常工作）
     *
     * 4. 敏感数据：
     *    - API Key 不做加密（ST 运行在 localhost，物理访问 = 已沦陷）
     *    - 导出 JSON 时提醒用户文件含敏感信息
     */
    // ─── 配置版本号 ──────────────────────────────────────
    const CURRENT_VERSION = 1;
    // ─── localStorage key ────────────────────────────────
    const STORAGE_KEY = 'tavern_director_settings_v1';
    // ─── 默认配置 ───────────────────────────────────────
    function createDefaultSettings() {
        return {
            version: CURRENT_VERSION,
            mode: 'sequential',
            defaultDeadlineMs: 30000,
            defaultMaxRetries: 2,
            maxConcurrency: 4,
            defaultModel: '',
            directorModel: '',
            roleModels: {},
            fallbackModels: [],
            taskOverrides: {},
            jailbreakText: '',
            jailbreakName: '',
            worldbookBindings: {},
            autoStart: false,
            pollIntervalMs: 2000,
        };
    }
    // ─── SettingsStore 类 ───────────────────────────────
    class SettingsStore {
        constructor() {
            this.listeners = new Set();
            this.settings = this.load();
        }
        // ═══════════════════════════════════════════════════
        // 持久化
        // ═══════════════════════════════════════════════════
        /**
         * 从 localStorage 加载配置。
         * 数据损坏或缺失时返回默认值。
         */
        load() {
            try {
                if (typeof localStorage === 'undefined') {
                    console.warn('[SettingsStore] localStorage 不可用，使用默认配置');
                    return createDefaultSettings();
                }
                const raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) {
                    console.log('[SettingsStore] 首次运行，使用默认配置');
                    return createDefaultSettings();
                }
                const parsed = JSON.parse(raw);
                // 基本结构校验
                if (!parsed || typeof parsed !== 'object') {
                    throw new Error('配置数据格式无效');
                }
                // 版本迁移（未来扩展）
                if (parsed.version !== CURRENT_VERSION) {
                    console.log(`[SettingsStore] 配置版本 ${parsed.version} → ${CURRENT_VERSION}，执行迁移`);
                    return this.migrate(parsed);
                }
                // 合并默认值（填充新增字段）
                const defaults = createDefaultSettings();
                const merged = { ...defaults, ...parsed };
                return merged;
            }
            catch (e) {
                console.warn('[SettingsStore] 加载配置失败，使用默认值:', e);
                return createDefaultSettings();
            }
        }
        /**
         * 保存配置到 localStorage。
         */
        save() {
            try {
                if (typeof localStorage === 'undefined') {
                    console.warn('[SettingsStore] localStorage 不可用，配置未保存');
                    return false;
                }
                this.settings.version = CURRENT_VERSION;
                localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings, null, 2));
                console.log('[SettingsStore] 配置已保存');
                return true;
            }
            catch (e) {
                console.error('[SettingsStore] 保存配置失败:', e);
                return false;
            }
        }
        /**
         * 导出配置为 JSON 字符串（供下载/备份）。
         */
        exportJSON() {
            const copy = { ...this.settings };
            copy.version = CURRENT_VERSION;
            return JSON.stringify(copy, null, 2);
        }
        /**
         * 从 JSON 字符串导入配置。
         * 导入后自动保存。
         */
        importJSON(json) {
            try {
                const parsed = JSON.parse(json);
                if (!parsed || typeof parsed !== 'object') {
                    return { success: false, message: 'JSON 格式无效：不是有效的对象' };
                }
                const defaults = createDefaultSettings();
                const merged = { ...defaults, ...parsed, version: CURRENT_VERSION };
                this.settings = this.validateAndFix(merged);
                this.save();
                this.notify();
                return { success: true, message: '配置导入成功' };
            }
            catch (e) {
                return { success: false, message: `导入失败: ${String(e)}` };
            }
        }
        /**
         * 重置为默认配置。
         * 重置后自动保存。
         */
        reset() {
            this.settings = createDefaultSettings();
            this.save();
            this.notify();
            console.log('[SettingsStore] 配置已重置为默认值');
        }
        // ═══════════════════════════════════════════════════
        // 读取
        // ═══════════════════════════════════════════════════
        getSettings() {
            return { ...this.settings };
        }
        /** 获取精简版（不可变），防止外部误改 */
        getRaw() {
            // 返回深层拷贝，防止外部代码绕过 setter 直接修改内部状态
            return JSON.parse(JSON.stringify(this.settings));
        }
        // ═══════════════════════════════════════════════════
        // 分段更新（只改部分字段，自动保存）
        // ═══════════════════════════════════════════════════
        /**
         * 更新执行/路由配置
         */
        updateExecutionConfig(partial) {
            Object.assign(this.settings, partial);
            this.save();
            this.notify();
        }
        /**
         * 更新模型路由配置
         */
        updateModelRoute(partial) {
            if (partial.defaultModel !== undefined)
                this.settings.defaultModel = partial.defaultModel;
            if (partial.directorModel !== undefined)
                this.settings.directorModel = partial.directorModel;
            if (partial.fallbackModels !== undefined)
                this.settings.fallbackModels = partial.fallbackModels;
            if (partial.taskOverrides !== undefined)
                this.settings.taskOverrides = partial.taskOverrides;
            this.save();
            this.notify();
        }
        /**
         * 设置角色专属模型
         */
        setRoleModel(roleId, modelId) {
            this.settings.roleModels[roleId] = modelId;
            this.save();
            this.notify();
        }
        /**
         * 删除角色模型绑定
         */
        removeRoleModel(roleId) {
            delete this.settings.roleModels[roleId];
            this.save();
            this.notify();
        }
        /**
         * 批量设置角色模型映射
         */
        setRoleModels(map) {
            this.settings.roleModels = { ...map };
            this.save();
            this.notify();
        }
        /**
         * 设置破限文本
         */
        setJailbreak(text, name) {
            this.settings.jailbreakText = text;
            if (name !== undefined)
                this.settings.jailbreakName = name;
            this.save();
            this.notify();
        }
        /**
         * 设置世界书绑定
         */
        setWorldbookBinding(entryId, roleIds) {
            if (roleIds.length === 0) {
                delete this.settings.worldbookBindings[entryId];
            }
            else {
                this.settings.worldbookBindings[entryId] = [...roleIds];
            }
            this.save();
            this.notify();
        }
        /**
         * 批量设置世界书绑定
         */
        setWorldbookBindings(bindings) {
            this.settings.worldbookBindings = { ...bindings };
            this.save();
            this.notify();
        }
        /**
         * 获取世界书绑定
         */
        getWorldbookBindings() {
            return { ...this.settings.worldbookBindings };
        }
        /**
         * 更新界面偏好
         */
        updateUIPrefs(partial) {
            if (partial.autoStart !== undefined)
                this.settings.autoStart = partial.autoStart;
            if (partial.pollIntervalMs !== undefined)
                this.settings.pollIntervalMs = partial.pollIntervalMs;
            this.save();
            this.notify();
        }
        // ═══════════════════════════════════════════════════
        // 派生：生成 ExecutionConfig
        // ═══════════════════════════════════════════════════
        /**
         * 从持久化配置生成 ExecutionConfig（供 ExecutionEngine 使用）
         */
        toExecutionConfig() {
            return {
                mode: this.settings.mode,
                defaultDeadlineMs: this.settings.defaultDeadlineMs,
                defaultMaxRetries: this.settings.defaultMaxRetries,
                maxConcurrency: this.settings.maxConcurrency,
                modelRoute: this.toModelRouteConfig(),
            };
        }
        /**
         * 从持久化配置生成 ModelRouteConfig
         */
        toModelRouteConfig() {
            return {
                defaultModel: this.settings.defaultModel,
                roleModels: { ...this.settings.roleModels },
                fallbackModels: [...this.settings.fallbackModels],
                directorModel: this.settings.directorModel,
                taskOverrides: { ...this.settings.taskOverrides },
            };
        }
        // ═══════════════════════════════════════════════════
        // 变更监听
        // ═══════════════════════════════════════════════════
        /**
         * 订阅配置变更。返回取消订阅函数。
         */
        subscribe(listener) {
            this.listeners.add(listener);
            return () => this.listeners.delete(listener);
        }
        // ═══════════════════════════════════════════════════
        // 内部
        // ═══════════════════════════════════════════════════
        notify() {
            const snap = this.getSettings();
            this.listeners.forEach(fn => {
                try {
                    fn(snap);
                }
                catch { /* 隔离监听器异常 */ }
            });
        }
        /**
         * 版本迁移入口（当前仅 v1，未来扩展）
         */
        migrate(old) {
            const defaults = createDefaultSettings();
            // v0 → v1: 无旧数据需要转换，直接合并
            const merged = { ...defaults, ...old, version: CURRENT_VERSION };
            return this.validateAndFix(merged);
        }
        /**
         * 校验并修复配置中的非法值
         */
        validateAndFix(settings) {
            const fixed = { ...settings };
            if (fixed.defaultDeadlineMs < 1000)
                fixed.defaultDeadlineMs = 30000;
            if (fixed.defaultDeadlineMs > 300000)
                fixed.defaultDeadlineMs = 300000;
            if (fixed.defaultMaxRetries < 0)
                fixed.defaultMaxRetries = 0;
            if (fixed.defaultMaxRetries > 10)
                fixed.defaultMaxRetries = 10;
            if (fixed.maxConcurrency < 1)
                fixed.maxConcurrency = 1;
            if (fixed.maxConcurrency > 16)
                fixed.maxConcurrency = 16;
            if (fixed.pollIntervalMs < 500)
                fixed.pollIntervalMs = 2000;
            if (fixed.pollIntervalMs > 30000)
                fixed.pollIntervalMs = 30000;
            if (!fixed.mode || !['sequential', 'parallel'].includes(fixed.mode)) {
                fixed.mode = 'sequential';
            }
            return fixed;
        }
    }
    // ─── 全局单例 ──────────────────────────────────────
    const settingsStore = new SettingsStore();

    /**
     * 角色选择器 —— 注入页面内的暗色主题弹层
     *
     * 替代浏览器原生 prompt()，提供与插件仪表盘风格一致的
     * 角色选择体验。
     *
     * 设计决策：
     *
     * 1. DOM 注入 vs 复用现有 HTML：
     *    - 复用现有 HTML：需要 shell.html/preview.html 里预埋模板
     *    - DOM 注入：自包含，不依赖页面结构，任何地方都能调用
     *    ✅ 选 DOM 注入：选择器是临时 UI，用完即销毁，不应绑定到页面模板
     *
     * 2. Promise vs 回调：
     *    - 回调：需要管理回调状态
     *    - Promise：天然适合"等待用户选择"的语义，支持 async/await
     *    ✅ 选 Promise：调用方 await 等待结果，代码更线性
     *
     * 3. 单文件无依赖：
     *    - 不依赖任何框架（React/Vue/jQuery）
     *    - 不依赖项目内的 CSS 变量（自己内联样式，确保在任何页面都能用）
     *    ✅ 可在 bootstrap、settings panel、legacy code 等任何位置调用
     */
    // ─── 全局样式（只注入一次） ────────────────────────────
    let stylesInjected = false;
    function injectStyles() {
        if (stylesInjected)
            return;
        stylesInjected = true;
        const css = `
    .td-rs-overlay {
      position: fixed; inset: 0; z-index: 99999;
      background: rgba(0,0,0,0.65);
      display: flex; align-items: center; justify-content: center;
      animation: td-rs-fadein 0.15s ease;
    }
    @keyframes td-rs-fadein { from { opacity: 0; } to { opacity: 1; } }
    .td-rs-dialog {
      background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 12px;
      width: 420px; max-width: 94vw; max-height: 80vh;
      display: flex; flex-direction: column;
      box-shadow: 0 8px 40px rgba(0,0,0,0.5);
      animation: td-rs-slide 0.2s ease;
    }
    @keyframes td-rs-slide { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .td-rs-header {
      padding: 16px 20px 12px; border-bottom: 1px solid #2a2a4a;
      display: flex; align-items: center; justify-content: space-between;
    }
    .td-rs-title { color: #e0e0e0; font-size: 15px; font-weight: 600; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans SC',sans-serif; }
    .td-rs-close { background: none; border: none; color: #9090a8; font-size: 20px; cursor: pointer; padding: 0; line-height: 1; }
    .td-rs-close:hover { color: #e0e0e0; }
    .td-rs-search { padding: 10px 20px; }
    .td-rs-search input {
      width: 100%; box-sizing: border-box; padding: 8px 12px;
      background: #0f0f1a; border: 1px solid #2a2a4a; border-radius: 6px;
      color: #e0e0e0; font-size: 13px; outline: none;
      font-family: inherit;
    }
    .td-rs-search input:focus { border-color: #e94560; }
    .td-rs-search input::placeholder { color: #5a5a78; }
    .td-rs-list {
      flex: 1; overflow-y: auto; padding: 4px 12px 12px;
      max-height: 360px;
    }
    .td-rs-card {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; margin: 2px 0; border-radius: 8px;
      cursor: pointer; transition: background 0.12s;
      border: 1px solid transparent;
    }
    .td-rs-card:hover { background: #1f2b47; }
    .td-rs-card.selected { background: #1f2b47; border-color: #e94560; }
    .td-rs-card.disabled { opacity: 0.4; cursor: not-allowed; }
    .td-rs-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: #2a2a4a; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      color: #9090a8; font-size: 14px; font-weight: 600;
      overflow: hidden;
    }
    .td-rs-avatar img { width: 100%; height: 100%; object-fit: cover; }
    .td-rs-info { flex: 1; min-width: 0; }
    .td-rs-name { color: #e0e0e0; font-size: 13px; font-weight: 500; }
    .td-rs-desc { color: #6a6a88; font-size: 11px; margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .td-rs-tag {
      font-size: 10px; padding: 2px 6px; border-radius: 4px;
      background: #2a2a4a; color: #9090a8; flex-shrink: 0;
    }
    .td-rs-check {
      width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid #3a3a5a; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; color: #fff; transition: all 0.15s;
    }
    .td-rs-card.selected .td-rs-check {
      background: #e94560; border-color: #e94560;
    }
    .td-rs-footer {
      padding: 12px 20px; border-top: 1px solid #2a2a4a;
      display: flex; gap: 8px; justify-content: flex-end;
    }
    .td-rs-btn {
      padding: 7px 18px; border-radius: 6px; font-size: 13px;
      cursor: pointer; border: none; font-family: inherit;
      transition: background 0.12s;
    }
    .td-rs-btn-cancel { background: #2a2a4a; color: #9090a8; }
    .td-rs-btn-cancel:hover { background: #3a3a5a; }
    .td-rs-btn-confirm { background: #e94560; color: #fff; }
    .td-rs-btn-confirm:hover { background: #d63850; }
    .td-rs-btn-confirm:disabled { opacity: 0.4; cursor: not-allowed; }
    .td-rs-hint { color: #5a5a78; font-size: 11px; padding: 4px 0; text-align: center; }
  `;
        const style = document.createElement('style');
        style.textContent = css;
        style.id = 'td-role-selector-style';
        document.head.appendChild(style);
    }
    // ─── 主函数 ─────────────────────────────────────────
    function showRoleSelector(options) {
        injectStyles();
        const { title = '选择角色', roles, multi = false, preselected = [], minSelect = multi ? 1 : 1, maxSelect = multi ? roles.length : 1, confirmLabel = '确认', cancelLabel = '取消', searchPlaceholder = '搜索角色...', } = options;
        return new Promise((resolve) => {
            // 状态
            const selected = new Set(preselected.filter(id => roles.some(r => r.id === id && !r.disabled)));
            // 单选模式：只保留第一个预选
            if (!multi && selected.size > 1) {
                const first = [...selected][0];
                selected.clear();
                selected.add(first);
            }
            // ── 构建 DOM ──────────────────────────────
            const overlay = document.createElement('div');
            overlay.className = 'td-rs-overlay';
            const dialog = document.createElement('div');
            dialog.className = 'td-rs-dialog';
            // 头部
            const header = document.createElement('div');
            header.className = 'td-rs-header';
            header.innerHTML = `
      <span class="td-rs-title">${esc$1(title)}</span>
      <button class="td-rs-close" aria-label="关闭">&times;</button>
    `;
            // 搜索框
            const searchDiv = document.createElement('div');
            searchDiv.className = 'td-rs-search';
            const searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.placeholder = searchPlaceholder;
            searchDiv.appendChild(searchInput);
            // 角色列表
            const listDiv = document.createElement('div');
            listDiv.className = 'td-rs-list';
            // 提示文字
            const hintDiv = document.createElement('div');
            hintDiv.className = 'td-rs-hint';
            // 底部
            const footer = document.createElement('div');
            footer.className = 'td-rs-footer';
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'td-rs-btn td-rs-btn-cancel';
            cancelBtn.textContent = cancelLabel;
            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'td-rs-btn td-rs-btn-confirm';
            confirmBtn.textContent = confirmLabel;
            footer.appendChild(cancelBtn);
            footer.appendChild(confirmBtn);
            dialog.appendChild(header);
            dialog.appendChild(searchDiv);
            dialog.appendChild(listDiv);
            dialog.appendChild(hintDiv);
            dialog.appendChild(footer);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            // ── 渲染角色列表 ────────────────────────
            function render(filter = '') {
                listDiv.innerHTML = '';
                const q = filter.toLowerCase().trim();
                const filtered = roles.filter(r => {
                    if (q) {
                        const hay = (r.name + (r.displayName || '') + (r.description || '') + (r.tag || '')).toLowerCase();
                        return hay.includes(q);
                    }
                    return true;
                });
                if (filtered.length === 0) {
                    listDiv.innerHTML = '<div style="color:#6a6a88;text-align:center;padding:24px;">没有匹配的角色</div>';
                    return;
                }
                for (const role of filtered) {
                    const card = document.createElement('div');
                    card.className = 'td-rs-card';
                    if (selected.has(role.id))
                        card.classList.add('selected');
                    if (role.disabled)
                        card.classList.add('disabled');
                    const initial = (role.displayName || role.name).charAt(0).toUpperCase();
                    const avatarHTML = role.avatar
                        ? `<img src="${esc$1(role.avatar)}" alt="">`
                        : initial;
                    card.innerHTML = `
          <div class="td-rs-avatar">${avatarHTML}</div>
          <div class="td-rs-info">
            <div class="td-rs-name">${esc$1(role.displayName || role.name)}</div>
            ${role.description ? `<div class="td-rs-desc">${esc$1(role.description)}</div>` : ''}
          </div>
          ${role.tag ? `<span class="td-rs-tag">${esc$1(role.tag)}</span>` : ''}
          <div class="td-rs-check">${selected.has(role.id) ? '✓' : ''}</div>
        `;
                    if (!role.disabled) {
                        card.addEventListener('click', () => toggleRole(role.id));
                    }
                    listDiv.appendChild(card);
                }
            }
            function updateHint() {
                if (!multi) {
                    hintDiv.textContent = '';
                    return;
                }
                const n = selected.size;
                if (minSelect && maxSelect && minSelect === maxSelect) {
                    hintDiv.textContent = `已选 ${n} / ${maxSelect} 个角色`;
                }
                else {
                    hintDiv.textContent = `已选 ${n} 个角色`;
                }
            }
            function updateConfirm() {
                if (selected.size < minSelect) {
                    confirmBtn.disabled = true;
                }
                else {
                    confirmBtn.disabled = false;
                }
            }
            // ── 选择逻辑 ───────────────────────────
            function toggleRole(id) {
                if (multi) {
                    if (selected.has(id)) {
                        selected.delete(id);
                    }
                    else {
                        if (selected.size >= maxSelect) {
                            // 移除最早选中的
                            const first = [...selected][0];
                            if (first)
                                selected.delete(first);
                        }
                        selected.add(id);
                    }
                }
                else {
                    selected.clear();
                    selected.add(id);
                    // 单选：点击即确认
                    finish(true);
                    return;
                }
                render(searchInput.value);
                updateHint();
                updateConfirm();
            }
            // ── 事件绑定 ───────────────────────────
            // 关闭按钮
            header.querySelector('.td-rs-close').addEventListener('click', () => finish(false));
            // 点击遮罩关闭
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay)
                    finish(false);
            });
            // Escape 关闭
            const onKey = (e) => {
                if (e.key === 'Escape')
                    finish(false);
                if (e.key === 'Enter' && !confirmBtn.disabled)
                    finish(true);
            };
            document.addEventListener('keydown', onKey, { once: false });
            // 包装 finish：清理键盘监听后再执行原始逻辑
            let finish;
            const finishImpl = (confirmed) => {
                const result = {
                    selectedIds: [...selected],
                    confirmed,
                };
                overlay.remove();
                resolve(result);
            };
            finish = (confirmed) => {
                document.removeEventListener('keydown', onKey);
                finishImpl(confirmed);
            };
            // 搜索
            searchInput.addEventListener('input', () => render(searchInput.value));
            // 按钮
            cancelBtn.addEventListener('click', () => finish(false));
            confirmBtn.addEventListener('click', () => {
                if (!confirmBtn.disabled)
                    finish(true);
            });
            // 初始渲染
            render();
            updateHint();
            updateConfirm();
            searchInput.focus();
        });
    }
    // ─── 工具 ─────────────────────────────────────────
    function esc$1(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * 浮动控制面板 —— 注入到 ST 页面内的暗色主题操作台
     *
     * 两个 Tab：
     *   "控制台" — 角色列表 / 调度按钮 / 最近日志
     *   "配置"   — 模型路由 / 破限文本 / 世界书绑定 / 导出导入
     *
     * 不自动注入。由 bootstrap.ts 在 API 装配完毕后显式调用 injectFloatingPanel()。
     * 内部有重试机制：如果 document.body 尚不可用，每 200ms 重试最多 30 次。
     */
    function injectFloatingPanel() {
  // ── 悬浮窗图标 (WebP base64, 300x300, ~14KB) ──
  const FAB_IMG = '/scripts/extensions/third-party/sillytavern-director/fab-icon.webp';

  // 防止重复注入
  if ((window).__tdFloatingInjected) {
    console.log('[TavernDirector] 浮动面板已存在，跳过注入');
    return;
  }

  // 等待 body 就绪
  if (!document.body) {
    const retries = (window).__tdFloatingRetries || 0;
    if (retries >= 30) {
      console.error('[TavernDirector] ⚠️ document.body 在 6 秒内未就绪，放弃注入浮动面板');
      return;
    }
    (window).__tdFloatingRetries = retries + 1;
    console.log(`[TavernDirector] 等待 body 就绪... (${retries + 1}/30)`);
    setTimeout(injectFloatingPanel, 200);
    return;
  }

  (window).__tdFloatingInjected = true;
  console.log('[TavernDirector] 开始注入浮动面板...');

  // ═══════════════════════════════════════════════════
  // Inject CSS
  // ═══════════════════════════════════════════════════
  const css = document.createElement('style');
  css.id = 'td-floating-style';
  css.textContent = `
#td-floating-root{position:fixed;z-index:2147483640;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;font-size:12px;line-height:1.5;color:#e0e0e0}
#td-fab{position:fixed;left:20px;top:20px;z-index:2147483641;width:52px;height:52px;border-radius:50%;background:rgba(22,33,62,.9);color:#fff;border:3px solid #e94560;cursor:pointer;font-size:16px;box-shadow:0 0 0 3px rgba(255,255,255,.25),0 0 24px rgba(233,69,96,.7),0 0 48px rgba(233,69,96,.3);transition:.2s;display:flex;align-items:center;justify-content:center;padding:0;overflow:hidden;animation:td-fab-pulse 3s ease-in-out infinite}
#td-fab img{width:100%;height:100%;object-fit:cover;border-radius:50%}
#td-fab{cursor:grab}#td-fab:hover{transform:scale(1.12);border-color:#ff6b81;box-shadow:0 0 0 4px rgba(255,255,255,.4),0 0 32px rgba(233,69,96,.85),0 0 56px rgba(233,69,96,.45)}
@keyframes td-fab-pulse{0%,100%{box-shadow:0 0 0 3px rgba(255,255,255,.25),0 0 24px rgba(233,69,96,.7),0 0 48px rgba(233,69,96,.3)}50%{box-shadow:0 0 0 5px rgba(255,255,255,.45),0 0 36px rgba(233,69,96,.9),0 0 60px rgba(233,69,96,.5)}}
#td-fab.hidden{display:none}
#td-panel{position:fixed;left:16px;top:72px;z-index:2147483640;width:380px;max-height:82vh;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden;display:flex;flex-direction:column;transition:.2s;resize:both;min-width:320px}
#td-panel.collapsed{max-height:40px;resize:none}
#td-header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#16213e;cursor:grab;user-select:none;flex-shrink:0}
#td-header:active{cursor:grabbing}
#td-header .td-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;transition:.2s}
#td-header .td-dot.on{background:#4caf50;box-shadow:0 0 6px #4caf50}
#td-header .td-dot.off{background:#f44336}
#td-header .td-dot.thinking{background:#ff9800;animation:td-pulse 1s infinite}
@keyframes td-pulse{0%,100%{opacity:1}50%{opacity:.3}}
#td-header .td-title{flex:1;font-weight:700;font-size:13px;color:#e94560;white-space:nowrap}
#td-header .td-summary{font-size:10px;color:#5a5a78}
#td-header .td-btn{background:none;border:none;color:#9090a8;cursor:pointer;font-size:14px;padding:2px 4px;line-height:1}
#td-header .td-btn:hover{color:#e0e0e0}
#td-tabs{display:flex;border-bottom:1px solid #2a2a4a;flex-shrink:0}
#td-tabs .td-tab{flex:1;padding:8px 4px;text-align:center;font-size:10px;color:#6a6a88;cursor:pointer;border-bottom:2px solid transparent;transition:.15s;background:none;border-top:none;border-left:none;border-right:1px solid #2a2a4a}
#td-tabs .td-tab:last-child{border-right:none}
#td-tabs .td-tab.active{color:#e0e0e0;border-bottom-color:#e94560}
#td-tabs .td-tab:hover{color:#e0e0e0}
#td-body{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;max-height:60vh}
#td-body.collapsed{display:none}
.td-section{border-bottom:1px solid #2a2a4a;padding-bottom:8px;margin-bottom:2px}
.td-section:last-child{border-bottom:none;padding-bottom:0}
.td-section-title{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#5a5a78;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
.td-section-count{font-size:9px;color:#5a5a78;background:#0f0f1a;padding:1px 6px;border-radius:8px}

/* 角色卡片 */
.td-char-card{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:4px;margin-bottom:2px;transition:.15s;border:1px solid transparent}
.td-char-card:hover{background:rgba(83,168,182,.08)}
.td-char-card.sel{border-color:#53a8b6;background:rgba(83,168,182,.12)}
.td-char-card.disabled{opacity:.45}
.td-char-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.td-char-dot.sel{background:#53a8b6}
.td-char-dot.skip{background:#5a5a78}
.td-char-name{flex:1;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.td-char-status{font-size:9px;padding:1px 5px;border-radius:6px;flex-shrink:0}
.td-char-status.on{color:#4caf50;background:rgba(76,175,80,.15)}
.td-char-status.off{color:#f44336;background:rgba(244,67,54,.1)}
.td-char-badge{font-size:8px;padding:1px 5px;border-radius:6px;background:#53a8b6;color:#fff;flex-shrink:0}

/* 操作按钮 */
.td-actions{display:flex;flex-wrap:wrap;gap:5px}
.td-act{flex:1;min-width:65px;padding:6px 8px;border:1px solid #2a2a4a;border-radius:6px;background:#16213e;color:#e0e0e0;cursor:pointer;font-size:10px;text-align:center;transition:.15s;white-space:nowrap;font-family:inherit}
.td-act:hover{border-color:#e94560;background:#1f2b47}
.td-act.primary{background:#e94560;border-color:#e94560;color:#fff;font-weight:600}
.td-act.primary:hover{background:#d63850}
.td-act.danger{border-color:#f44336;color:#f44336}
.td-act.danger:hover{background:rgba(244,67,54,.15)}

/* 日志 */
.td-log-item{padding:4px 0;font-size:10px;border-bottom:1px solid rgba(42,42,74,.5)}
.td-log-item:last-child{border-bottom:none}
.td-log-reason{color:#9090a8;margin-top:2px}
.td-log-roles{color:#53a8b6;font-weight:500}
.td-log-skipped{font-size:9px;color:#5a5a78}
.td-empty{color:#5a5a78;text-align:center;padding:12px 0;font-style:italic;font-size:11px}

/* 消息气泡 */
.td-msg-item{padding:5px 0;border-bottom:1px solid rgba(42,42,74,.4);font-size:10px}
.td-msg-item:last-child{border-bottom:none}
.td-msg-speaker{font-weight:600;color:#53a8b6;margin-bottom:1px}
.td-msg-speaker.user{color:#e94560}
.td-msg-speaker.system{color:#f0c060}
.td-msg-content{color:#c0c0d0;line-height:1.4}
.td-msg-truncated{cursor:pointer;color:#9090a8}
.td-msg-truncated:hover{text-decoration:underline;text-decoration-color:#53a8b6}
.td-msg-teaser{color:#53a8b6;font-weight:bold}

/* 世界书条目 */
.td-wb-item{padding:4px 0;border-bottom:1px solid rgba(42,42,74,.4);font-size:10px}
.td-wb-item:last-child{border-bottom:none}
.td-wb-title{font-weight:600;display:flex;gap:4px;align-items:center}
.td-wb-hit{font-size:9px;padding:1px 5px;border-radius:4px}
.td-wb-hit.yes{background:rgba(76,175,80,.2);color:#4caf50}
.td-wb-hit.no{color:#5a5a78}
.td-wb-keys{color:#53a8b6;font-size:9px;margin-top:1px}

/* 破限预览 */
.td-jb-text{background:#0f0f1a;padding:8px;border-radius:4px;font-size:10px;max-height:100px;overflow-y:auto;white-space:pre-wrap;color:#9090a8;font-family:monospace}
.td-jb-truncated{cursor:pointer}
.td-jb-truncated:hover{color:#53a8b6}

/* 横幅 */
.td-banner{padding:6px 8px;border-radius:4px;font-size:10px;margin-bottom:4px}
.td-banner.warn{background:rgba(255,152,0,.15);color:#ff9800}
.td-banner.err{background:rgba(244,67,54,.15);color:#f44336}
.td-banner.ok{background:rgba(76,175,80,.15);color:#4caf50}

/* 表单 */
.td-field{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
.td-field label{font-size:10px;color:#9090a8;font-weight:500}
.td-field input,.td-field select,.td-field textarea{width:100%;box-sizing:border-box;padding:6px 8px;background:#0f0f1a;border:1px solid #2a2a4a;border-radius:4px;color:#e0e0e0;font-size:11px;font-family:inherit;outline:none}
.td-field input:focus,.td-field select:focus,.td-field textarea:focus{border-color:#e94560}
.td-field textarea{resize:vertical;min-height:55px}
.td-field-row{display:flex;gap:6px}
.td-field-row .td-field{flex:1}
.td-help{font-size:9px;color:#5a5a78;margin-top:2px}
.td-bind-row{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:10px}
.td-bind-row select{flex:1;padding:4px;background:#0f0f1a;border:1px solid #2a2a4a;border-radius:3px;color:#e0e0e0;font-size:10px}
.td-bind-row button{padding:2px 8px;border-radius:3px;background:#2a2a4a;color:#e0e0e0;border:none;cursor:pointer;font-size:10px}
.td-bind-row button:hover{background:#e94560}
.td-bind-row button.del:hover{background:#f44336}

/* KV行 */
.td-kv{display:flex;justify-content:space-between;padding:2px 0;font-size:10px}
.td-kv .td-kv-key{color:#5a5a78}
.td-kv .td-kv-val{color:#e0e0e0;font-weight:500}

/* 响应式 */
@media (max-width: 480px) {
  #td-fab{left:12px;top:12px;width:60px;height:60px;border-radius:50%}
  #td-panel{left:4px;top:64px;width:calc(100vw - 8px);max-height:62vh;border-radius:8px;font-size:13px;resize:none;min-width:auto}
  #td-panel.collapsed{max-height:44px}
  #td-header{padding:12px;font-size:14px}
  .td-act{padding:8px 10px;font-size:11px;min-width:55px}
  .td-tab{font-size:11px;padding:10px}
  #td-body{padding:8px 10px;max-height:50vh}
  .td-field input,.td-field select,.td-field textarea{font-size:13px;padding:8px}
}
`.trim();
  document.head.appendChild(css);
  console.log('[TavernDirector] CSS 已注入');

  // ═══════════════════════════════════════════════════
  // Loading indicator
  // ═══════════════════════════════════════════════════
  const $indicator = document.createElement('div');
  $indicator.id = 'td-load-indicator';
  $indicator.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483642;'
    + 'background:linear-gradient(135deg,#1a1a2e,#0f3460);color:#e0e0e0;text-align:center;'
    + 'padding:5px 8px;font-size:12px;font-weight:500;font-family:sans-serif;'
    + 'border-bottom:1px solid rgba(233,69,96,.25);'
    + 'transition:opacity .4s ease,transform .4s ease;will-change:opacity,transform;';
  $indicator.innerHTML = '🎬 <b>导演台已加载</b> — 点击右下角头像按钮打开控制台';
  document.body.appendChild($indicator);
  setTimeout(() => {
    $indicator.style.opacity = '0';
    $indicator.style.transform = 'translateY(-100%)';
    setTimeout(() => { try { $indicator.remove(); } catch {} }, 500);
  }, 5000);

  // ═══════════════════════════════════════════════════
  // Inject HTML
  // ═══════════════════════════════════════════════════
  const root = document.createElement('div');
  root.id = 'td-floating-root';
  root.innerHTML = `
<button id="td-fab" title="酒馆导演台"><img src="${FAB_IMG}" alt="导演" width="48" height="48" style="width:100%;height:100%;object-fit:cover;border-radius:50%" /></button>
<div id="td-panel">
  <div id="td-header">
    <span class="td-dot off" id="td-dot" title="连接状态"></span>
    <span class="td-title">🎬 导演台</span>
    <span class="td-summary" id="td-summary">未连接</span>
    <button class="td-btn" id="td-btn-min" title="折叠">−</button>
    <button class="td-btn" id="td-btn-close" title="关闭">✕</button>
  </div>
  <div id="td-tabs">
    <button class="td-tab active" data-tab="console">🎯 控制台</button>
    <button class="td-tab" data-tab="data">📊 数据</button>
    <button class="td-tab" data-tab="settings">⚙️ 配置</button>
  </div>
  <div id="td-body"></div>
  <div id="td-banner-area"></div>
</div>`.trim();
  document.body.appendChild(root);
  console.log('[TavernDirector] DOM 已注入');

  // ═══════════════════════════════════════════════════
  // DOM refs
  // ═══════════════════════════════════════════════════
  const $fab = document.getElementById('td-fab');
  const $panel = document.getElementById('td-panel');
  const $body = document.getElementById('td-body');
  const $dot = document.getElementById('td-dot');
  const $summary = document.getElementById('td-summary');
  const $btnMin = document.getElementById('td-btn-min');
  const $banner = document.getElementById('td-banner-area');
  const $tabs = document.querySelectorAll('#td-tabs .td-tab');

  // ═══════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════


  const S = {
    connected: false, directorStatus: 'idle', collapsed: false,
    currentTab: 'console',
    worldBooks: [], jailbreak: { text: '', source: 'none', enabled: false, name: '' },
    messages: [], characters: [], logs: [],
  };

  // ═══════════════════════════════════════════════════
  // localStorage persistence
  // ═══════════════════════════════════════════════════
  function savePrefs() {
    try {
      localStorage.setItem('td-panel-tab', S.currentTab);
      localStorage.setItem('td-panel-collapsed', String(S.collapsed));
    } catch { /* quota exceeded */ }
  }
  function loadPrefs() {
    try {
      var tab = localStorage.getItem('td-panel-tab');
      if (tab === 'console' || tab === 'data' || tab === 'settings') S.currentTab = tab;
      var collapsed = localStorage.getItem('td-panel-collapsed');
      if (collapsed === 'true') { S.collapsed = true; }
    } catch (e) { /* ignore */ }
  }
  loadPrefs();

  // ═══════════════════════════════════════════════════
  // Panel: collapse / expand / show / hide
  // ═══════════════════════════════════════════════════
  function collapse() { S.collapsed = true; $panel.classList.add('collapsed'); $body.classList.add('collapsed'); $btnMin.textContent = '+'; savePrefs(); }
  function expand() { S.collapsed = false; $panel.classList.remove('collapsed'); $body.classList.remove('collapsed'); $btnMin.textContent = '−'; render(); }
  $btnMin.addEventListener('click', () => S.collapsed ? expand() : collapse());

  function hidePanel() { $panel.style.display = 'none'; $fab.classList.remove('hidden'); }
  function showPanel() {
    try {
      $panel.style.left = Math.min($fab.offsetLeft, window.innerWidth - 400) + 'px';
      $panel.style.top = Math.min($fab.offsetTop + 60, window.innerHeight - 300) + 'px';
      $panel.style.display = 'flex';
      $fab.classList.add('hidden');
      expand();
      syncData();
    } catch (e) {
      console.warn('[TavernDirector] 面板展开失败，回退到FAB模式', e);
      $fab.classList.remove('hidden');
    }
  }

  function loadFabPos() {
    try {
      var saved = localStorage.getItem('td-fab-pos');
      if (saved) {
        var pos = JSON.parse(saved);
        if (typeof pos.left === 'number' && typeof pos.top === 'number') {
          $fab.style.left = pos.left + 'px';
          $fab.style.top = pos.top + 'px';
        }
      }
    } catch (e) { /* ignore */ }
  }
  function saveFabPos() {
    try {
      localStorage.setItem('td-fab-pos', JSON.stringify({
        left: $fab.offsetLeft,
        top: $fab.offsetTop,
      }));
    } catch (e) { /* ignore */ }
  }
  loadFabPos();

  // FAB drag
  var fabDragging = false, fabStartX = 0, fabStartY = 0, fabOrigLeft = 0, fabOrigTop = 0;
  function fabDragStart(e) {
    if (e.button !== undefined && e.button !== 0) return;
    fabDragging = true;
    var p = 'touches' in e ? e.touches[0] : e;
    fabStartX = p.clientX;
    fabStartY = p.clientY;
    fabOrigLeft = $fab.offsetLeft;
    fabOrigTop = $fab.offsetTop;
    $fab.style.cursor = 'grabbing';
    $fab.style.transition = 'none';
    e.preventDefault();
  }
  function fabDragMove(e) {
    if (!fabDragging) return;
    var p = 'touches' in e ? e.touches[0] : e;
    var dx = p.clientX - fabStartX;
    var dy = p.clientY - fabStartY;
    $fab.style.left = Math.max(0, Math.min(window.innerWidth - 52, fabOrigLeft + dx)) + 'px';
    $fab.style.top = Math.max(0, Math.min(window.innerHeight - 52, fabOrigTop + dy)) + 'px';
  }
  function fabDragEnd() {
    if (!fabDragging) return;
    fabDragging = false;
    $fab.style.cursor = 'pointer';
    $fab.style.transition = '.2s';
    fabMoved = true;
    saveFabPos();
  }
  var fabMoved = false;
  $fab.addEventListener('click', function(e) {
    if (fabMoved) { fabMoved = false; return; }
    showPanel();
  });
  $fab.addEventListener('mousedown', fabDragStart);
  $fab.addEventListener('touchstart', fabDragStart, { passive: false });
  document.addEventListener('mousemove', fabDragMove);
  document.addEventListener('touchmove', fabDragMove, { passive: false });
  document.addEventListener('mouseup', fabDragEnd);
  document.addEventListener('touchend', fabDragEnd);

  // ── Draggable header (mouse + touch) ──────────
  let dragging = false, offX = 0, offY = 0;
  const headerEl = document.getElementById('td-header');

  function dragStart(e) {
    if ((e.target).tagName === 'BUTTON') return;
    dragging = true;
    const r = $panel.getBoundingClientRect();
    const p = 'touches' in e ? e.touches[0] : e;
    offX = p.clientX - r.left;
    offY = p.clientY - r.top;
    $panel.style.transition = 'none';
  }
  function dragMove(e) {
    if (!dragging) return;
    const p = 'touches' in e ? e.touches[0] : e;
    $panel.style.right = 'auto'; $panel.style.bottom = 'auto';
    $panel.style.left = (p.clientX - offX) + 'px';
    $panel.style.top = (p.clientY - offY) + 'px';
  }
  function dragEnd() {
    if (dragging) { dragging = false; $panel.style.transition = '.2s'; }
  }

  headerEl.addEventListener('mousedown', dragStart);
  headerEl.addEventListener('touchstart', dragStart, { passive: false });
  document.addEventListener('mousemove', dragMove);
  document.addEventListener('touchmove', dragMove, { passive: false });
  document.addEventListener('mouseup', dragEnd);
  document.addEventListener('touchend', dragEnd);

  // ── Tab switching ─────────────────────────────
  $tabs.forEach(t => t.addEventListener('click', () => {
    S.currentTab = (t).dataset.tab;
    $tabs.forEach(tt => tt.classList.remove('active'));
    t.classList.add('active');
    savePrefs();
    render();
  }));

  // ── Apply saved tab preference ────────────────
  $tabs.forEach(t => {
    if ((t).dataset.tab === S.currentTab) {
      $tabs.forEach(tt => tt.classList.remove('active'));
      t.classList.add('active');
    }
  });

  // ═══════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════
  function render() {
    if (S.collapsed) return;
    if (S.currentTab === 'console') renderConsole();
    else if (S.currentTab === 'data') renderData();
    else renderSettings();
  }

  // ─── Tab 1: Console ────────────────────────────
  function renderConsole() {
    const charsHTML = !S.characters.length
      ? '<div class="td-empty">等待数据...</div>'
      : S.characters.map(c =>
          `<div class="td-char-card ${c.isSelected ? 'sel' : ''} ${c.status === 'disabled' ? 'disabled' : ''}" title="${c.status === 'enabled' ? '已启用' : '已禁用'}${c.isNarrator ? ' · 旁白' : ''}${c.model ? ' · ' + esc(c.model) : ''}">
            <span class="td-char-dot ${c.isSelected ? 'sel' : c.status === 'disabled' ? 'skip' : ''}"></span>
            <span class="td-char-name">${esc(c.name)}</span>
            ${c.isNarrator ? '<span class="td-char-badge">旁白</span>' : ''}
            ${c.isSelected ? '<span class="td-char-badge" style="background:#e94560">选中</span>' : ''}
            <span class="td-char-status ${c.status === 'enabled' ? 'on' : 'off'}">${c.status === 'enabled' ? '启用' : '禁用'}</span>
          </div>`
        ).join('');

    const logsHTML = !S.logs.length
      ? '<div class="td-empty">尚未执行调度</div>'
      : S.logs.slice(0, 5).map(l => {
          const names = l.orderedRoles.length
            ? l.orderedRoles.map(id => { const c = S.characters.find(cc => cc.id === id); return c ? c.name : id; }).join(' → ')
            : l.selectedRoles.map(id => { const c = S.characters.find(cc => cc.id === id); return c ? c.name : id; }).join('、') || '无';
          const skipped = l.skippedRoles?.length
            ? `<div class="td-log-skipped">⏭ ${l.skippedRoles.map(id => { const c = S.characters.find(cc => cc.id === id); return c ? c.name : id; }).join('、')}</div>`
            : '';
          return `<div class="td-log-item">
            <span style="color:#5a5a78">${new Date(l.timestamp).toLocaleTimeString()} · ${esc(l.mode || 'seq')}</span>
            <span class="td-log-roles">${esc(names)}</span>
            ${skipped}
            <div class="td-log-reason">${esc(l.reason)}</div>
          </div>`;
        }).join('');

    const statusLabel = S.directorStatus === 'idle' ? '待命' :
      S.directorStatus === 'thinking' ? '思考中...' :
      S.directorStatus === 'running' ? '执行中...' :
      S.directorStatus === 'done' ? '已完成' : '错误';

    $body.innerHTML = `
      <div class="td-section">
        <div class="td-section-title">👥 角色 <span class="td-section-count">${S.characters.length}</span></div>
        ${charsHTML}
      </div>
      <div class="td-section">
        <div class="td-section-title">🎯 操作 · <span style="font-weight:400;color:#5a5a78">${statusLabel}</span></div>
        <div class="td-actions">
          <button class="td-act primary" id="td-act-run">🎯 导演决定</button>
          <button class="td-act" id="td-act-speakers">👤 指定发言</button>
        </div>
        <div class="td-actions" style="margin-top:5px">
          <button class="td-act" id="td-act-all">📢 全员旁白</button>
          <button class="td-act" id="td-act-rr">🔄 全员轮流</button>
        </div>
        <div class="td-actions" style="margin-top:5px">
          <button class="td-act" id="td-act-fullauto">⚡ 全自动</button>
          <button class="td-act danger" id="td-act-clear">🗑 清空日志</button>
        </div>
      </div>
      <div class="td-section">
        <div class="td-section-title">📋 最近调度 <span class="td-section-count">${S.logs.length}</span></div>
        ${logsHTML}
      </div>`;

    document.getElementById('td-act-run')?.addEventListener('click', () => doDirector({}));
    document.getElementById('td-act-speakers')?.addEventListener('click', () => doSelectSpeakers());
    document.getElementById('td-act-all')?.addEventListener('click', () => doAllSpeak('parallel'));
    document.getElementById('td-act-rr')?.addEventListener('click', () => doAllSpeak('sequential'));
    document.getElementById('td-act-fullauto')?.addEventListener('click', () => doFullAuto());
    document.getElementById('td-act-clear')?.addEventListener('click', () => {
      if (confirm('确定清空所有导演日志？此操作不可撤销。')) {
        S.logs = [];
        renderConsole();
        showBanner('日志已清空', 'ok');
      }
    });
  }

  // ─── Tab 2: Data (chat + worldbook + jailbreak) ─
  function renderData() {
    // Chat messages (recent 15)
    const msgs = S.messages.slice(-15);
    const msgsHTML = !msgs.length
      ? '<div class="td-empty">暂无消息</div>'
      : msgs.map(m => {
          const content = esc(m.content);
          const truncated = content.length > 150
            ? `<span class="td-msg-truncated" onclick="var f=this.nextElementSibling;var t=this;if(f.style.display==='none'){f.style.display='inline';t.style.display='none'}else{f.style.display='none';t.style.display='inline'}">${content.substring(0,150)}<span class="td-msg-teaser"> …展开</span></span><span style="display:none">${content}</span>`
            : content;
          return `<div class="td-msg-item">
            <div class="td-msg-speaker ${m.role}">${esc(m.speaker || m.role)} ${m.isDirectorDecision ? '🎬' : ''}</div>
            <div class="td-msg-content">${truncated}</div>
          </div>`;
        }).join('');

    // Worldbook entries (top 8, with hit status)
    const wbsHTML = !S.worldBooks.length
      ? '<div class="td-empty">无世界书条目</div>'
      : S.worldBooks.slice(0, 8).map(w =>
          `<div class="td-wb-item">
            <div class="td-wb-title">
              ${esc(w.title || '未命名')}
              ${w.hit ? '<span class="td-wb-hit yes">✓ 命中</span>' : '<span class="td-wb-hit no">—</span>'}
              ${!w.enabled ? '<span style="color:#f44336;font-size:9px">禁用</span>' : ''}
            </div>
            <div class="td-wb-keys">${w.keys.slice(0,3).map(esc).join(', ') || '无触发词'}</div>
            ${w.hit && w.hitReason ? `<div style="font-size:9px;color:#4caf50">${esc(w.hitReason)}</div>` : ''}
          </div>`
        ).join('');

    // Jailbreak preview (expandable)
    const jb = S.jailbreak;
    const jbHTML = jb.text
      ? `<div class="td-jb-text">${jb.text.length > 200
          ? `<span class="td-jb-truncated" onclick="var f=this.nextElementSibling;var t=this;if(f.style.display==='none'){f.style.display='inline';t.style.display='none'}else{f.style.display='none';t.style.display='inline'}">${esc(jb.text.substring(0,200))}…<span style="color:#53a8b6;font-weight:bold">展开</span></span><span style="display:none">${esc(jb.text)}</span>`
          : esc(jb.text)}</div>`
      : '<div class="td-empty">未加载破限</div>';

    $body.innerHTML = `
      <div class="td-section">
        <div class="td-section-title">💬 最近消息 <span class="td-section-count">${S.messages.length}</span></div>
        ${msgsHTML}
      </div>
      <div class="td-section">
        <div class="td-section-title">📖 世界书 <span class="td-section-count">${S.worldBooks.length}</span></div>
        ${wbsHTML}
      </div>
      <div class="td-section">
        <div class="td-section-title">🔓 破限 ${jb.enabled ? '✅' : '⛔'} <span class="td-section-count">${jb.source}</span></div>
        ${jbHTML}
        ${jb.name ? `<div class="td-kv"><span class="td-kv-key">名称</span><span class="td-kv-val">${esc(jb.name)}</span></div>` : ''}
      </div>
      <div class="td-section">
        <div class="td-section-title">📋 会话统计</div>
        <div class="td-kv"><span class="td-kv-key">角色</span><span class="td-kv-val">${S.characters.length} 位</span></div>
        <div class="td-kv"><span class="td-kv-key">消息</span><span class="td-kv-val">${S.messages.length} 条</span></div>
        <div class="td-kv"><span class="td-kv-key">世界书</span><span class="td-kv-val">${S.worldBooks.length} 条</span></div>
        <div class="td-kv"><span class="td-kv-key">调度记录</span><span class="td-kv-val">${S.logs.length} 次</span></div>
      </div>`;
  }

  // ─── Tab 3: Settings ──────────────────────────
  function renderSettings() {
    const TD = (window).TavernDirector || {};
    const raw = TD.settings?.getRaw ? TD.settings.getRaw() : {};

    const getModels = () => {
      try { return raw.fallbackModels?.join(', ') || ''; } catch { return ''; }
    };

    let charOpts = '';
    try {
      const snap = TD.getSnapshot?.() || {};
      (snap.characters || []).forEach((c) => {
        const mid = raw.roleModels?.[c.id] || '';
        charOpts += `<div class="td-bind-row">
          <span style="width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px">${esc(c.displayName || c.name)}</span>
          <input type="text" class="td-bind-model" data-role-id="${esc(c.id)}" value="${esc(mid)}" placeholder="模型名" style="flex:1;padding:3px 6px;background:#0f0f1a;border:1px solid #2a2a4a;border-radius:3px;color:#e0e0e0;font-size:10px">
        </div>`;
      });
    } catch { charOpts = '<div class="td-empty">无角色数据</div>'; }

    $body.innerHTML = `
      <div class="td-section">
        <div class="td-section-title">🔧 模型配置</div>
        <div class="td-field">
          <label>默认模型</label>
          <input type="text" id="td-cfg-defaultModel" value="${esc(raw.defaultModel || '')}" placeholder="e.g. openai/gpt-4o">
          <span class="td-help">全局兜底模型，角色无专属模型时使用</span>
        </div>
        <div class="td-field">
          <label>导演模型 ${raw.directorModel ? '✅' : '⚠️'}</label>
          <input type="text" id="td-cfg-directorModel" value="${esc(raw.directorModel || '')}" placeholder="e.g. anthropic/claude-opus-4-8">
          <span class="td-help">导演评分/选角/上下文使用此模型</span>
        </div>
        <div class="td-field">
          <label>降级模型链（逗号分隔）</label>
          <input type="text" id="td-cfg-fallbackModels" value="${esc(getModels())}" placeholder="model-a, model-b, model-c">
          <span class="td-help">主模型失败时按此顺序尝试降级</span>
        </div>
        <div class="td-field">
          <label>角色→模型绑定</label>
          ${charOpts}
          <span class="td-help">每行一个角色。修改后自动保存</span>
        </div>
      </div>
      <div class="td-section">
        <div class="td-section-title">📝 破限文本</div>
        <div class="td-field">
          <textarea id="td-cfg-jailbreak" placeholder="在此粘贴自定义破限/系统提示...">${esc(raw.jailbreakText || '')}</textarea>
          <span class="td-help">留空则使用角色卡内置破限</span>
        </div>
      </div>
      <div class="td-section">
        <div class="td-section-title">🔗 世界书绑定</div>
        <div class="td-help" style="margin-bottom:4px">格式：entryId:roleId,roleId。每行一个绑定</div>
        <textarea id="td-cfg-wb-text" style="width:100%;min-height:50px;margin-top:4px;background:#0f0f1a;border:1px solid #2a2a4a;color:#e0e0e0;font-size:10px;border-radius:4px;padding:4px" placeholder="wb_entry_01:char_001,char_002&#10;wb_entry_02:char_001"></textarea>
      </div>
      <div class="td-section">
        <div class="td-section-title">💾 数据管理</div>
        <div class="td-actions">
          <button class="td-act" id="td-cfg-export">📥 导出</button>
          <button class="td-act" id="td-cfg-import">📤 导入</button>
          <button class="td-act" id="td-cfg-reset" style="border-color:#f44336;color:#f44336">⚠️ 重置</button>
        </div>
        <div class="td-actions" style="margin-top:5px">
          <button class="td-act primary" id="td-cfg-save">💾 保存配置</button>
        </div>
      </div>`;

    try {
      const binds = raw.worldbookBindings || {};
      const lines = Object.entries(binds).map(([k, v]) => `${k}:${v.join(',')}`);
      (document.getElementById('td-cfg-wb-text')).value = lines.join('\n');
    } catch { /* ignore */ }

    document.getElementById('td-cfg-save')?.addEventListener('click', () => saveAllSettings());
    document.getElementById('td-cfg-export')?.addEventListener('click', () => {
      const json = TD.exportConfig?.() || '{}';
      navigator.clipboard?.writeText(json).then(() => showBanner('配置已复制到剪贴板', 'ok')).catch(() => {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'tavern-director-config.json'; a.click();
        URL.revokeObjectURL(url);
        showBanner('配置已下载', 'ok');
      });
    });
    document.getElementById('td-cfg-import')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const text = await file.text();
        const result = TD.importConfig?.(text) || { success: false, message: 'importConfig 不可用' };
        showBanner(result.message, result.success ? 'ok' : 'err');
        if (result.success) setTimeout(render, 300);
      };
      input.click();
    });
    document.getElementById('td-cfg-reset')?.addEventListener('click', () => {
      if (confirm('确定要重置所有配置？此操作不可撤销。')) {
        TD.resetConfig?.();
        showBanner('配置已重置为默认值', 'ok');
        setTimeout(render, 300);
      }
    });

    document.querySelectorAll('.td-bind-model').forEach(inp => {
      inp.addEventListener('change', () => {
        const roleId = (inp).dataset.roleId || '';
        const modelId = (inp).value.trim();
        if (roleId) TD.setRoleModel?.(roleId, modelId);
      });
    });
  }

  function saveAllSettings() {
    const TD = (window).TavernDirector || {};
    const defaultModel = (document.getElementById('td-cfg-defaultModel'))?.value?.trim() || '';
    const directorModel = (document.getElementById('td-cfg-directorModel'))?.value?.trim() || '';
    const fallbackRaw = (document.getElementById('td-cfg-fallbackModels'))?.value || '';
    const fallbackModels = fallbackRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const jailbreak = (document.getElementById('td-cfg-jailbreak'))?.value || '';
    const wbRaw = (document.getElementById('td-cfg-wb-text'))?.value || '';

    TD.setDefaultModel?.(defaultModel);
    TD.setDirectorModel?.(directorModel);
    TD.setFallbackModels?.(fallbackModels);
    TD.setJailbreak?.(jailbreak);

    const binds = {};
    wbRaw.split('\n').forEach((line) => {
      const [entryId, rolesStr] = line.split(':').map(s => s.trim());
      if (entryId && rolesStr) binds[entryId] = rolesStr.split(',').map(s => s.trim()).filter(Boolean);
    });
    if (TD.settings?.setWorldbookBindings) TD.settings.setWorldbookBindings(binds);

    document.querySelectorAll('.td-bind-model').forEach(inp => {
      const roleId = (inp).dataset.roleId || '';
      const modelId = (inp).value.trim();
      if (roleId && modelId) TD.setRoleModel?.(roleId, modelId);
    });

    showBanner('配置已保存 ✅', 'ok');
  }

  // ═══════════════════════════════════════════════════
  // Actions
  // ═══════════════════════════════════════════════════
  function getTD() { return (window).TavernDirector || {}; }

  function syncData() {
    const TD = getTD();
    try {
      const snap = TD.getSnapshot?.() || {};
      if (!snap || !snap.characters) { S.connected = false; return; }
      S.connected = true;

      // Characters with more detail
      S.characters = (snap.characters || []).map((c) => ({
        id: c.id || c.name || '',
        name: c.displayName || c.name || '',
        status: c.status || 'enabled',
        isNarrator: !!c.isNarrator,
        isSelected: false,
        model: c.model || '',
        avatar: c.avatar || '',
      }));

      // Messages (last 50 for data tab)
      S.messages = (snap.messages || []).slice(-50).map((m, i) => ({
        id: m.id || `m_${i}`,
        role: m.role || 'system',
        speaker: m.speaker || '',
        content: m.content || '',
        turnIndex: m.turnIndex != null ? m.turnIndex : i,
        isDirectorDecision: !!m.isDirectorDecision,
      }));

      // Worldbooks with more detail
      var oldWbMap = {};
      S.worldBooks.forEach(function(w) { oldWbMap[w.id] = { hit: w.hit, hitReason: w.hitReason }; });
      S.worldBooks = (snap.worldBooks || []).map((w) => ({
        id: w.id || '', title: w.title || '',
        keys: w.keys || [], content: w.content || '',
        enabled: w.enabled !== false,
        hit: oldWbMap[w.id] ? oldWbMap[w.id].hit : false,
        hitReason: oldWbMap[w.id] ? oldWbMap[w.id].hitReason : '',
      }));

      // Jailbreak
      const jb = snap.jailbreak || {};
      S.jailbreak = {
        text: jb.text || '', source: jb.source || 'none',
        enabled: !!jb.enabled, name: jb.name || '',
      };

      $dot.className = 'td-dot on';
      $dot.title = '已连接';
      $summary.textContent = S.characters.length + '角色 · ' + S.messages.length + '消息';
    } catch {
      S.connected = false;
      $dot.className = 'td-dot off';
      $dot.title = '未连接';
      $summary.textContent = '未连接';
    }
  }

  function doDirector(opts) {
    S.directorStatus = 'thinking';
    $dot.className = 'td-dot thinking';
    $dot.title = '思考中...';
    render();
    const TD = getTD();
    try {
      const plan = TD.autoPlan?.(opts);
      if (plan?.decision) {
        const sel = new Set(plan.decision.selectedRoleIds || []);
        S.characters.forEach(c => { c.isSelected = sel.has(c.id); });

        // Mark worldbook hits
        const wbSet = new Set(plan.decision.selectedWorldBookIds || []);
        S.worldBooks.forEach(w => {
          w.hit = wbSet.has(w.id);
          w.hitReason = wbSet.has(w.id) ? '导演选中' : '';
        });

        S.logs.unshift({
          timestamp: Date.now(),
          selectedRoles: plan.decision.selectedRoleIds || [],
          orderedRoles: plan.decision.orderedRoleIds || [],
          skippedRoles: plan.decision.skippedRoleIds || [],
          reason: plan.decision.reason || '',
          mode: plan.config?.mode || 'sequential',
        });
        if (S.logs.length > 50) S.logs.length = 50;
        S.directorStatus = 'done';
        $dot.className = 'td-dot on';
        $dot.title = '已完成';
      } else {
        showBanner('调度返回空结果', 'err');
        S.directorStatus = 'idle';
        $dot.className = 'td-dot on';
        $dot.title = '待命';
      }
    } catch (e) {
      showBanner('调度失败: ' + String(e), 'err');
      S.directorStatus = 'error';
      $dot.className = 'td-dot off';
      $dot.title = '错误';
    }
    render();
    setTimeout(() => {
      S.directorStatus = 'idle';
      $dot.className = 'td-dot on';
      $dot.title = '待命';
    }, 2000);
  }

  async function doSelectSpeakers() {
    const TD = getTD();
    syncData();
    const result = await TD.selectSpeakers({ title: '选择谁来说话', multi: true, maxSelect: 8 });
    if (!result?.confirmed || !result.selectedIds.length) return;
    const sel = new Set(result.selectedIds);
    S.characters.forEach(c => { c.isSelected = sel.has(c.id); });
    render();
    doDirector({ manualSpeakerIds: result.selectedIds, maxRoles: result.selectedIds.length });
  }

  function doAllSpeak(mode) {
    const enabled = S.characters.filter(c => c.status !== 'disabled');
    if (!enabled.length) { showBanner('没有可用的角色', 'warn'); return; }
    doDirector({
      manualSpeakerIds: enabled.map(c => c.id),
      maxRoles: enabled.length,
      orderStrategy: mode === 'sequential' ? 'round-robin' : undefined,
    });
  }

  async function doFullAuto() {
    const TD = getTD();
    S.directorStatus = 'thinking';
    $dot.className = 'td-dot thinking';
    $dot.title = '执行中...';
    try {
      showBanner('⏳ 全自动执行中...', 'warn');
      const res = await TD.fullAuto?.();
      if (res) {
        const dec = res.plan?.decision || {};
        S.logs.unshift({
          timestamp: Date.now(),
          selectedRoles: dec.selectedRoleIds || [],
          orderedRoles: dec.orderedRoleIds || [],
          skippedRoles: dec.skippedRoleIds || [],
          reason: dec.reason || '全自动执行完成',
          mode: 'auto',
        });
        if (S.logs.length > 50) S.logs.length = 50;
        S.directorStatus = 'done';
        $dot.className = 'td-dot on';
        $dot.title = '已完成';
        showBanner(`✅ 完成：${res.report?.successCount || 0} 成功，${res.report?.failedCount || 0} 失败`, 'ok');
      }
    } catch (e) {
      showBanner('全自动失败: ' + String(e), 'err');
      S.directorStatus = 'error';
      $dot.className = 'td-dot off';
      $dot.title = '错误';
    }
    syncData();
    render();
    setTimeout(() => {
      S.directorStatus = 'idle';
      $dot.className = 'td-dot on';
      $dot.title = '待命';
    }, 3000);
  }

  // ═══════════════════════════════════════════════════
  // Banner
  // ═══════════════════════════════════════════════════
  let bannerTimer = null;
  function showBanner(msg, type = 'warn') {
    $banner.innerHTML = '<div class="td-banner ' + type + '">' + esc(msg) + '</div>';
    if (bannerTimer) clearTimeout(bannerTimer);
    if (type !== 'err') bannerTimer = setTimeout(() => { $banner.innerHTML = ''; }, 4000);
  }

  // ═══════════════════════════════════════════════════
  // Auto-refresh & startup
  // ═══════════════════════════════════════════════════
  syncData();
  hidePanel();
  
  // ── 清理函数（供 onUnload 调用）──
  function cleanupFloatingPanel() {
    try {
      document.removeEventListener('mousemove', fabDragMove);
      document.removeEventListener('touchmove', fabDragMove);
      document.removeEventListener('mouseup', fabDragEnd);
      document.removeEventListener('touchend', fabDragEnd);
      document.removeEventListener('mousemove', dragMove);
      document.removeEventListener('touchmove', dragMove);
      document.removeEventListener('mouseup', dragEnd);
      document.removeEventListener('touchend', dragEnd);
      if (syncInterval) clearInterval(syncInterval);
      var root = document.getElementById('td-floating-root');
      if (root) root.remove();
      var style = document.getElementById('td-floating-style');
      if (style) style.remove();
      var indicator = document.getElementById('td-load-indicator');
      if (indicator) indicator.remove();
    } catch(e) {}
  }
  window.__tdCleanupFloating = cleanupFloatingPanel;
  console.log('[TavernDirector] 浮动面板注入完成 ✅ (FAB模式 · 3 Tab · 数据预览 · 持久化)');

  // 监听 writer.notifyUI 的执行完成事件
  window.addEventListener('tavern-director:execution-complete', ((e) => {
    const d = e.detail;
    showBanner(`✅ 执行完成：${d.successCount} 成功 / ${d.failedCount} 失败 / ${d.totalTokens} tokens`, d.failedCount > 0 ? 'warn' : 'ok');
    syncData();
    render();
  }));

  // 周期性同步（仅在面板打开时）
  var syncInterval = setInterval(() => {
    if (!S.collapsed && $panel.style.display !== 'none') {
      syncData();
      render();
    }
  }, 3000);
}

// ─── Util ────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


    /**
     * 酒馆导演插件 —— 浏览器端启动入口
     *
     * 装配所有模块并挂载到 window.TavernDirector。
     * 此文件作为 rollup IIFE 构建的入口点。
     *
     * 基于 SillyTavern 真实扩展 API:
     *   const ctx = SillyTavern.getContext();
     *   ctx.chat         → 聊天消息数组
     *   ctx.characters   → 角色对象/数组
     *   ctx.generateRaw({ systemPrompt, prompt, prefill })
     *
     * 配置持久化：
     *   settingsStore (localStorage + 导出/导入 JSON)
     *   启动时自动加载，配置变更自动保存
     */
    // ─── 依赖导入 ──────────────────────────────────────────
    // ═══════════════════════════════════════════════════════
    // 工具函数（跨模块共享）
    // ═══════════════════════════════════════════════════════
    const U = {
        nowId, clamp, uniq,
        norm: normalizeText,
        hasWord: textContainsAny,
        takeLast, join: safeJoin,
        kwScore: keywordHitScore,
        esc(s) {
            return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        },
    };
    // ═══════════════════════════════════════════════════════
    // SillyTavern 全局对象获取（兼容两种挂载名）
    // ═══════════════════════════════════════════════════════
    function getST() {
        return window.SillyTavern || window.ST || null;
    }
    function getSTContext() {
        const st = getST();
        if (!st || typeof st.getContext !== 'function') {
            throw new Error('[TavernDirector] SillyTavern.getContext() 不可用。请确认插件在酒馆环境中正确加载。');
        }
        return st.getContext();
    }
    // ═══════════════════════════════════════════════════════
    // 导演调度层装配
    // ═══════════════════════════════════════════════════════
    const director = new DirectorFacade();
    // ═══════════════════════════════════════════════════════
    // 角色执行层装配（配置从 settingsStore 加载）
    // ═══════════════════════════════════════════════════════
    const engine = new ExecutionEngine(settingsStore.toExecutionConfig());
    // ─── 注册生成回调（对接真实 ST generateRaw） ────────────
    engine.setGenerateCallback(async (prompt, _modelId, _timeoutMs) => {
        const startTime = performance.now();
        const ctx = getSTContext();
        // 使用 SillyTavern 官方 generateRaw API
        // modelId 由 ST 内部当前选中的模型决定，此处不传 modelId
        let result;
        if (typeof ctx.generateRaw === 'function') {
            // generateRaw 接收 { systemPrompt?, prompt, prefill? }
            // prompt 已由 director/promptAssembler 组装好（含 jailbreak 等）
            result = await ctx.generateRaw({ prompt });
        }
        else {
            throw new Error('[TavernDirector] ctx.generateRaw 不可用。请确认酒馆版本支持此 API。');
        }
        // generateRaw 可能返回字符串或 {text, response, ...}
        const text = typeof result === 'string'
            ? result
            : (result?.text || result?.response || '');
        return {
            text,
            tokensUsed: Math.ceil(text.length / 2.5), // 粗略估算
            latencyMs: Math.round(performance.now() - startTime),
        };
    });
    // ─── 注册回写回调（把生成结果写入 ST 聊天流） ──────────
    const writer = createWriter();
    writer.setWriteCallback(async (msg) => {
        const ctx = getSTContext();
        // 构造兼容 SillyTavern 内部格式的消息对象
        const chatMsg = {
            name: msg.speaker,
            is_user: false,
            is_system: msg.isDirectorMessage || msg.role === 'system',
            mes: msg.content,
            send_date: msg.timestamp,
            // 附加元数据，方便调试 / 后续处理
            extra: {
                modelId: msg.modelId,
                tokensUsed: msg.tokensUsed,
                latencyMs: msg.latencyMs,
                tavernDirector: true,
                messageId: msg.id,
            },
        };
        // 写入 context.chat
        if (Array.isArray(ctx.chat)) {
            ctx.chat.push(chatMsg);
        }
        else {
            console.warn('[TavernDirector] ctx.chat 不是数组，无法追加消息。消息内容：', msg.content.slice(0, 100));
        }
        // 触发 ST 的 UI 更新 / 保存机制
        // 尝试顺序：1) ST 原生 eventSource.emit（官方文档确认）
        //           2) DOM CustomEvent（部分版本兼容）
        //           3) DOM Event（旧版兼容）
        try {
            // 优先使用 ST 原生事件系统
            if (typeof ctx.eventSource?.emit === 'function') {
                ctx.eventSource.emit('chatChanged', chatMsg);
                ctx.eventSource.emit('messageAdded', chatMsg);
            }
            // DOM 事件作为补充
            window.dispatchEvent(new CustomEvent('tavern-director:message-added', {
                detail: chatMsg,
            }));
            window.dispatchEvent(new Event('chatChanged'));
        }
        catch {
            /* 静默——事件触发失败不影响消息已写入 chat 数组的事实 */
        }
    });
    // ═══════════════════════════════════════════════════════
    // 配置同步：监听 settingsStore 变更 → 更新 engine
    // ═══════════════════════════════════════════════════════
    const settingsUnsubscribe = settingsStore.subscribe((_s) => {
        engine.getModelRouter().updateConfig(settingsStore.toModelRouteConfig());
    });
    // ═══════════════════════════════════════════════════════
    // Session 增强：将持久化配置注入会话
    // ═══════════════════════════════════════════════════════
    function enrichSession(original) {
        const s = settingsStore.getRaw();
        // 浅拷贝，避免污染适配器缓存的原始 session
        const session = {
            ...original,
            settings: { ...original.settings },
            jailbreak: { ...original.jailbreak },
            characters: original.characters.slice(),
            messages: original.messages.slice(),
            worldBooks: original.worldBooks.map(wb => ({ ...wb })),
            sourceMeta: { ...original.sourceMeta },
        };
        // 注入角色模型映射
        session.settings.roleModels = { ...s.roleModels };
        session.settings.directorModel = s.directorModel;
        session.settings.dialogueMode = s.mode;
        // 注入自定义破限（如果用户配置了）
        if (s.jailbreakText && !session.jailbreak.text) {
            session.jailbreak = {
                text: s.jailbreakText,
                source: 'plugin-config',
                enabled: true,
                name: s.jailbreakName || '自定义破限',
            };
        }
        // 注入世界书绑定
        const bindings = s.worldbookBindings;
        if (Object.keys(bindings).length > 0) {
            for (const wb of session.worldBooks) {
                const boundRoles = bindings[wb.id];
                if (boundRoles) {
                    wb._boundRoleIds = boundRoles;
                }
            }
        }
        return session;
    }
    // ═══════════════════════════════════════════════════════
    // 统一对外 API
    // ═══════════════════════════════════════════════════════
    const API = {
        version: '2.0.0',
        adapter,
        director,
        executor: engine,
        writer,
        utils: U,
        settings: settingsStore,
        // ── 角色选择器 ────────────────────────
        /** 弹出角色选择弹层（替代 prompt()） */
        promptRole: showRoleSelector,
        // ── 快捷方法（保持与旧版兼容） ────────
        getSnapshot: () => adapter.getCurrentSession() || adapter.readFromTavern(),
        getSummary: () => adapter.getSummary(),
        startLiveMode: (cb, ms) => adapter.watchTavern(cb, ms || settingsStore.getRaw().pollIntervalMs),
        stopLiveMode: () => adapter.stopWatching(),
        quickPlan: (session, opts) => director.planTurn({ session: enrichSession(session), ...opts }),
        autoPlan: (opts) => {
            const session = adapter.getCurrentSession() || adapter.readFromTavern();
            if (!session)
                return null;
            return director.planTurn({ session: enrichSession(session), ...opts });
        },
        /** 让用户从角色列表中选择谁来发言 */
        async selectSpeakers(options) {
            const session = adapter.getCurrentSession() || adapter.readFromTavern();
            if (!session) {
                console.warn('[TavernDirector] selectSpeakers: 没有可用会话');
                return null;
            }
            const roles = session.characters.map(c => ({
                id: c.id,
                name: c.name,
                displayName: c.displayName || c.name,
                avatar: c.avatar || '',
                description: c.description?.slice(0, 80) || '',
                disabled: false,
                tag: settingsStore.getRaw().roleModels[c.id] || '',
            }));
            return showRoleSelector({
                title: options?.title || '选择发言角色',
                roles,
                multi: options?.multi !== false,
                maxSelect: options?.maxSelect || 8,
                confirmLabel: '开始生成',
                searchPlaceholder: '搜索角色...',
            });
        },
        /** 全自动：读取 → 调度 → 执行 → 回写 */
        async fullAuto(options) {
            const session = adapter.getCurrentSession() || adapter.readFromTavern();
            if (!session)
                throw new Error('未连接酒馆');
            const enriched = enrichSession(session);
            const plan = director.planTurn({ session: enriched, ...options });
            const tasks = buildTasksFromPlan(plan, enriched);
            const report = await engine.execute(tasks);
            // 归一化输出
            const roleNames = enriched.characters.map((c) => c.displayName);
            report.outputs = normalizeOutputs(report.outputs, { roleNames });
            // 回写（writeReport 内部调用 setWriteCallback 注册的回调）
            await writer.writeReport(report, enriched.messages.length, plan.config.mode === 'parallel' ? 'parallel' : 'sequential');
            writer.notifyUI(report);
            return { session: enriched, plan, report };
        },
        // ── 配置快捷方法 ──────────────────────
        /** 设置角色的模型 */
        setRoleModel(roleId, modelId) {
            settingsStore.setRoleModel(roleId, modelId);
        },
        /** 设置默认模型 */
        setDefaultModel(modelId) {
            settingsStore.updateModelRoute({ defaultModel: modelId });
        },
        /** 设置导演模型 */
        setDirectorModel(modelId) {
            settingsStore.updateModelRoute({ directorModel: modelId });
        },
        /** 设置降级模型链 */
        setFallbackModels(models) {
            settingsStore.updateModelRoute({ fallbackModels: models });
        },
        /** 设置自定义破限 */
        setJailbreak(text, name) {
            settingsStore.setJailbreak(text, name);
        },
        /** 设置世界书绑定 */
        setWorldbookBinding(entryId, roleIds) {
            settingsStore.setWorldbookBinding(entryId, roleIds);
        },
        /** 导出配置为 JSON 字符串 */
        exportConfig() {
            return settingsStore.exportJSON();
        },
        /** 从 JSON 字符串导入配置 */
        importConfig(json) {
            return settingsStore.importJSON(json);
        },
        /** 重置所有配置 */
        resetConfig() {
            settingsStore.reset();
        },
    };
    // ═══════════════════════════════════════════════════════
    // 辅助：从 plan 构建 RoleTask 列表
    // ═══════════════════════════════════════════════════════
    function buildTasksFromPlan(plan, session) {
        const tasks = [];
        const now = Date.now();
        for (const payload of plan.payloads || []) {
            const ctx = payload.context || {};
            const role = (session.characters || []).find((c) => c.id === payload.roleId);
            tasks.push({
                taskId: `task_${payload.roleId}_${now}`,
                sessionId: session.sessionId,
                roleId: payload.roleId,
                roleName: payload.roleName,
                order: payload.orderIndex != null ? payload.orderIndex : 0,
                mode: plan.config.mode || 'sequential',
                status: 'pending',
                modelId: payload.model || settingsStore.getRaw().roleModels[payload.roleId] || '',
                context: {
                    character: role || ctx.role || {},
                    publicMessages: ctx.visibleMessages || [],
                    relevantWorldBooks: ctx.selectedWorldBooks || [],
                    jailbreak: session.jailbreak ? session.jailbreak.text : '',
                    directorNote: ctx.directorNote || '',
                    sessionSummary: ctx.publicSummary || '',
                    hiddenRoleIds: [],
                    sceneInfo: '',
                },
                instruction: payload.prompt || '',
                constraints: [],
                deadlineMs: settingsStore.getRaw().defaultDeadlineMs,
                maxRetries: settingsStore.getRaw().defaultMaxRetries,
                retryCount: 0,
                createdAt: now,
            });
        }
        return tasks;
    }
    // ═══════════════════════════════════════════════════════
    // 挂载到全局
    // ═══════════════════════════════════════════════════════
    if (typeof window !== 'undefined') {
        window.TavernDirector = API;
        // ── 注册为 SillyTavern 插件 ──
        const st = getST();
        const pluginMeta = {
            name: 'TavernDirector',
            version: '2.0.0',
            onLoad() {
                console.log('[TavernDirector] ✅ 已加载');
                // 自动开始监听（如果用户配置了）
                if (settingsStore.getRaw().autoStart) {
                    console.log('[TavernDirector] 自动开始监听...');
                    adapter.watchTavern((session) => {
                        // 静默缓存最新会话，等待用户通过 UI 按钮触发操作
                        window.__tdLastAutoSession = session;
                    }, settingsStore.getRaw().pollIntervalMs);
                }
            },
            onUnload() {
                adapter.stopWatching();
                settingsUnsubscribe();
                if (window.__tdCleanupFloating) window.__tdCleanupFloating();
                console.log('[TavernDirector] 已卸载');
            },
        };
        if (st) {
            if (typeof st.registerPlugin === 'function') {
                st.registerPlugin(pluginMeta);
            }
            else if (typeof st.addPlugin === 'function') {
                st.addPlugin(pluginMeta);
            }
        }
        console.log('[TavernDirector] v2.0.0 就绪');
        console.log('[TavernDirector] 适配器 ✅ | 导演 ✅ | 执行 ✅ | 回写 ✅ | 配置 ✅ | 角色选择器 ✅');
        console.log('[TavernDirector] 基于 SillyTavern.getContext() 真实 API');
        console.log('[TavernDirector] 配置持久化：localStorage（' +
            (settingsStore.getRaw().defaultModel ? '已加载' : '首次运行') +
            '）');
        // 注入浮动控制台（body retry 机制内置）
        injectFloatingPanel();
    }

})();
