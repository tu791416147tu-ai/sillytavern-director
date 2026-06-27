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

export interface RoleOption {
  id: string;
  name: string;
  displayName?: string;
  avatar?: string;
  description?: string;
  /** 是否禁用（不可选） */
  disabled?: boolean;
  /** 附加标签（如模型名） */
  tag?: string;
}

export interface RoleSelectorOptions {
  /** 标题 */
  title?: string;
  /** 角色列表 */
  roles: RoleOption[];
  /** 多选模式（默认 false = 单选） */
  multi?: boolean;
  /** 预选中的角色 ID */
  preselected?: string[];
  /** 最少选择数（多选模式） */
  minSelect?: number;
  /** 最多选择数（多选模式） */
  maxSelect?: number;
  /** 确认按钮文字 */
  confirmLabel?: string;
  /** 取消按钮文字 */
  cancelLabel?: string;
  /** 搜索框占位文字 */
  searchPlaceholder?: string;
}

export interface RoleSelectorResult {
  /** 选中的角色 ID 列表 */
  selectedIds: string[];
  /** 是否点击了确认（false = 取消/关闭） */
  confirmed: boolean;
}

// ─── 全局样式（只注入一次） ────────────────────────────

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) return;
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

export function showRoleSelector(options: RoleSelectorOptions): Promise<RoleSelectorResult> {
  injectStyles();

  const {
    title = '选择角色',
    roles,
    multi = false,
    preselected = [],
    minSelect = multi ? 1 : 1,
    maxSelect = multi ? roles.length : 1,
    confirmLabel = '确认',
    cancelLabel = '取消',
    searchPlaceholder = '搜索角色...',
  } = options;

  return new Promise((resolve) => {
    // 状态
    const selected = new Set<string>(
      preselected.filter(id => roles.some(r => r.id === id && !r.disabled))
    );

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
      <span class="td-rs-title">${esc(title)}</span>
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
        if (selected.has(role.id)) card.classList.add('selected');
        if (role.disabled) card.classList.add('disabled');

        const initial = (role.displayName || role.name).charAt(0).toUpperCase();
        const avatarHTML = role.avatar
          ? `<img src="${esc(role.avatar)}" alt="">`
          : initial;

        card.innerHTML = `
          <div class="td-rs-avatar">${avatarHTML}</div>
          <div class="td-rs-info">
            <div class="td-rs-name">${esc(role.displayName || role.name)}</div>
            ${role.description ? `<div class="td-rs-desc">${esc(role.description)}</div>` : ''}
          </div>
          ${role.tag ? `<span class="td-rs-tag">${esc(role.tag)}</span>` : ''}
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
      } else {
        hintDiv.textContent = `已选 ${n} 个角色`;
      }
    }

    function updateConfirm() {
      if (selected.size < minSelect) {
        confirmBtn.disabled = true;
      } else {
        confirmBtn.disabled = false;
      }
    }

    // ── 选择逻辑 ───────────────────────────
    function toggleRole(id: string) {
      if (multi) {
        if (selected.has(id)) {
          selected.delete(id);
        } else {
          if (selected.size >= maxSelect) {
            // 移除最早选中的
            const first = [...selected][0];
            if (first) selected.delete(first);
          }
          selected.add(id);
        }
      } else {
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
    header.querySelector('.td-rs-close')!.addEventListener('click', () => finish(false));

    // 点击遮罩关闭
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });

    // Escape 关闭
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter' && !confirmBtn.disabled) finish(true);
    };
    document.addEventListener('keydown', onKey, { once: false });

    // 包装 finish：清理键盘监听后再执行原始逻辑
    let finish: (confirmed: boolean) => void;
    const finishImpl = (confirmed: boolean) => {
      const result: RoleSelectorResult = {
        selectedIds: [...selected],
        confirmed,
      };
      overlay.remove();
      resolve(result);
    };
    finish = (confirmed: boolean) => {
      document.removeEventListener('keydown', onKey);
      finishImpl(confirmed);
    };

    // 搜索
    searchInput.addEventListener('input', () => render(searchInput.value));

    // 按钮
    cancelBtn.addEventListener('click', () => finish(false));
    confirmBtn.addEventListener('click', () => {
      if (!confirmBtn.disabled) finish(true);
    });

    // 初始渲染
    render();
    updateHint();
    updateConfirm();
    searchInput.focus();
  });
}

// ─── 工具 ─────────────────────────────────────────

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
