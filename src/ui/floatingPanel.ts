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

export function injectFloatingPanel(): void {
  // 防止重复注入
  if ((window as any).__tdFloatingInjected) {
    console.log('[TavernDirector] 浮动面板已存在，跳过注入');
    return;
  }

  // 等待 body 就绪
  if (!document.body) {
    const retries = (window as any).__tdFloatingRetries || 0;
    if (retries >= 30) {
      console.error('[TavernDirector] ⚠️ document.body 在 6 秒内未就绪，放弃注入浮动面板');
      return;
    }
    (window as any).__tdFloatingRetries = retries + 1;
    console.log(`[TavernDirector] 等待 body 就绪... (${retries + 1}/30)`);
    setTimeout(injectFloatingPanel, 200);
    return;
  }

  (window as any).__tdFloatingInjected = true;
  console.log('[TavernDirector] 开始注入浮动面板...');

  // ═══════════════════════════════════════════════════
  // Inject CSS
  // ═══════════════════════════════════════════════════
  const css = document.createElement('style');
  css.id = 'td-floating-style';
  css.textContent = `
#td-floating-root{position:fixed;z-index:2147483640;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;font-size:12px;line-height:1.5;color:#e0e0e0}
#td-fab{position:fixed;right:16px;bottom:16px;z-index:2147483641;width:44px;height:44px;border-radius:50%;background:#e94560;color:#fff;border:none;cursor:pointer;font-size:20px;box-shadow:0 4px 16px rgba(233,69,96,.4);transition:.2s;display:flex;align-items:center;justify-content:center}
#td-fab:hover{transform:scale(1.1);box-shadow:0 6px 24px rgba(233,69,96,.6)}
#td-fab.hidden{display:none}
#td-panel{position:fixed;right:16px;bottom:72px;z-index:2147483640;width:340px;max-height:78vh;background:#1a1a2e;border:1px solid #2a2a4a;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden;display:flex;flex-direction:column;transition:.2s;resize:both}
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
#td-tabs .td-tab{flex:1;padding:8px;text-align:center;font-size:11px;color:#6a6a88;cursor:pointer;border-bottom:2px solid transparent;transition:.15s;background:none;border-top:none;border-left:none;border-right:1px solid #2a2a4a}
#td-tabs .td-tab:last-child{border-right:none}
#td-tabs .td-tab.active{color:#e0e0e0;border-bottom-color:#e94560}
#td-tabs .td-tab:hover{color:#e0e0e0}
#td-body{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
#td-body.collapsed{display:none}
.td-section{border-bottom:1px solid #2a2a4a;padding-bottom:8px}
.td-section:last-child{border-bottom:none;padding-bottom:0}
.td-section-title{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#5a5a78;margin-bottom:6px}
.td-char-row{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px}
.td-char-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.td-char-dot.sel{background:#53a8b6}
.td-char-dot.skip{background:#5a5a78}
.td-char-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.td-actions{display:flex;flex-wrap:wrap;gap:5px}
.td-act{flex:1;min-width:70px;padding:7px 10px;border:1px solid #2a2a4a;border-radius:6px;background:#16213e;color:#e0e0e0;cursor:pointer;font-size:10px;text-align:center;transition:.15s;white-space:nowrap;font-family:inherit}
.td-act:hover{border-color:#e94560;background:#1f2b47}
.td-act.primary{background:#e94560;border-color:#e94560;color:#fff;font-weight:600}
.td-act.primary:hover{background:#d63850}
.td-log-item{padding:4px 0;font-size:10px;border-bottom:1px solid rgba(42,42,74,.5)}
.td-log-item:last-child{border-bottom:none}
.td-log-reason{color:#9090a8;margin-top:2px}
.td-log-roles{color:#53a8b6;font-weight:500}
.td-empty{color:#5a5a78;text-align:center;padding:12px 0;font-style:italic;font-size:11px}
.td-banner{padding:6px 8px;border-radius:4px;font-size:10px;margin-bottom:4px}
.td-banner.warn{background:rgba(255,152,0,.15);color:#ff9800}
.td-banner.err{background:rgba(244,67,54,.15);color:#f44336}
.td-banner.ok{background:rgba(76,175,80,.15);color:#4caf50}
.td-field{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
.td-field label{font-size:10px;color:#9090a8;font-weight:500}
.td-field input,.td-field select,.td-field textarea{width:100%;box-sizing:border-box;padding:6px 8px;background:#0f0f1a;border:1px solid #2a2a4a;border-radius:4px;color:#e0e0e0;font-size:11px;font-family:inherit;outline:none}
.td-field input:focus,.td-field select:focus,.td-field textarea:focus{border-color:#e94560}
.td-field textarea{resize:vertical;min-height:60px}
.td-field-row{display:flex;gap:6px}
.td-field-row .td-field{flex:1}
.td-help{font-size:9px;color:#5a5a78;margin-top:2px}
.td-bind-row{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:10px}
.td-bind-row select{flex:1;padding:4px;background:#0f0f1a;border:1px solid #2a2a4a;border-radius:3px;color:#e0e0e0;font-size:10px}
.td-bind-row button{padding:2px 8px;border-radius:3px;background:#2a2a4a;color:#e0e0e0;border:none;cursor:pointer;font-size:10px}
.td-bind-row button:hover{background:#e94560}
.td-bind-row button.del:hover{background:#f44336}
`.trim();
  document.head.appendChild(css);
  console.log('[TavernDirector] CSS 已注入');

  // ═══════════════════════════════════════════════════
  // Inject HTML
  // ═══════════════════════════════════════════════════
  const root = document.createElement('div');
  root.id = 'td-floating-root';
  root.innerHTML = `
<button id="td-fab" title="酒馆导演台">🎬</button>
<div id="td-panel">
  <div id="td-header">
    <span class="td-dot off" id="td-dot"></span>
    <span class="td-title">🎬 导演台</span>
    <span class="td-summary" id="td-summary"></span>
    <button class="td-btn" id="td-btn-min" title="折叠">−</button>
    <button class="td-btn" id="td-btn-close" title="关闭">✕</button>
  </div>
  <div id="td-tabs">
    <button class="td-tab active" data-tab="console">🎯 控制台</button>
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
  const $fab = document.getElementById('td-fab')!;
  const $panel = document.getElementById('td-panel')!;
  const $body = document.getElementById('td-body')!;
  const $dot = document.getElementById('td-dot')!;
  const $summary = document.getElementById('td-summary')!;
  const $btnMin = document.getElementById('td-btn-min')!;
  const $banner = document.getElementById('td-banner-area')!;
  const $tabs = document.querySelectorAll('#td-tabs .td-tab');

  // ═══════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════
  const S: PanelState = {
    connected: false, directorStatus: 'idle', collapsed: false,
    currentTab: 'console',
    characters: [], logs: [],
  };

  // ═══════════════════════════════════════════════════
  // Panel: collapse / expand / show / hide
  // ═══════════════════════════════════════════════════
  function collapse() { S.collapsed = true; $panel.classList.add('collapsed'); $body.classList.add('collapsed'); $btnMin.textContent = '+'; }
  function expand() { S.collapsed = false; $panel.classList.remove('collapsed'); $body.classList.remove('collapsed'); $btnMin.textContent = '−'; render(); }
  $btnMin.addEventListener('click', () => S.collapsed ? expand() : collapse());

  function hidePanel() { $panel.style.display = 'none'; $fab.classList.remove('hidden'); }
  function showPanel() { $panel.style.display = 'flex'; $fab.classList.add('hidden'); expand(); }
  document.getElementById('td-btn-close')!.addEventListener('click', hidePanel);
  $fab.addEventListener('click', showPanel);

  // ── Draggable header ───────────────────────────
  let dragging = false, offX = 0, offY = 0;
  document.getElementById('td-header')!.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    dragging = true;
    const r = $panel.getBoundingClientRect();
    offX = e.clientX - r.left;
    offY = e.clientY - r.top;
    $panel.style.transition = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    $panel.style.right = 'auto'; $panel.style.bottom = 'auto';
    $panel.style.left = (e.clientX - offX) + 'px';
    $panel.style.top = (e.clientY - offY) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; $panel.style.transition = '.2s'; }
  });

  // ── Tab switching ─────────────────────────────
  $tabs.forEach(t => t.addEventListener('click', () => {
    S.currentTab = (t as HTMLElement).dataset.tab as any;
    $tabs.forEach(tt => tt.classList.remove('active'));
    t.classList.add('active');
    render();
  }));

  // ═══════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════
  function render() {
    if (S.collapsed) return;
    if (S.currentTab === 'console') renderConsole();
    else renderSettings();
  }

  // ─── Console Tab ──────────────────────────────
  function renderConsole() {
    const TD = (window as any).TavernDirector || {};
    const chars = S.characters;
    const charsHTML = !chars.length
      ? '<div class="td-empty">等待数据...</div>'
      : chars.map(c =>
          `<div class="td-char-row">
            <span class="td-char-dot ${c.isSelected ? 'sel' : c.status === 'disabled' ? 'skip' : ''}"></span>
            <span class="td-char-name" style="${c.status === 'disabled' ? 'opacity:.4;text-decoration:line-through' : ''}">${esc(c.name)}${c.isNarrator ? ' (旁白)' : ''}</span>
          </div>`
        ).join('');

    const logsHTML = !S.logs.length
      ? '<div class="td-empty">尚未执行调度</div>'
      : S.logs.slice(0, 5).map(l => {
          const names = l.selectedRoles.map(id => {
            const c = chars.find(cc => cc.id === id);
            return c ? c.name : id;
          }).join('、') || '无';
          return `<div class="td-log-item">
            <span style="color:#5a5a78">${new Date(l.timestamp).toLocaleTimeString()}</span>
            <span class="td-log-roles">${esc(names)}</span>
            <div class="td-log-reason">${esc(l.reason)}</div>
          </div>`;
        }).join('');

    $body.innerHTML = `
      <div class="td-section">
        <div class="td-section-title">👥 角色 (${chars.length})</div>
        ${charsHTML}
      </div>
      <div class="td-section">
        <div class="td-section-title">🎯 操作</div>
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
        </div>
      </div>
      <div class="td-section">
        <div class="td-section-title">📋 最近调度</div>
        ${logsHTML}
      </div>`;

    document.getElementById('td-act-run')?.addEventListener('click', () => doDirector({}));
    document.getElementById('td-act-speakers')?.addEventListener('click', () => doSelectSpeakers());
    document.getElementById('td-act-all')?.addEventListener('click', () => doAllSpeak('parallel'));
    document.getElementById('td-act-rr')?.addEventListener('click', () => doAllSpeak('sequential'));
    document.getElementById('td-act-fullauto')?.addEventListener('click', () => doFullAuto());
  }

  // ─── Settings Tab ────────────────────────────
  function renderSettings() {
    const TD = (window as any).TavernDirector || {};
    const raw = TD.settings?.getRaw ? TD.settings.getRaw() : {};

    const getModels = () => {
      try { return raw.fallbackModels?.join(', ') || ''; } catch { return ''; }
    };

    let charOpts = '';
    try {
      const snap = TD.getSnapshot?.() || {};
      (snap.characters || []).forEach((c: any) => {
        const mid = raw.roleModels?.[c.id] || '';
        charOpts += `<div class="td-bind-row">
          <span style="width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.displayName || c.name)}</span>
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
        <div id="td-cfg-wb-bindings"></div>
        <span class="td-help">格式：entryId:roleId,roleId。每行一个绑定</span>
        <textarea id="td-cfg-wb-text" style="width:100%;min-height:50px;margin-top:4px;background:#0f0f1a;border:1px solid #2a2a4a;color:#e0e0e0;font-size:10px;border-radius:4px;padding:4px" placeholder="wb_entry_01:char_001,char_002&#10;wb_entry_02:char_001"></textarea>
      </div>
      <div class="td-section">
        <div class="td-section-title">💾 数据管理</div>
        <div class="td-actions">
          <button class="td-act" id="td-cfg-export">📥 导出配置</button>
          <button class="td-act" id="td-cfg-import">📤 导入配置</button>
          <button class="td-act" id="td-cfg-reset" style="border-color:#f44336;color:#f44336">⚠️ 重置</button>
        </div>
        <div class="td-actions" style="margin-top:5px">
          <button class="td-act" id="td-cfg-save">💾 保存</button>
        </div>
      </div>`;

    try {
      const binds = raw.worldbookBindings || {};
      const lines = Object.entries(binds).map(([k, v]) => `${k}:${(v as string[]).join(',')}`);
      (document.getElementById('td-cfg-wb-text') as HTMLTextAreaElement).value = lines.join('\n');
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
        const roleId = (inp as HTMLElement).dataset.roleId || '';
        const modelId = (inp as HTMLInputElement).value.trim();
        if (roleId) TD.setRoleModel?.(roleId, modelId);
      });
    });
  }

  function saveAllSettings() {
    const TD = (window as any).TavernDirector || {};
    const defaultModel = (document.getElementById('td-cfg-defaultModel') as HTMLInputElement)?.value?.trim() || '';
    const directorModel = (document.getElementById('td-cfg-directorModel') as HTMLInputElement)?.value?.trim() || '';
    const fallbackRaw = (document.getElementById('td-cfg-fallbackModels') as HTMLInputElement)?.value || '';
    const fallbackModels = fallbackRaw.split(',').map((s: string) => s.trim()).filter(Boolean);
    const jailbreak = (document.getElementById('td-cfg-jailbreak') as HTMLTextAreaElement)?.value || '';
    const wbRaw = (document.getElementById('td-cfg-wb-text') as HTMLTextAreaElement)?.value || '';

    TD.setDefaultModel?.(defaultModel);
    TD.setDirectorModel?.(directorModel);
    TD.setFallbackModels?.(fallbackModels);
    TD.setJailbreak?.(jailbreak);

    const binds: Record<string, string[]> = {};
    wbRaw.split('\n').forEach((line: string) => {
      const [entryId, rolesStr] = line.split(':').map(s => s.trim());
      if (entryId && rolesStr) binds[entryId] = rolesStr.split(',').map(s => s.trim()).filter(Boolean);
    });
    if (TD.settings?.setWorldbookBindings) TD.settings.setWorldbookBindings(binds);

    document.querySelectorAll('.td-bind-model').forEach(inp => {
      const roleId = (inp as HTMLElement).dataset.roleId || '';
      const modelId = (inp as HTMLInputElement).value.trim();
      if (roleId && modelId) TD.setRoleModel?.(roleId, modelId);
    });

    showBanner('配置已保存 ✅', 'ok');
  }

  // ═══════════════════════════════════════════════════
  // Actions
  // ═══════════════════════════════════════════════════
  function getTD(): any { return (window as any).TavernDirector || {}; }

  function syncData() {
    const TD = getTD();
    try {
      const snap = TD.getSnapshot?.() || {};
      if (!snap || !snap.characters) { S.connected = false; return; }
      S.connected = true;
      S.characters = (snap.characters || []).map((c: any) => ({
        id: c.id, name: c.displayName || c.name,
        status: c.status || 'enabled',
        isNarrator: !!c.isNarrator,
        isSelected: false,
      }));
      $dot.className = 'td-dot on';
      $summary.textContent = S.characters.length + '角色';
    } catch {
      S.connected = false;
      $dot.className = 'td-dot off';
      $summary.textContent = '未连接';
    }
  }

  function doDirector(opts: Record<string, unknown>) {
    S.directorStatus = 'thinking'; $dot.className = 'td-dot thinking';
    const TD = getTD();
    try {
      const plan = TD.autoPlan?.(opts);
      if (plan?.decision) {
        const sel = new Set(plan.decision.selectedRoleIds || []);
        S.characters.forEach(c => { c.isSelected = sel.has(c.id); });
        S.logs.unshift({
          timestamp: Date.now(),
          selectedRoles: plan.decision.selectedRoleIds || [],
          orderedRoles: plan.decision.orderedRoleIds || [],
          reason: plan.decision.reason || '',
        });
        if (S.logs.length > 50) S.logs.length = 50;
        S.directorStatus = 'done';
      } else {
        showBanner('调度返回空结果', 'err');
        S.directorStatus = 'idle';
      }
    } catch (e: any) {
      showBanner('调度失败: ' + String(e), 'err');
      S.directorStatus = 'idle';
    }
    syncData();
    render();
    setTimeout(() => { S.directorStatus = 'idle'; syncData(); }, 2000);
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

  function doAllSpeak(mode: string) {
    const enabled = S.characters.filter(c => c.status !== 'disabled');
    if (!enabled.length) { showBanner('没有可用的角色', 'warn'); return; }
    doDirector({ manualSpeakerIds: enabled.map(c => c.id), maxRoles: enabled.length, orderStrategy: mode === 'sequential' ? 'round-robin' : undefined });
  }

  async function doFullAuto() {
    const TD = getTD();
    S.directorStatus = 'thinking'; $dot.className = 'td-dot thinking';
    try {
      showBanner('⏳ 全自动执行中...', 'warn');
      const res = await TD.fullAuto?.();
      if (res) {
        S.logs.unshift({ timestamp: Date.now(), selectedRoles: res.plan?.decision?.selectedRoleIds || [], orderedRoles: res.plan?.decision?.orderedRoleIds || [], reason: res.plan?.decision?.reason || '全自动执行完成' });
        if (S.logs.length > 50) S.logs.length = 50;
        S.directorStatus = 'done';
        showBanner(`✅ 完成：${res.report?.successCount || 0} 成功，${res.report?.failedCount || 0} 失败`, 'ok');
      }
    } catch (e: any) {
      showBanner('全自动失败: ' + String(e), 'err');
      S.directorStatus = 'error';
    }
    syncData();
    render();
    setTimeout(() => { S.directorStatus = 'idle'; syncData(); }, 3000);
  }

  // ═══════════════════════════════════════════════════
  // Banner
  // ═══════════════════════════════════════════════════
  let bannerTimer: any = null;
  function showBanner(msg: string, type = 'warn') {
    $banner.innerHTML = '<div class="td-banner ' + type + '">' + esc(msg) + '</div>';
    if (bannerTimer) clearTimeout(bannerTimer);
    if (type !== 'err') bannerTimer = setTimeout(() => { $banner.innerHTML = ''; }, 4000);
  }

  // ═══════════════════════════════════════════════════
  // Auto-refresh & startup
  // ═══════════════════════════════════════════════════
  syncData();
  showPanel();
  console.log('[TavernDirector] 浮动面板注入完成 ✅');

  // 监听 writer.notifyUI 的执行完成事件
  window.addEventListener('tavern-director:execution-complete', ((e: CustomEvent) => {
    const d = e.detail;
    showBanner(`✅ 执行完成：${d.successCount} 成功 / ${d.failedCount} 失败 / ${d.totalTokens} tokens`, d.failedCount > 0 ? 'warn' : 'ok');
    syncData();
    render();
  }) as EventListener);

  setInterval(() => {
    if (!S.collapsed && $panel.style.display !== 'none') {
      syncData();
      if (S.currentTab === 'console') renderConsole();
    }
  }, 3000);
}

// ─── Types ──────────────────────────────────────────
interface PanelState {
  connected: boolean;
  directorStatus: 'idle' | 'thinking' | 'running' | 'done' | 'error';
  collapsed: boolean;
  currentTab: 'console' | 'settings';
  characters: Array<{ id: string; name: string; status: string; isNarrator: boolean; isSelected: boolean }>;
  logs: Array<{ timestamp: number; selectedRoles: string[]; orderedRoles: string[]; reason: string }>;
}

// ─── Util ────────────────────────────────────────────
function esc(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
