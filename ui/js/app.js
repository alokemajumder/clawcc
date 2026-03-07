'use strict';

/* ===================================================================
   ClawCC - Main Application Controller
   =================================================================== */

const App = {
  currentPage: null,
  currentUser: null,
  healthInterval: null,

  pages: {
    fleet:      { label: 'Fleet',          shortcut: '1', render: renderFleetPage },
    sessions:   { label: 'Sessions',       shortcut: '2', render: renderSessionsPage },
    livefeed:   { label: 'Live Feed',      shortcut: '3', render: renderLiveFeedPage },
    usage:      { label: 'Usage',          shortcut: '4', render: renderUsagePage },
    memory:     { label: 'Memory & Files', shortcut: '5', render: renderMemoryPage },
    ops:        { label: 'Ops',            shortcut: '6', render: renderOpsPage },
    governance: { label: 'Governance',     shortcut: '7', render: renderGovernancePage },
  },

  /* ── Init ─────────────────────────────────────────── */

  async init() {
    this.bindKeyboard();
    this.bindTopbar();

    try {
      this.currentUser = await API.me();
      this.showDashboard();
    } catch {
      this.showLogin();
    }
  },

  /* ── Login ────────────────────────────────────────── */

  showLogin() {
    document.getElementById('sidebar').classList.add('hidden');
    document.getElementById('topbar').classList.add('hidden');
    const el = document.getElementById('content');
    el.style.marginLeft = '0';
    el.style.marginTop = '0';
    el.innerHTML = `
      <div class="login-screen">
        <div class="login-card glass-card">
          <div class="login-logo">ClawCC</div>
          <div class="login-subtitle">Fleet Control Center</div>
          <div class="login-error" id="login-error"></div>
          <form id="login-form">
            <div class="form-group">
              <label for="login-username">Username</label>
              <input type="text" id="login-username" autocomplete="username" placeholder="Username" required style="width:100%">
            </div>
            <div class="form-group">
              <label for="login-password">Password</label>
              <input type="password" id="login-password" autocomplete="current-password" placeholder="Password" required style="width:100%">
            </div>
            <div class="form-group hidden" id="mfa-group">
              <label for="login-mfa">MFA Code</label>
              <input type="text" id="login-mfa" autocomplete="one-time-code" placeholder="6-digit code" maxlength="6" style="width:100%">
            </div>
            <button type="submit" class="btn btn-primary w-full" style="width:100%;justify-content:center">Sign In</button>
          </form>
        </div>
      </div>
    `;

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('login-username').value.trim();
      const password = document.getElementById('login-password').value;
      const mfaCode = document.getElementById('login-mfa').value.trim();
      const errEl = document.getElementById('login-error');
      errEl.classList.remove('visible');

      try {
        const result = await API.login(username, password);
        if (result.mfaRequired) {
          document.getElementById('mfa-group').classList.remove('hidden');
          if (mfaCode) {
            await API.verifyMfa(mfaCode);
          } else {
            errEl.textContent = 'Enter your MFA code';
            errEl.classList.add('visible');
            document.getElementById('login-mfa').focus();
            return;
          }
        }
        this.currentUser = await API.me();
        this.showDashboard();
      } catch (err) {
        errEl.textContent = err.message || 'Authentication failed';
        errEl.classList.add('visible');
      }
    });
  },

  /* ── Dashboard ────────────────────────────────────── */

  showDashboard() {
    document.getElementById('sidebar').classList.remove('hidden');
    document.getElementById('topbar').classList.remove('hidden');
    const el = document.getElementById('content');
    el.style.marginLeft = '';
    el.style.marginTop = '';

    // Update user display
    const user = this.currentUser?.user || this.currentUser || {};
    const initials = (user.username || 'U').slice(0, 2).toUpperCase();
    const avatarEl = document.querySelector('.user-menu-btn .avatar');
    if (avatarEl) avatarEl.textContent = initials;
    const nameEl = document.querySelector('.user-menu-btn .user-name');
    if (nameEl) nameEl.textContent = user.username || 'User';

    // Navigate to fleet by default
    this.navigateTo('fleet');

    // Health polling
    if (this.healthInterval) clearInterval(this.healthInterval);
    this.healthInterval = setInterval(() => {
      if (this.currentPage === 'ops') loadOpsData();
    }, 5000);
  },

  /* ── Navigation ───────────────────────────────────── */

  navigateTo(page) {
    if (!this.pages[page]) return;

    // Disconnect SSE when leaving live feed
    if (this.currentPage === 'livefeed' && page !== 'livefeed') {
      SSE.disconnect('livefeed');
    }

    this.currentPage = page;

    // Update sidebar
    document.querySelectorAll('#sidebar nav a').forEach(a => {
      a.classList.toggle('active', a.dataset.page === page);
    });

    // Update topbar title
    const titleEl = document.querySelector('.topbar-title');
    if (titleEl) titleEl.textContent = this.pages[page].label;

    // Render page
    this.pages[page].render();
  },

  /* ── Keyboard ─────────────────────────────────────── */

  bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Ignore when typing in inputs
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }

      switch (e.key) {
        case '1': this.navigateTo('fleet'); break;
        case '2': this.navigateTo('sessions'); break;
        case '3': this.navigateTo('livefeed'); break;
        case '4': this.navigateTo('usage'); break;
        case '5': this.navigateTo('memory'); break;
        case '6': this.navigateTo('ops'); break;
        case '7': this.navigateTo('governance'); break;
        case '/':
          e.preventDefault();
          document.getElementById('search-input')?.focus();
          break;
        case ' ':
          if (this.currentPage === 'livefeed') {
            e.preventDefault();
            toggleFeedPause();
          }
          break;
        case 'Escape':
          this.hideModal();
          document.getElementById('keyboard-help-overlay')?.classList.remove('open');
          document.querySelector('.detail-panel.open')?.classList.remove('open');
          document.querySelector('.user-dropdown.open')?.classList.remove('open');
          break;
        case '?':
          document.getElementById('keyboard-help-overlay')?.classList.toggle('open');
          break;
        case 'k':
          if (this.currentUser?.user?.role === 'admin' || this.currentUser?.role === 'admin') {
            this.showKillSwitchModal();
          }
          break;
      }
    });
  },

  /* ── Topbar ───────────────────────────────────────── */

  bindTopbar() {
    // User menu toggle
    document.querySelector('.user-menu-btn')?.addEventListener('click', () => {
      document.querySelector('.user-dropdown')?.classList.toggle('open');
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.user-menu')) {
        document.querySelector('.user-dropdown')?.classList.remove('open');
      }
    });

    // User menu actions
    document.getElementById('user-logout')?.addEventListener('click', async () => {
      try {
        await API.logout();
      } catch { /* ignore */ }
      this.currentUser = null;
      SSE.disconnectAll();
      if (this.healthInterval) clearInterval(this.healthInterval);
      this.showLogin();
    });

    document.getElementById('user-change-password')?.addEventListener('click', () => {
      this.showModal('Change Password', `
        <div class="form-group"><label>Current Password</label><input type="password" id="cp-old" style="width:100%"></div>
        <div class="form-group"><label>New Password</label><input type="password" id="cp-new" style="width:100%"></div>
        <div class="form-group"><label>Confirm New Password</label><input type="password" id="cp-confirm" style="width:100%"></div>
      `, [
        { label: 'Cancel', class: 'btn btn-ghost', action: () => this.hideModal() },
        { label: 'Change Password', class: 'btn btn-primary', action: async () => {
          const oldPw = document.getElementById('cp-old')?.value;
          const newPw = document.getElementById('cp-new')?.value;
          const confirm = document.getElementById('cp-confirm')?.value;
          if (newPw !== confirm) { this.showToast('Passwords do not match', 'error'); return; }
          try { await API.changePassword(oldPw, newPw); this.hideModal(); this.showToast('Password changed', 'success'); }
          catch (e) { this.showToast(e.message, 'error'); }
        }}
      ]);
    });

    document.getElementById('user-mfa-setup')?.addEventListener('click', async () => {
      try {
        const setup = await API.setupMfa();
        this.showModal('Setup MFA', `
          <div class="text-center mb-4">
            <div class="text-secondary text-sm mb-2">Scan this QR code with your authenticator app</div>
            <div class="glass-card p-4 text-mono text-sm mb-4">${(setup.secret || setup.otpauth || 'See authenticator setup').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</div>
          </div>
          <div class="form-group"><label>Verification Code</label><input type="text" id="mfa-setup-code" maxlength="6" placeholder="6-digit code" style="width:100%"></div>
        `, [
          { label: 'Cancel', class: 'btn btn-ghost', action: () => this.hideModal() },
          { label: 'Enable MFA', class: 'btn btn-primary', action: async () => {
            const code = document.getElementById('mfa-setup-code')?.value;
            try { await API.enableMfa(code); this.hideModal(); this.showToast('MFA enabled', 'success'); }
            catch (e) { this.showToast(e.message, 'error'); }
          }}
        ]);
      } catch (e) { this.showToast(e.message, 'error'); }
    });

    // Search
    document.getElementById('search-input')?.addEventListener('input', (e) => {
      // Filter current page data based on search
      const query = e.target.value.trim().toLowerCase();
      if (!query) return;
      // Dispatch to page-specific filter if available
      if (this.currentPage === 'sessions') {
        const filterInput = document.getElementById('filter-search');
        if (filterInput) { filterInput.value = query; filterInput.dispatchEvent(new Event('input')); }
      }
    });
  },

  /* ── Toast ────────────────────────────────────────── */

  showToast(message, type = 'info', duration = 5000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = { info: '\u2139\uFE0F', success: '\u2705', warning: '\u26A0\uFE0F', error: '\u274C' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'toast-icon';
    iconSpan.textContent = icons[type] || '';
    toast.appendChild(iconSpan);

    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => toast.remove());
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    if (duration > 0) {
      setTimeout(() => {
        if (toast.parentElement) toast.remove();
      }, duration);
    }
  },

  /* ── Modal ────────────────────────────────────────── */

  showModal(title, content, actions = []) {
    const backdrop = document.getElementById('modal-backdrop');
    if (!backdrop) return;

    const esc = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const actionsHtml = actions.map((a, i) =>
      `<button class="${a.class || 'btn btn-ghost'}" data-modal-action="${i}">${esc(a.label)}</button>`
    ).join('');

    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>${esc(title)}</h3>
          <button class="btn-icon" data-modal-close>&times;</button>
        </div>
        <div class="modal-body">${content}</div>
        ${actionsHtml ? `<div class="modal-footer">${actionsHtml}</div>` : ''}
      </div>
    `;

    backdrop.classList.add('open');

    // Bind actions
    backdrop.querySelectorAll('[data-modal-action]').forEach(btn => {
      const idx = parseInt(btn.dataset.modalAction);
      if (actions[idx]?.action) btn.addEventListener('click', actions[idx].action);
    });
    backdrop.querySelectorAll('[data-modal-close]').forEach(btn => {
      btn.addEventListener('click', () => this.hideModal());
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.hideModal();
    });
  },

  hideModal() {
    const backdrop = document.getElementById('modal-backdrop');
    if (backdrop) backdrop.classList.remove('open');
  },

  /* ── Kill Switch ──────────────────────────────────── */

  showKillSwitchModal() {
    this.showModal('Emergency Kill Switch', `
      <p class="text-secondary mb-4">Use with caution. These actions are immediate and cannot be undone.</p>
      <div class="flex flex-col gap-4">
        <div class="glass-card p-4">
          <div class="font-semibold mb-2">Kill Session</div>
          <div class="flex gap-2">
            <input type="text" id="kill-session-id" placeholder="Session ID" style="flex:1">
            <button class="btn btn-danger btn-sm" id="kill-session-btn">Kill</button>
          </div>
        </div>
        <div class="glass-card p-4">
          <div class="font-semibold mb-2">Kill Node</div>
          <div class="flex gap-2">
            <input type="text" id="kill-node-id" placeholder="Node ID" style="flex:1">
            <button class="btn btn-danger btn-sm" id="kill-node-btn">Kill</button>
          </div>
        </div>
        <div class="glass-card p-4">
          <div class="font-semibold mb-2 text-danger">Global Kill Switch</div>
          <p class="text-muted text-sm mb-2">This will terminate ALL sessions across ALL nodes.</p>
          <button class="btn btn-danger" id="kill-global-btn" style="width:100%;justify-content:center">Activate Global Kill Switch</button>
        </div>
      </div>
    `, [{ label: 'Close', class: 'btn btn-ghost', action: () => this.hideModal() }]);

    setTimeout(() => {
      document.getElementById('kill-session-btn')?.addEventListener('click', async () => {
        const id = document.getElementById('kill-session-id')?.value;
        if (!id) return;
        try { await API.killSession(id); this.showToast('Session killed', 'success'); } catch (e) { this.showToast(e.message, 'error'); }
      });
      document.getElementById('kill-node-btn')?.addEventListener('click', async () => {
        const id = document.getElementById('kill-node-id')?.value;
        if (!id) return;
        try { await API.killNode(id); this.showToast('Node killed', 'success'); } catch (e) { this.showToast(e.message, 'error'); }
      });
      document.getElementById('kill-global-btn')?.addEventListener('click', async () => {
        if (!confirm('Are you absolutely sure? This will kill ALL sessions on ALL nodes.')) return;
        try { await API.killGlobal(); this.showToast('Global kill activated', 'success'); } catch (e) { this.showToast(e.message, 'error'); }
      });
    }, 0);
  }
};

/* ── Boot ──────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => App.init());
