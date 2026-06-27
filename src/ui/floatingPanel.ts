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
  // ── 悬浮窗图标 (WebP base64, 300x300, ~14KB) ──
  const FAB_ICON = 'data:image/webp;base64,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';

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
#td-fab{position:fixed;right:20px;bottom:20px;z-index:2147483641;width:52px;height:52px;border-radius:50%;background:rgba(22,33,62,.9);color:#fff;border:3px solid #e94560;cursor:pointer;font-size:16px;box-shadow:0 0 0 3px rgba(255,255,255,.25),0 0 24px rgba(233,69,96,.7),0 0 48px rgba(233,69,96,.3);transition:.2s;display:flex;align-items:center;justify-content:center;padding:0;overflow:hidden;animation:td-fab-pulse 3s ease-in-out infinite}
#td-fab img{width:100%;height:100%;object-fit:cover;border-radius:50%}
#td-fab:hover{transform:scale(1.12);border-color:#ff6b81;box-shadow:0 0 0 4px rgba(255,255,255,.4),0 0 32px rgba(233,69,96,.85),0 0 56px rgba(233,69,96,.45)}
@keyframes td-fab-pulse{0%,100%{box-shadow:0 0 0 3px rgba(255,255,255,.25),0 0 24px rgba(233,69,96,.7),0 0 48px rgba(233,69,96,.3)}50%{box-shadow:0 0 0 5px rgba(255,255,255,.45),0 0 36px rgba(233,69,96,.9),0 0 60px rgba(233,69,96,.5)}}
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
/* Mobile: full-width panel, larger touch targets */
@media (max-width: 480px) {
  #td-fab{right:12px;bottom:12px;width:60px;height:60px;border-radius:50%}
  #td-panel{right:4px;bottom:64px;width:calc(100vw - 8px);max-height:60vh;border-radius:8px;font-size:13px;resize:none}
  #td-panel.collapsed{max-height:44px}
  #td-header{padding:12px;font-size:14px}
  .td-act{padding:8px 10px;font-size:11px;min-width:60px}
  .td-tab{font-size:12px;padding:10px}
  #td-body{padding:8px 10px}
  .td-field input,.td-field select,.td-field textarea{font-size:13px;padding:8px}
  .td-bind-row{font-size:11px}
}
`.trim();
  document.head.appendChild(css);
  console.log('[TavernDirector] CSS 已注入');

  // ═══════════════════════════════════════════════════
  // Loading indicator — visible even before ST connects
  // 使用深色中性色调，避免红色被误认为错误提示
  // ═══════════════════════════════════════════════════
  const $indicator = document.createElement('div');
  $indicator.id = 'td-load-indicator';
  $indicator.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483642;'
    + 'background:linear-gradient(135deg,#1a1a2e,#0f3460);color:#e0e0e0;text-align:center;'
    + 'padding:5px 8px;font-size:12px;font-weight:500;font-family:sans-serif;'
    + 'border-bottom:1px solid rgba(233,69,96,.25);'
    + 'transition:opacity .4s ease,transform .4s ease;will-change:opacity,transform;';
  $indicator.innerHTML = '🎬 <b>导演台已加载</b> — 点击右下角 <span style="display:inline-block;width:20px;height:20px;border-radius:50%;vertical-align:middle;overflow:hidden;border:1px solid rgba(233,69,96,.5)"><img src="' + FAB_ICON + '" width="20" height="20" style="width:100%;height:100%;object-fit:cover" /></span> <b>头像按钮</b> 打开控制台';
  document.body.appendChild($indicator);
  // 5 秒后淡出收起，动画结束后从 DOM 移除
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
<button id="td-fab" title="酒馆导演台"><img src="' + FAB_ICON + '" alt="导演" width="48" height="48" /></button>
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
  function showPanel() {
    try {
      $panel.style.display = 'flex';
      $fab.classList.add('hidden');
      expand();
    } catch (e) {
      // 面板展示异常时回退到 FAB 可见，确保总有一个入口
      console.warn('[TavernDirector] 面板展开失败，回退到FAB模式', e);
      $fab.classList.remove('hidden');
    }
  }
  document.getElementById('td-btn-close')!.addEventListener('click', hidePanel);
  $fab.addEventListener('click', showPanel);

  // ── Draggable header (mouse + touch) ──────────
  let dragging = false, offX = 0, offY = 0;
  const headerEl = document.getElementById('td-header')!;

  function dragStart(e: MouseEvent | TouchEvent) {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    dragging = true;
    const r = $panel.getBoundingClientRect();
    const p = 'touches' in e ? e.touches[0] : e;
    offX = p.clientX - r.left;
    offY = p.clientY - r.top;
    $panel.style.transition = 'none';
  }
  function dragMove(e: MouseEvent | TouchEvent) {
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
  // 默认显示 FAB 按钮（不自动打开面板），避免面板/FAB 双双不可见
  // 用户通过点击 FAB 或顶部加载提示条获知入口
  hidePanel();
  console.log('[TavernDirector] 浮动面板注入完成 ✅ (FAB模式)');

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
