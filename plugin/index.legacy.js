/**
 * 酒馆导演插件 —— 统一浏览器端入口
 *
 * 三个模块在浏览器端的完整实现：
 *   模块一：数据适配层（读取酒馆 + 文件导入 + 归一化）
 *   模块二：导演调度层（评分选角 + 排序 + 上下文 + prompt）
 *   模块三：UI 壳子   → shell.html（展示 + 控制 + 调试面板）
 *
 * 加载方式：SillyTavern 以 <script> 注入，
 * 全局 API：window.TavernDirector
 */

(function () {
  'use strict';

  const VERSION = '1.0.0';
  const PLUGIN_NAME = 'TavernDirector';

  console.log(`[${PLUGIN_NAME}] v${VERSION} 初始化...`);

  // ═══════════════════════════════════════════════════════
  // 工具函数库（三个模块共用）
  // ═══════════════════════════════════════════════════════

  const U = {
    nowId(p) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`; },
    clamp(v, min, max) { return Math.max(min, Math.min(max, v)); },
    uniq(arr) { return [...new Set(arr)]; },
    norm(s) { return (s||'').replace(/\s+/g,' ').trim().toLowerCase(); },
    hasWord(text, words) {
      if (!text || !words.length) return false;
      const h = U.norm(text);
      return words.some(w => w && h.includes(U.norm(w)));
    },
    takeLast(arr, n) { return n<=0 ? [] : arr.slice(Math.max(0, arr.length-n)); },
    join(parts, sep) { sep=sep||'\n'; return parts.filter(x => x&&String(x).trim()).join(sep); },
    kwScore(text, keys) {
      if (!text || !keys.length) return 0;
      const h = U.norm(text); let s = 0;
      for (const k of keys) { const t = U.norm(k); if (t && h.includes(t)) s += Math.max(1, Math.min(5, t.length/2)); }
      return s;
    },
    esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },
  };

  // ═══════════════════════════════════════════════════════
  // 模块一：数据适配层
  // ═══════════════════════════════════════════════════════

  const Adapter = {
    _session: null,
    _watcher: null,

    /** 从 SillyTavern 读取实时会话 */
    readFromTavern() {
      const ST = window.SillyTavern || window.ST || {};
      const ctx = (typeof ST.getContext === 'function') ? ST.getContext() : {};
      const chars = ctx.characters ? Object.values(ctx.characters) : [];
      const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
      let wbEntries = [];
      try { const wi = typeof ST.getWorldInfo === 'function' ? ST.getWorldInfo() : null; if (wi && wi.entries) wbEntries = Object.values(wi.entries); } catch(e){}
      let jailbreak = '', jailbreakName = '';
      try { const p = typeof ST.getPreset === 'function' ? ST.getPreset() : null; if (p) { jailbreak = p.system_prompt || p.jailbreak || p.prompt || ''; jailbreakName = p.name || ''; } } catch(e){}
      const version = (typeof ST.getTavernVersion === 'function') ? ST.getTavernVersion() : '';

      return this._normalize({ chars, chat, wbEntries, jailbreak, jailbreakName, version }, 'live');
    },

    /** 监听酒馆变化 */
    watch(onChange, intervalMs) {
      this.stopWatch();
      intervalMs = intervalMs || 2000;
      try {
        const s = this.readFromTavern();
        if (s) { this._session = s; onChange(s); }
      } catch(e){ /* 首次读取失败，等轮询 */ }
      this._watcher = setInterval(() => {
        try {
          const prev = this._session;
          const s = this.readFromTavern();
          if (!prev || this._changed(prev, s)) { this._session = s; onChange(s); }
        } catch(e){ /* 轮询失败不中断定时器 */ }
      }, intervalMs);
      return () => this.stopWatch();
    },

    stopWatch() { if (this._watcher) { clearInterval(this._watcher); this._watcher = null; } },
    getSnapshot() { return this._session || this.readFromTavern(); },

    /** 获取摘要 */
    getSummary() {
      const s = this.getSnapshot();
      return s ? {
        mode: s.mode, characterCount: s.characters.length, messageCount: s.messages.length,
        worldBookCount: s.worldBooks.length,
        jailbreakLoaded: s.jailbreak.enabled && s.jailbreak.text.length > 0,
        jailbreakName: s.jailbreak.name,
      } : { mode:'live', characterCount:0, messageCount:0, worldBookCount:0, jailbreakLoaded:false, jailbreakName:'' };
    },

    /** 从外部数据（文件导入/粘贴）合并到当前 session */
    importFromData(data, fileName, fileType) {
      // 根据类型构造 raw 数据并归一化
      const name = fileName || '导入数据';
      const type = fileType || 'json';
      let raw = { chars:[], chat:[], wbEntries:[], jailbreak:'', jailbreakName:'', version:'' };

      if (type === 'json' && typeof data === 'object') {
        // 检测 JSON 内容类型
        if (Array.isArray(data)) {
          // 数组 → 消息列表或世界书列表
          if (data.length > 0 && (data[0].content || data[0].mes || data[0].role)) {
            raw.chat = data;
          } else if (data.length > 0 && (data[0].key || data[0].keys || data[0].entry)) {
            raw.wbEntries = data;
          }
        } else {
          // 对象 → 可能是角色卡/聊天记录/世界书
          if (data.name && (data.personality || data.description || data.first_mes || data.scenario)) {
            raw.chars = [data];
          }
          if (data.messages || data.chat || data.history) {
            raw.chat = data.messages || data.chat || data.history || [];
          }
          if (data.entries || data.worldinfo || data.lorebook || data.world_book) {
            const entries = data.entries || data.worldinfo || data.lorebook || data.world_book || {};
            raw.wbEntries = Array.isArray(entries) ? entries : Object.values(entries);
          }
          if (data.system_prompt || data.jailbreak || data.prompt || data.text) {
            raw.jailbreak = data.system_prompt || data.jailbreak || data.prompt || data.text || '';
            raw.jailbreakName = data.name || name;
          }
          // 可能包含角色列表
          if (data.characters && Array.isArray(data.characters)) {
            raw.chars = raw.chars.concat(data.characters);
          }
        }
      } else if (type === 'text' && typeof data === 'string') {
        raw.jailbreak = data;
        raw.jailbreakName = name;
      }

      // 归一化并合并到当前 session
      const imported = this._normalize(raw, 'import');
      const current = this._session || this.readFromTavern();

      if (!this._session) {
        // 首次导入，直接设置
        this._session = imported;
      } else {
        // 合并：追加角色（去重）、追加消息（去重+排序）、追加世界书（去重）
        const existCharIds = new Set(current.characters.map(c=>c.name.toLowerCase()));
        const newChars = imported.characters.filter(c=>!existCharIds.has(c.name.toLowerCase()));
        current.characters = current.characters.concat(newChars);

        const existMsgIds = new Set(current.messages.map(m=>m.id));
        const newMsgs = imported.messages.filter(m=>!existMsgIds.has(m.id));
        current.messages = current.messages.concat(newMsgs).sort((a,b)=>a.timestamp-b.timestamp);

        const existWBIds = new Set(current.worldBooks.map(w=>w.id));
        const newWBs = imported.worldBooks.filter(w=>!existWBIds.has(w.id));
        current.worldBooks = current.worldBooks.concat(newWBs);

        if (imported.jailbreak.text && !current.jailbreak.text) {
          current.jailbreak = imported.jailbreak;
        }
        this._session = current;
      }

      return this._session;
    },

    // ── 内部 ─────────────────────────────────
    _normalize(raw, mode) {
      const now = Date.now();
      const characters = (raw.chars||[]).map((c,i) => ({
        id: c.id || `char_${now}_${i}`, name: c.name||'未命名', displayName: c.display_name||c.name||'未命名',
        avatar: c.avatar||c.image||'', model: c.model||'', prompt: c.system_prompt||c.prompt||c.personality||c.description||'',
        description: c.description||'', lorebookRefs:[], status: c.enabled!==false?'enabled':'disabled',
        isNarrator:!!c.is_narrator, meta:c.data||{},
      }));

      const messages = (raw.chat||[]).map((m,i) => ({
        id: m.id||`msg_${now}_${i}`,
        role: m.is_system?'system':m.is_user?'user':m.role==='assistant'?'assistant':'character',
        speaker: m.name||m.speaker||'未知', content: m.content||m.mes||'',
        timestamp: typeof m.timestamp==='number'?(m.timestamp>1e12?Math.floor(m.timestamp/1000):m.timestamp):Math.floor(now/1000),
        turnIndex: m.turn||m.swipe_id||i, visible: m.visible!==false, meta:{},
      }));

      const worldBooks = (raw.wbEntries||[]).map((e,i) => ({
        id: e.uid!==undefined?String(e.uid):e.id||`wb_${now}_${i}`,
        title: e.comment||e.title||'未命名',
        keys: typeof e.key==='string'?e.key.split(',').map(k=>k.trim()).filter(Boolean):Array.isArray(e.key)?e.key:[],
        content: e.content||'', depth: e.depth||0, triggerType:'keyword', priority: e.priority||10,
        enabled:!e.disable, target:'global',
        secondaryKeys: typeof e.secondary_keys==='string'?e.secondary_keys.split(',').map(k=>k.trim()).filter(Boolean):[],
        constant:!!e.constant, position:'after_char', scanDepth: e.scan_depth||2, selective:!!e.selective, meta:{},
      }));

      return {
        sessionId: `session-${now}`, mode,
        characters, messages, worldBooks,
        jailbreak: { text: raw.jailbreak||'', source: mode==='live'?'tavern':'file', enabled: mode==='live'||!!raw.jailbreak, name: raw.jailbreakName||'未加载' },
        settings: { dialogueMode:'sequential', directorModel:'', roleModels:{} },
        sourceMeta: { tavernVersion: raw.version||'', importedAt: mode==='import'?new Date().toISOString():'', fileNames:[], source: mode==='live'?'tavern-live':'file-import' },
      };
    },

    _changed(prev, curr) {
      return prev.characters.length !== curr.characters.length ||
        prev.messages.length !== curr.messages.length ||
        prev.worldBooks.length !== curr.worldBooks.length ||
        prev.jailbreak.text !== curr.jailbreak.text;
    },
  };

  // ═══════════════════════════════════════════════════════
  // 模块二：导演调度层
  // ═══════════════════════════════════════════════════════

  const DEFAULT_CONFIG = {
    mode:'sequential', dialogueMode:'sequential', maxRoles:3, maxWorldBooks:6,
    recentMessages:12, orderStrategy:'score', allowParallel:true,
    includeNarrator:true, includeDisabled:false, preferSpeakerContinuity:true, topicThreshold:1,
  };

  const Director = {
    /** 快捷入口：从 UnifiedSession 生成调度计划 */
    planTurn(session, options) {
      const opts = options || {};
      const config = Object.assign({}, DEFAULT_CONFIG, opts);
      const request = { session, latestUserMessage: opts.latestUserMessage||'', manualSpeakerId: opts.manualSpeakerId, manualSpeakerIds: opts.manualSpeakerIds, maxRoles: config.maxRoles };

      // ── 角色评分 ──────────────────────────
      const manualSet = new Set([request.manualSpeakerId, ...(request.manualSpeakerIds||[])].filter(Boolean));
      const latestMsg = request.latestUserMessage || (session.messages.filter(m=>m.visible!==false).slice(-1)[0]||{}).content || '';

      const roleScores = session.characters
        .filter(r => config.includeDisabled || r.status !== 'disabled')
        .map(role => {
          let score = 0; const reasons = [];
          if (manualSet.has(role.id)) { score += 100; reasons.push('manual'); }
          if (role.isNarrator && config.includeNarrator) { score += 20; reasons.push('narrator'); }
          if (U.hasWord(latestMsg, [role.displayName, role.name])) { score += 18; reasons.push('mention'); }
          if (config.preferSpeakerContinuity) {
            const msgs = session.messages.filter(m=>m.visible!==false); const last = msgs[msgs.length-1];
            if (last && (last.speaker===role.displayName || last.speaker===role.name)) { score += 8; reasons.push('speaker-continuity'); }
          }
          // 发言冷却：最近 2 轮已发言的角色降权，防止同一角色连续霸屏
          if (!manualSet.has(role.id)) {
            const recentSpeakers = session.messages
              .filter(m=>m.visible!==false)
              .slice(-4)
              .map(m=>m.speaker);
            const recentCount = recentSpeakers.filter(s=>s===role.displayName||s===role.name).length;
            if (recentCount >= 2) { score *= 0.25; reasons.push('cooldown-heavy'); }
            else if (recentCount >= 1) { score *= 0.55; reasons.push('cooldown-light'); }
          }
          const focusText = U.join([role.name, role.displayName, role.description, role.prompt, latestMsg]);
          score += U.kwScore(focusText, [role.name, role.displayName]) * 0.6;
          score += U.kwScore(latestMsg, [role.name, role.displayName]) * 0.4;
          if (role.prompt) score += 0.5;
          if (role.description) score += 0.25;
          if (score <= 0) { score += 1; reasons.push('fallback'); }
          else if (!reasons.length) reasons.push('topic-match');
          const priority = score >= 9 ? 'high' : score >= 4 ? 'normal' : 'low';
          return { roleId:role.id, score, reasons:U.uniq(reasons), priority };
        })
        .sort((a,b) => b.score - a.score || a.roleId.localeCompare(b.roleId));

      const selectedIds = roleScores.slice(0, Math.max(1, config.maxRoles)).map(s => s.roleId);
      const orderedIds = config.orderStrategy==='fixed' ? selectedIds :
        config.orderStrategy==='round-robin' ? selectedIds.sort() :
        roleScores.filter(s=>selectedIds.includes(s.roleId)).sort((a,b)=>b.score-a.score).map(s=>s.roleId);

      const selectedRoles = session.characters.filter(c => selectedIds.includes(c.id));

      // ── 世界书评分 ────────────────────────
      const focusText = U.join([
        latestMsg,
        ...session.messages.filter(m=>m.visible!==false).slice(-config.recentMessages).map(m=>`${m.speaker} ${m.content}`),
        ...selectedRoles.map(r=>`${r.name} ${r.displayName} ${r.prompt} ${r.description}`),
      ]);

      const wbScores = session.worldBooks.filter(e=>e.enabled!==false).map(entry => {
        let score = 0; const reasons = [];
        score += U.kwScore(focusText, entry.keys);
        if (score>0) reasons.push('primary-keyword');
        const sec = U.kwScore(focusText, entry.secondaryKeys);
        if (sec>0) { score += sec*0.5; reasons.push('secondary-keyword'); }
        if (entry.constant) { score += 2; reasons.push('constant'); }
        if (entry.target==='character' && selectedRoles.some(r=>r.id===entry.characterId)) { score += 4; reasons.push('character-target'); }
        if (entry.triggerType==='director') { score += 1.5; reasons.push('director-trigger'); }
        return { entryId:entry.id, score, reasons };
      }).sort((a,b)=>b.score-a.score);

      const selectedWBIds = wbScores.slice(0, config.maxWorldBooks).map(x=>x.entryId);
      const skippedIds = session.characters.map(c=>c.id).filter(id=>!selectedIds.includes(id));

      const decision = {
        mode: config.mode, planId: U.nowId('plan'), sessionId: session.sessionId,
        selectedRoleIds: selectedIds, orderedRoleIds: orderedIds, skippedRoleIds: skippedIds,
        roleScores, worldBookScores: wbScores, selectedWorldBookIds: selectedWBIds,
        reason: `选择角色：${selectedRoles.map(r=>r.displayName).join('、')||'无'}；激活世界书：${selectedWBIds.length} 条`,
        timestamp: Date.now(),
      };

      // ── 上下文 ────────────────────────────
      const focusWBs = session.worldBooks.filter(wb=>selectedWBIds.includes(wb.id));
      const contexts = {};
      for (const role of selectedRoles) {
        const relevantWBs = focusWBs.length
          ? focusWBs.filter(wb=>wb.target==='global'||wb.target==='session'||wb.characterId===role.id)
          : session.worldBooks.filter(e=>e.enabled!==false).slice(0, config.maxWorldBooks);

        const wakeReasons = (()=>{
          const r = [];
          if (request.manualSpeakerId===role.id||(request.manualSpeakerIds||[]).includes(role.id)) r.push('manual');
          if (U.hasWord(latestMsg, [role.displayName, role.name])) r.push('mention');
          const msgs = session.messages.filter(m=>m.visible!==false); const last = msgs[msgs.length-1];
          if (config.preferSpeakerContinuity && last && (last.speaker===role.displayName||last.speaker===role.name)) r.push('speaker-continuity');
          if (U.norm(U.join([role.name,role.displayName,role.description,latestMsg])).includes(U.norm(role.name))) r.push('topic-match');
          if (!r.length) r.push('fallback');
          return U.uniq(r);
        })();

        const priority = wakeReasons.includes('manual')?'high':wakeReasons.includes('mention')||wakeReasons.includes('speaker-continuity')?'normal':'low';
        const visibleMsgs = U.takeLast(session.messages.filter(m=>m.visible!==false), config.recentMessages);

        contexts[role.id] = {
          role, visibleMessages:visibleMsgs, selectedWorldBooks:relevantWBs,
          publicSummary: visibleMsgs.map(m=>`${m.speaker}: ${m.content}`).join('\n')||'无',
          directorNote: U.join([`本轮身份：${role.displayName}`,`唤醒原因：${wakeReasons.join(' / ')}`,`优先级：${priority}`, relevantWBs.length?`相关世界书：${relevantWBs.map(w=>w.title).join('、')}`:'相关世界书：无']),
          wakeReason: wakeReasons, priority,
        };
      }

      // ── Payloads ──────────────────────────
      const payloads = orderedIds.map((rid, idx) => {
        const role = session.characters.find(c=>c.id===rid);
        const ctx = contexts[rid];
        if (!role||!ctx) return null;
        const chat = ctx.visibleMessages.map(m=>`${m.speaker}: ${m.content}`).join('\n');
        // 世界书按 position 分组
        const beforeWB = (ctx.selectedWorldBooks||[]).filter(w=>!w.position||w.position==='before_char');
        const afterWB  = (ctx.selectedWorldBooks||[]).filter(w=>w.position==='after_char');
        const inlineWB = (ctx.selectedWorldBooks||[]).filter(w=>w.position==='in_chat');
        function fmtWB(arr){ return arr.length?arr.map(w=>`【${w.title}】${w.content}`).join('\n\n'):''; }
        const otherNames = ctx.visibleMessages.map(m=>m.speaker).filter((s,i,arr)=>s&&s!==role.displayName&&arr.indexOf(s)===i).slice(0,8);

        const rolePrompt = U.join([
          `【你的身份】`,`你是 ${role.displayName}。`,'',
          `【角色设定】`,role.prompt||'无',
          role.description?`\n【补充描述】\n${role.description}`:'','',
          `【前置设定】`,fmtWB(beforeWB),'',
          `【本轮指令】`,ctx.directorNote,'',
          otherNames.length?`【在场角色】\n${otherNames.join('、')}`:'','',
          `【公开聊天记录】`,chat||'（暂无）','',
          `【内联参考】`,fmtWB(inlineWB),'',
          `【补充设定】`,fmtWB(afterWB),'',
          `【输出要求】`,'1. 只输出该角色的对话/动作内容，不要添加解释或前缀。','2. 不要替其他角色说话或替其他角色做决定。','3. 保持角色设定和语气一致。',
        ]);
        return { roleId:rid, roleName:role.displayName, model:role.model||'', status:'queued', orderIndex:idx, context:ctx, prompt:rolePrompt };
      }).filter(Boolean);

      const dirPrompt = U.join([
        '你是酒馆群聊的导演AI，只负责调度，不直接代替角色发言。',
        `当前模式：${decision.mode}`,`调度模式：${config.dialogueMode}`,
        `本轮唤醒角色：${decision.selectedRoleIds.join('、')||'无'}`,
        `本轮顺序：${decision.orderedRoleIds.join(' → ')||'无'}`,
        `已选世界书：${decision.selectedWorldBookIds.join('、')||'无'}`,
        latestMsg?`用户最新输入：${latestMsg}`:'',
        '','输出要求：','1. 只给出调度结果。','2. 明确指出谁先谁后。','3. 必要时说明原因。',
      ]);

      const rolePrompts = {};
      payloads.forEach(p=>{rolePrompts[p.roleId]=p.prompt;});

      return { request, config, decision, contexts, payloads, promptBundle:{directorPrompt:dirPrompt, rolePrompts} };
    },

    /** 自动从模块一获取 session 并调度 */
    autoPlan(options) {
      const session = Adapter.getSnapshot();
      if (!session) return null;
      return this.planTurn(session, options);
    },

    summarizeSession(session) {
      const msgs = session.messages.filter(m=>m.visible!==false);
      const last = msgs[msgs.length-1];
      return { sessionId:session.sessionId, mode:session.mode, characterCount:session.characters.length, messageCount:msgs.length, worldBookCount:session.worldBooks.filter(w=>w.enabled!==false).length, latestSpeaker:last?last.speaker:'', latestMessage:last?last.content:'' };
    },
  };

  // ═══════════════════════════════════════════════════════
  // 模块四：角色执行层
  // ═══════════════════════════════════════════════════════

  const RoleEngine = {
    /**
     * 从导演层的 plan 构建 RoleTask 列表
     */
    buildTasks(plan, session, options) {
      const opts = options || {};
      const tasks = [];
      const now = Date.now();

      for (const payload of (plan.payloads || [])) {
        const ctx = payload.context || {};
        const role = (session.characters || []).find(c => c.id === payload.roleId);

        tasks.push({
          taskId: `task_${payload.roleId}_${now}`,
          sessionId: session.sessionId,
          roleId: payload.roleId,
          roleName: payload.roleName,
          order: payload.orderIndex != null ? payload.orderIndex : 0,
          mode: plan.config.mode || 'sequential',
          status: 'pending',
          modelId: payload.model || '',
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
          deadlineMs: opts.deadlineMs || 30000,
          maxRetries: opts.maxRetries != null ? opts.maxRetries : 2,
          retryCount: 0,
          createdAt: now,
        });
      }
      return tasks;
    },

    /**
     * 执行单个任务（通过 ST generate 接口）
     *
     * 使用 SillyTavern 的 generate 接口调用 AI。
     * 如果 ST 不可用，则走模拟模式。
     */
    async executeOne(task, modelIdOverride) {
      const modelId = modelIdOverride || task.modelId || '';
      const startTime = performance.now();

      try {
        // 尝试通过 ST 的 generate 接口
        const ST = window.SillyTavern || window.ST || {};
        let text = '';

        if (typeof ST.generate === 'function') {
          // ST 标准接口
          text = await ST.generate(task.instruction, modelId);
        } else if (typeof ST.sendGenerationRequest === 'function') {
          // 另一种 ST 接口
          const result = await ST.sendGenerationRequest({
            prompt: task.instruction,
            model: modelId,
            timeout: task.deadlineMs,
          });
          text = result.text || result.response || '';
        } else {
          // ST 不可用：返回明确失败，不制造假回复
          const latency = Math.round(performance.now() - startTime);
          return {
            taskId: task.taskId, roleId: task.roleId, roleName: task.roleName,
            content: '', status: 'failed', modelId,
            tokensUsed: 0, latencyMs: latency, raw: '', normSteps: [],
            error: 'SillyTavern generate 接口不可用。请确认插件在酒馆环境中正确加载。',
            timestamp: Date.now(),
          };
        }

        const latency = Math.round(performance.now() - startTime);
        return {
          taskId: task.taskId, roleId: task.roleId, roleName: task.roleName,
          content: text, status: 'success', modelId,
          tokensUsed: Math.ceil(text.length / 2.5),
          latencyMs: latency, raw: text, normSteps: [], error: '', timestamp: Date.now(),
        };
      } catch (e) {
        const latency = Math.round(performance.now() - startTime);
        return {
          taskId: task.taskId, roleId: task.roleId, roleName: task.roleName,
          content: '', status: 'failed', modelId,
          tokensUsed: 0, latencyMs: latency, raw: '', normSteps: [],
          error: String(e), timestamp: Date.now(),
        };
      }
    },

    /**
     * 批量执行：从 plan 直接执行全部角色任务
     */
    async executePlan(plan, session, options) {
      const tasks = this.buildTasks(plan, session, options);
      const mode = plan.config.mode || 'sequential';
      const outputs = [];
      const startTime = performance.now();

      if (mode === 'parallel') {
        // 并行：全部同时发起
        const results = await Promise.all(
          tasks.map(t => this.executeOne(t))
        );
        outputs.push(...results);
      } else {
        // 顺序：一个接一个
        for (const task of tasks) {
          const result = await this.executeOne(task);
          outputs.push(result);
          // 将当前角色的输出追加到后续任务的上下文中
          if (result.status === 'success' && result.content) {
            for (let j = tasks.indexOf(task) + 1; j < tasks.length; j++) {
              tasks[j].context.publicMessages.push({
                id: `live_${Date.now()}`, role: 'character',
                speaker: result.roleName, content: result.content,
                timestamp: Date.now() / 1000, turnIndex: 999, visible: true, meta: {},
              });
            }
          }
        }
      }

      const totalLatency = Math.round(performance.now() - startTime);
      return {
        reportId: U.nowId('report'), sessionId: session.sessionId,
        outputs,
        successCount: outputs.filter(o => o.status === 'success').length,
        failedCount: outputs.filter(o => o.status === 'failed').length,
        skippedCount: outputs.filter(o => o.status === 'skipped').length,
        totalLatencyMs: totalLatency,
        totalTokens: outputs.reduce((s, o) => s + o.tokensUsed, 0),
        mode, timestamp: Date.now(),
      };
    },

    /**
     * 清洗输出（归一化）
     */
    normalize(output, roleNames) {
      let text = output.raw || output.content || '';
      if (!text.trim()) return { ...output, content: '', status: 'failed', error: '空输出' };

      // 移除思考标签
      text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
      text = text.replace(/【思考】[\s\S]*?【\/?思考】?/g, '');
      text = text.replace(/^思考[：:]\s*.+$/gim, '');

      // 移除角色名前缀
      const names = [output.roleName, ...(roleNames || [])].filter(Boolean);
      for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp('^'+escaped+'\\s*[:：]\\s*', 'i'), '');
        text = text.replace(new RegExp('^[【\\[]\\s*'+escaped+'\\s*[】\\]]\\s*', 'i'), '');
      }

      // 移除 AI 元话语
      text = text.replace(/^(?:作为(?:一个|一名)?(?:AI|人工智能|语言模型|角色扮演)[，,]?\s*)+/gi, '');
      text = text.replace(/^(?:好的[，,]\s*)?(?:我来?|让我来?)(?:回答|扮演|饰演|表演)/gi, '');
      text = text.replace(/^(?:I\s+will|let\s+me)\s+(?:answer|play|roleplay|respond)/gi, '');

      // 清洗空白
      text = text.replace(/\n{3,}/g, '\n\n').split('\n').map(l=>l.trim()).join('\n').replace(/[ \t]{2,}/g, ' ').trim();

      // 长度截断
      if (text.length > 2000) text = text.slice(0, 2000);
      if (!text.trim()) return { ...output, content: '', status: 'failed', error: '归一化后为空' };

      return {
        ...output,
        content: text,
        normSteps: [`原始: ${output.content.length} 字符 → 归一化: ${text.length} 字符`],
      };
    },

    /**
     * 生成角色回复并回写到 ST 聊天
     */
    async generateAndWrite(plan, session, options) {
      const report = await this.executePlan(plan, session, options);
      const roleNames = (session.characters || []).map(c => c.displayName);

      // 归一化所有输出
      report.outputs = report.outputs.map(o => this.normalize(o, roleNames));

      // 尝试回写到 ST
      const ST = window.SillyTavern || window.ST || {};
      const successes = report.outputs.filter(o => o.status === 'success');

      for (let i = 0; i < successes.length; i++) {
        const out = successes[i];
        try {
          if (typeof ST.addMessage === 'function') {
            ST.addMessage({
              name: out.roleName,
              role: 'assistant',
              content: out.content,
              model: out.modelId,
            });
          }
        } catch (e) {
          console.warn('[RoleEngine] 回写 ST 失败:', e);
        }
      }

      // 通知 UI
      try {
        window.dispatchEvent(new CustomEvent('tavern-director:execution-complete', {
          detail: {
            successCount: report.successCount,
            failedCount: report.failedCount,
            totalLatencyMs: report.totalLatencyMs,
            totalTokens: report.totalTokens,
            outputs: successes.map(o => ({
              roleName: o.roleName,
              content: o.content.slice(0, 100),
              status: o.status,
            })),
          },
        }));
      } catch (e) { /* 不在浏览器环境 */ }

      return report;
    },
  };

  // ═══════════════════════════════════════════════════════
  // 注册全局 API
  // ═══════════════════════════════════════════════════════

  const API = {
    version: VERSION,
    adapter: Adapter,
    director: Director,
    executor: RoleEngine,
    utils: U,
    DEFAULT_CONFIG,

    // 快捷方法
    getSnapshot: () => Adapter.getSnapshot(),
    getSummary: () => Adapter.getSummary(),
    startLiveMode: (cb, ms) => Adapter.watch(cb, ms),
    stopLiveMode: () => Adapter.stopWatch(),
    quickPlan: (session, opts) => Director.planTurn(session, opts),
    autoPlan: (opts) => Director.autoPlan(opts),

    /** 全自动：模块一读取 → 模块二调度 → 模块四执行 → 回写 */
    async fullAuto(options) {
      const session = Adapter.getSnapshot();
      if (!session) throw new Error('未连接酒馆');
      const plan = Director.planTurn(session, options || {});
      const report = await RoleEngine.generateAndWrite(plan, session, options || {});
      return { session, plan, report };
    },
  };

  window.TavernDirector = API;

  // ═══════════════════════════════════════════════════════
  // 模块三：悬浮窗 UI
  // ═══════════════════════════════════════════════════════
  (function injectFloatingUI() {
    if (document.getElementById('td-floating-root')) return; // 防止重复注入

    var S = {
      connected: false, directorStatus: 'idle', collapsed: false,
      characters: [], lastDecision: null, logs: []
    };

    // ── 注入 CSS ─────────────────────────────────
    var style = document.createElement('style');
    style.textContent = [
      '#td-floating-root{position:fixed;z-index:99999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;line-height:1.4;color:#e0e0e0}',
      '#td-fab{position:fixed;right:16px;bottom:16px;z-index:99999;width:44px;height:44px;border-radius:50%;background:#e94560;color:#fff;border:none;cursor:pointer;font-size:20px;box-shadow:0 4px 16px rgba(233,69,96,.4);transition:.2s;display:flex;align-items:center;justify-content:center}',
      '#td-fab:hover{transform:scale(1.1);box-shadow:0 6px 24px rgba(233,69,96,.6)}',
      '#td-fab.hidden{display:none}',
      '#td-panel{position:fixed;right:16px;bottom:72px;z-index:99998;width:320px;max-height:70vh;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden;display:flex;flex-direction:column;transition:.2s}',
      '#td-panel.collapsed{max-height:40px}',
      '#td-header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#16213e;cursor:grab;user-select:none;flex-shrink:0}',
      '#td-header:active{cursor:grabbing}',
      '#td-header .td-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}',
      '#td-header .td-dot.on{background:#4caf50;box-shadow:0 0 6px #4caf50}',
      '#td-header .td-dot.off{background:#f44336}',
      '#td-header .td-dot.thinking{background:#ff9800;animation:td-pulse 1s infinite}',
      '@keyframes td-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '#td-header .td-title{flex:1;font-weight:700;font-size:13px;color:#e94560;white-space:nowrap}',
      '#td-header .td-btn{background:none;border:none;color:#9090a8;cursor:pointer;font-size:14px;padding:2px 4px;line-height:1}',
      '#td-header .td-btn:hover{color:#e0e0e0}',
      '#td-body{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '#td-body.collapsed{display:none}',
      '.td-section{border-bottom:1px solid #2a2a4a;padding-bottom:8px}',
      '.td-section:last-child{border-bottom:none;padding-bottom:0}',
      '.td-section-title{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#5a5a78;margin-bottom:6px}',
      '.td-char-row{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:11px}',
      '.td-char-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}',
      '.td-char-dot.sel{background:#53a8b6}',
      '.td-char-dot.skip{background:#5a5a78}',
      '.td-char-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.td-actions{display:flex;flex-wrap:wrap;gap:4px}',
      '.td-actions .td-act{flex:1;min-width:70px;padding:6px 8px;border:1px solid #2a2a4a;border-radius:6px;background:#16213e;color:#e0e0e0;cursor:pointer;font-size:10px;text-align:center;transition:.15s;white-space:nowrap}',
      '.td-actions .td-act:hover{border-color:#e94560;background:#1f2b47}',
      '.td-actions .td-act.primary{background:#e94560;border-color:#e94560;color:#fff;font-weight:600}',
      '.td-log-item{padding:4px 0;font-size:10px;border-bottom:1px solid rgba(42,42,74,.5)}',
      '.td-log-item:last-child{border-bottom:none}',
      '.td-log-reason{color:#9090a8;margin-top:2px}',
      '.td-log-roles{color:#53a8b6}',
      '.td-empty{color:#5a5a78;text-align:center;padding:12px 0;font-style:italic;font-size:11px}',
      '.td-banner{padding:6px 8px;border-radius:4px;font-size:10px;margin-bottom:4px}',
      '.td-banner.warn{background:rgba(255,152,0,.15);color:#ff9800}',
      '.td-banner.err{background:rgba(244,67,54,.15);color:#f44336}',
    ].join('\n');
    document.head.appendChild(style);

    // ── 注入 HTML ─────────────────────────────────
    var root = document.createElement('div');
    root.id = 'td-floating-root';
    root.innerHTML = [
      '<button id="td-fab" title="酒馆导演">🎬</button>',
      '<div id="td-panel" class="collapsed">',
        '<div id="td-header">',
          '<span class="td-dot off" id="td-dot"></span>',
          '<span class="td-title">🎬 导演台</span>',
          '<span style="font-size:10px;color:#5a5a78" id="td-summary"></span>',
          '<button class="td-btn" id="td-btn-min" title="折叠">−</button>',
          '<button class="td-btn" id="td-btn-close" title="关闭">✕</button>',
        '</div>',
        '<div id="td-body" class="collapsed">',
          '<div id="td-banner-area"></div>',
          '<div class="td-section"><div class="td-section-title">👥 角色</div><div id="td-char-list"><div class="td-empty">等待数据...</div></div></div>',
          '<div class="td-section"><div class="td-section-title">🎯 操作</div>',
            '<div class="td-actions">',
              '<button class="td-act primary" id="td-act-run">🎯 导演决定</button>',
              '<button class="td-act" id="td-act-specify">👤 指定说话</button>',
            '</div>',
            '<div class="td-actions" style="margin-top:4px">',
              '<button class="td-act" id="td-act-all">📢 全员旁白</button>',
              '<button class="td-act" id="td-act-rr">🔄 全员轮流</button>',
            '</div>',
          '</div>',
          '<div class="td-section"><div class="td-section-title">📋 最近调度</div><div id="td-log-list"><div class="td-empty">尚未执行调度</div></div></div>',
        '</div>',
      '</div>',
    ].join('');
    document.body.appendChild(root);

    // ── DOM 引用 ──────────────────────────────────
    var $fab   = document.getElementById('td-fab');
    var $panel = document.getElementById('td-panel');
    var $body  = document.getElementById('td-body');
    var $dot   = document.getElementById('td-dot');
    var $sum   = document.getElementById('td-summary');
    var $chars = document.getElementById('td-char-list');
    var $logs  = document.getElementById('td-log-list');
    var $banner= document.getElementById('td-banner-area');
    var $btnMin= document.getElementById('td-btn-min');

    // ── 拖拽 ────────────────────────────────────
    var header = document.getElementById('td-header');
    var dragging = false, offX = 0, offY = 0;
    header.addEventListener('mousedown', function(e) {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true; var r = $panel.getBoundingClientRect();
      offX = e.clientX - r.left; offY = e.clientY - r.top;
      $panel.style.transition = 'none';
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      $panel.style.right = 'auto'; $panel.style.bottom = 'auto';
      $panel.style.left = (e.clientX - offX) + 'px';
      $panel.style.top = (e.clientY - offY) + 'px';
    });
    document.addEventListener('mouseup', function() {
      if (dragging) { dragging = false; $panel.style.transition = '.2s'; }
    });

    // ── 折叠/展开 ────────────────────────────────
    function collapse() {
      S.collapsed = true;
      $panel.classList.add('collapsed');
      $body.classList.add('collapsed');
      $btnMin.textContent = '+';
    }
    function expand() {
      S.collapsed = false;
      $panel.classList.remove('collapsed');
      $body.classList.remove('collapsed');
      $btnMin.textContent = '−';
      refreshUI();
    }
    $btnMin.addEventListener('click', function() { S.collapsed ? expand() : collapse(); });

    // ── 关闭/打开 ────────────────────────────────
    document.getElementById('td-btn-close').addEventListener('click', function() {
      $panel.style.display = 'none'; $fab.classList.remove('hidden');
    });
    $fab.addEventListener('click', function() {
      if ($panel.style.display === 'none') {
        $panel.style.display = 'flex'; $fab.classList.add('hidden');
        expand();
      } else {
        $panel.style.display = 'none'; $fab.classList.remove('hidden');
      }
    });
    // 初始显示面板
    $fab.classList.add('hidden');
    $panel.style.display = 'flex';
    expand();

    // ── 数据同步 ──────────────────────────────────
    function syncData() {
      var snap = Adapter.getSnapshot();
      if (!snap) { S.connected = false; refreshStatus(); return; }
      S.connected = true;
      S.characters = (snap.characters || []).map(function(c) {
        return { id: c.id, name: c.displayName || c.name, status: c.status, isNarrator: c.isNarrator, isSelected: false };
      });
      refreshStatus();
      refreshChars();
    }

    function refreshStatus() {
      $dot.className = 'td-dot ' + (S.directorStatus === 'thinking' ? 'thinking' : S.connected ? 'on' : 'off');
      $sum.textContent = S.connected ? (S.characters.length+'角色') : '未连接';
    }

    function refreshChars() {
      if (!S.characters.length) { $chars.innerHTML = '<div class="td-empty">等待数据...</div>'; return; }
      $chars.innerHTML = S.characters.map(function(c) {
        var dotCls = c.isSelected ? 'sel' : c.status === 'disabled' ? 'skip' : '';
        var style = c.status === 'disabled' ? 'opacity:.4;text-decoration:line-through' : '';
        return '<div class="td-char-row"><span class="td-char-dot '+dotCls+'"></span><span class="td-char-name" style="'+style+'">'+U.esc(c.name)+(c.isNarrator?' (旁白)':'')+'</span></div>';
      }).join('');
    }

    function refreshLogs() {
      if (!S.logs.length) { $logs.innerHTML = '<div class="td-empty">尚未执行调度</div>'; return; }
      $logs.innerHTML = S.logs.slice(0, 5).map(function(l) {
        var chars = S.characters.filter(function(c){ return l.selectedRoles.indexOf(c.id) !== -1; });
        return '<div class="td-log-item"><span style="color:#5a5a78">'+new Date(l.timestamp).toLocaleTimeString()+'</span> <span class="td-log-roles">'+chars.map(function(c){return c.name;}).join('、')||'无' + '</span><div class="td-log-reason">'+U.esc(l.reason)+'</div></div>';
      }).join('');
    }

    function refreshUI() {
      if (S.collapsed) return;
      syncData();
      refreshLogs();
    }

    // ── 横幅提示 ──────────────────────────────────
    var bannerTimer = null;
    function showBanner(msg, type) {
      type = type || 'warn';
      $banner.innerHTML = '<div class="td-banner '+type+'">'+U.esc(msg)+'</div>';
      if (bannerTimer) clearTimeout(bannerTimer);
      if (type !== 'err') bannerTimer = setTimeout(function(){ $banner.innerHTML = ''; }, 4000);
    }

    // ── 按钮事件 ──────────────────────────────────
    function doDirector(opts) {
      S.directorStatus = 'thinking'; refreshStatus();
      var session = Adapter.getSnapshot();
      if (!session) { showBanner('未连接酒馆', 'err'); S.directorStatus = 'idle'; refreshStatus(); return; }
      try {
        var plan = Director.planTurn(session, opts || {});
        if (plan && plan.decision) {
          var sel = new Set(plan.decision.selectedRoleIds);
          S.characters.forEach(function(c){ c.isSelected = sel.has(c.id); });
          S.lastDecision = {
            timestamp: Date.now(),
            selectedRoles: plan.decision.selectedRoleIds,
            orderedRoleIds: plan.decision.orderedRoleIds,
            reason: plan.decision.reason
          };
          S.logs.unshift(S.lastDecision);
          if (S.logs.length > 50) S.logs.length = 50;
          S.directorStatus = 'done';
        } else {
          showBanner('调度返回空结果', 'err');
          S.directorStatus = 'idle';
        }
      } catch(e) {
        showBanner('调度失败: '+String(e), 'err');
        S.directorStatus = 'idle';
      }
      refreshUI();
      setTimeout(function(){ S.directorStatus = 'idle'; refreshStatus(); }, 2000);
    }

    document.getElementById('td-act-run').addEventListener('click', function() {
      doDirector({ maxRoles: 3 });
    });
    document.getElementById('td-act-specify').addEventListener('click', function() {
      var names = S.characters.filter(function(c){ return c.status !== 'disabled'; }).map(function(c){ return c.name; });
      if (!names.length) { showBanner('没有可用的角色', 'warn'); return; }
      var choice = prompt('指定谁说话？\n可用：'+names.join('、'), names[0]);
      if (choice) {
        var target = S.characters.find(function(c){ return c.name === choice || c.id === choice; });
        if (target) doDirector({ manualSpeakerId: target.id, maxRoles: 1 });
      }
    });
    document.getElementById('td-act-all').addEventListener('click', function() {
      var enabled = S.characters.filter(function(c){ return c.status !== 'disabled'; });
      if (!enabled.length) { showBanner('没有可用的角色', 'warn'); return; }
      doDirector({ manualSpeakerIds: enabled.map(function(c){ return c.id; }), maxRoles: enabled.length });
    });
    document.getElementById('td-act-rr').addEventListener('click', function() {
      var enabled = S.characters.filter(function(c){ return c.status !== 'disabled'; });
      if (!enabled.length) { showBanner('没有可用的角色', 'warn'); return; }
      doDirector({ manualSpeakerIds: enabled.map(function(c){ return c.id; }), maxRoles: enabled.length, orderStrategy: 'round-robin' });
    });

    // ── 初始化和定时刷新 ────────────────────────────
    syncData();
    setInterval(refreshUI, 3000);

    // 暴露给外部
    API.floatingUI = {
      show: function() { $panel.style.display = 'flex'; $fab.classList.add('hidden'); expand(); },
      hide: function() { $panel.style.display = 'none'; $fab.classList.remove('hidden'); },
      toggle: function() { $panel.style.display === 'none' ? API.floatingUI.show() : API.floatingUI.hide(); },
      refresh: refreshUI,
    };

    console.log('[TavernDirector] 悬浮窗 UI 已注入');
  })();

  // ── ST 插件注册 ──────────────────────────────────
  const ST = window.SillyTavern || window.ST || {};
  const plugin = {
    name: PLUGIN_NAME, version: VERSION,
    onLoad() { console.log(`[${PLUGIN_NAME}] 已加载`); },
    onUnload() { Adapter.stopWatch(); },
  };
  if (typeof ST.registerPlugin === 'function') ST.registerPlugin(plugin);
  else if (typeof ST.addPlugin === 'function') ST.addPlugin(plugin);

  console.log(`[${PLUGIN_NAME}] v${VERSION} 就绪 — 四个模块已全部加载`);
  console.log('[TavernDirector] 模块一(数据适配) ✅ | 模块二(导演) ✅ | 模块三(悬浮UI) ✅ | 模块四(执行) ✅');
  console.log('[TavernDirector] API: window.TavernDirector.fullAuto() 一键全自动');
})();
