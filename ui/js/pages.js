'use strict';

/* ===================================================================
   FCC Page Renderers
   Each function renders into #content and sets up event delegation.
   =================================================================== */

// Helpers
function truncId(id) {
  if (!id) return '--';
  return id.length > 12 ? id.slice(0, 10) + '...' : id;
}

function timeAgo(ts) {
  if (!ts) return '--';
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function driftClass(score) {
  if (score < 30) return 'drift-low';
  if (score < 60) return 'drift-medium';
  if (score < 80) return 'drift-high';
  return 'drift-critical';
}

function statusBadge(status) {
  const s = (status || '').toLowerCase();
  const escaped = escapeHtml(status);
  if (s === 'online' || s === 'active' || s === 'running' || s === 'healthy')
    return `<span class="badge badge-online">${escaped}</span>`;
  if (s === 'offline' || s === 'dead' || s === 'stopped' || s === 'failed')
    return `<span class="badge badge-offline">${escaped}</span>`;
  if (s === 'warning' || s === 'degraded' || s === 'idle')
    return `<span class="badge badge-warning">${escaped}</span>`;
  if (s === 'pending')
    return `<span class="badge badge-info">${escaped}</span>`;
  return `<span class="badge badge-neutral">${escaped}</span>`;
}

function sparklineSvg(data, color) {
  if (!data || !data.length) return '<span class="text-muted text-xs">--</span>';
  const max = Math.max(...data, 1);
  const w = 60, h = 20;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - (v / max) * h;
    return `${x},${y}`;
  }).join(' ');
  return `<span class="sparkline"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="${color || '#6366f1'}" stroke-width="1.5" points="${points}"/></svg></span>`;
}

/* ── Fleet Page ──────────────────────────────────────── */

async function renderFleetPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Fleet Overview</h1>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" id="fleet-refresh">Refresh</button>
      </div>
    </div>
    <div class="stats-grid" id="fleet-stats"></div>
    <div class="glass-card table-wrapper mb-6">
      <table>
        <thead>
          <tr>
            <th>Hostname</th>
            <th>Status</th>
            <th>OS</th>
            <th>Tags</th>
            <th>Tailscale IP</th>
            <th>Last Heartbeat</th>
            <th>CPU</th>
            <th>RAM</th>
            <th>Sessions</th>
          </tr>
        </thead>
        <tbody id="fleet-table-body">
          <tr><td colspan="9" class="text-center text-muted p-4">Loading nodes...</td></tr>
        </tbody>
      </table>
    </div>
    <div class="section-title">Topology</div>
    <div class="topology-container" id="fleet-topology">
      <span class="text-muted">Loading topology...</span>
    </div>
    <div id="fleet-detail" class="detail-panel"></div>
  `;

  loadFleetData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    const row = e.target.closest('tr[data-node-id]');
    if (row) {
      openNodeDetail(row.dataset.nodeId);
      return;
    }
    if (e.target.id === 'fleet-refresh' || e.target.closest('#fleet-refresh')) {
      loadFleetData();
      return;
    }
    if (e.target.closest('.panel-close')) {
      const panel = document.getElementById('fleet-detail');
      if (panel) panel.classList.remove('open');
      return;
    }
    const actionBtn = e.target.closest('[data-node-action]');
    if (actionBtn) {
      const nodeId = actionBtn.dataset.nodeId;
      const action = actionBtn.dataset.nodeAction;
      handleNodeAction(nodeId, action);
    }
  });
}

async function loadFleetData() {
  try {
    const nodes = await API.getNodes();
    const raw = nodes.nodes || nodes || [];
    const list = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, n]) => ({ id, ...n }));
    const online = list.filter(n => (n.status || '').toLowerCase() === 'online').length;

    document.getElementById('fleet-stats').innerHTML = `
      <div class="stat-card glass-card"><div class="stat-label">Total Nodes</div><div class="stat-value">${list.length}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Online</div><div class="stat-value text-success">${online}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Offline</div><div class="stat-value text-danger">${list.length - online}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Active Sessions</div><div class="stat-value">${list.reduce((a, n) => a + (n.sessions || 0), 0)}</div></div>
    `;

    const tbody = document.getElementById('fleet-table-body');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted p-4">No nodes registered</td></tr>';
    } else {
      tbody.innerHTML = list.map(n => `
        <tr class="clickable" data-node-id="${escapeHtml(n.id)}">
          <td class="font-semibold">${escapeHtml(n.hostname || n.id)}</td>
          <td>${statusBadge(n.status)}</td>
          <td class="text-secondary text-sm">${escapeHtml(n.os || '--')}</td>
          <td>${(n.tags || []).map(t => `<span class="badge badge-neutral">${escapeHtml(t)}</span>`).join(' ') || '--'}</td>
          <td class="text-mono text-sm">${escapeHtml(n.tailscaleIp || '--')}</td>
          <td class="text-muted text-sm">${timeAgo(n.lastHeartbeat)}</td>
          <td>${sparklineSvg(n.cpuHistory, '#6366f1')}</td>
          <td>${sparklineSvg(n.ramHistory, '#3b82f6')}</td>
          <td class="text-center">${n.sessions ?? '--'}</td>
        </tr>
      `).join('');
    }

    loadTopology();
  } catch (err) {
    document.getElementById('fleet-table-body').innerHTML =
      `<tr><td colspan="9" class="text-center text-danger p-4">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadTopology() {
  try {
    const topo = await API.getTopology();
    const data = topo.topology || topo;
    const nodes = data.nodes || [];
    const edges = data.edges || [];
    const container = document.getElementById('fleet-topology');
    if (!nodes.length) {
      container.innerHTML = '<span class="text-muted">No topology data available</span>';
      return;
    }
    const w = container.clientWidth || 600;
    const h = 350;
    const cx = w / 2, cy = h / 2;

    // Separate node types for layout
    const agentNodes = nodes.filter(n => n.type === 'node');
    const toolNodes = nodes.filter(n => n.type === 'tool');

    // Layout: agents in inner ring, tools in outer ring
    const positions = new Map();
    agentNodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(agentNodes.length, 1) - Math.PI / 2;
      const rx = Math.min(w, h) * 0.2;
      positions.set(n.id, { x: cx + rx * Math.cos(angle), y: cy + rx * Math.sin(angle), node: n });
    });
    toolNodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(toolNodes.length, 1) - Math.PI / 2 + 0.3;
      const rx = Math.min(w, h) * 0.38;
      positions.set(n.id, { x: cx + rx * Math.cos(angle), y: cy + rx * Math.sin(angle), node: n });
    });

    let svg = '<svg viewBox="0 0 ' + w + ' ' + h + '">';

    // Draw edges with weight-based opacity
    const maxWeight = Math.max(...edges.map(e => e.weight || 1), 1);
    for (const e of edges) {
      const from = positions.get(e.source);
      const to = positions.get(e.target);
      if (from && to) {
        const opacity = 0.05 + ((e.weight || 1) / maxWeight) * 0.3;
        const sw = 1 + ((e.weight || 1) / maxWeight) * 2;
        svg += '<line x1="' + from.x + '" y1="' + from.y + '" x2="' + to.x + '" y2="' + to.y + '" stroke="rgba(99,102,241,' + opacity + ')" stroke-width="' + sw.toFixed(1) + '" data-edge="' + e.source + '->' + e.target + '" data-weight="' + (e.weight||1) + '"/>';
      }
    }

    // Draw nodes
    for (const [id, p] of positions) {
      const n = p.node;
      const isAgent = n.type === 'node';
      const color = isAgent ? ((n.status || '').toLowerCase() === 'online' ? '#22c55e' : '#ef4444') : '#6366f1';
      const r = isAgent ? 10 : 7;
      svg += '<g class="topo-node" data-topo-id="' + escapeHtml(id) + '" data-topo-type="' + escapeHtml(n.type||'') + '" data-topo-label="' + escapeHtml(n.label || n.hostname || id) + '">';
      svg += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="' + color + '" opacity="0.85"/>';
      svg += '<text x="' + p.x + '" y="' + (p.y + r + 14) + '" fill="#a1a1aa" font-size="' + (isAgent ? 11 : 9) + '" text-anchor="middle">' + escapeHtml(n.label || n.hostname || id) + '</text>';
      svg += '</g>';
    }

    svg += '</svg>';
    container.innerHTML = svg + '<div class="topo-tooltip" id="topo-tooltip" style="display:none"></div>';

    // Interactive: hover tooltip + click
    container.querySelectorAll('.topo-node').forEach(g => {
      g.addEventListener('mouseenter', function(ev) {
        const tip = document.getElementById('topo-tooltip');
        const label = g.dataset.topoLabel || g.dataset.topoId;
        const type = g.dataset.topoType === 'node' ? 'Agent Node' : 'Tool';
        tip.innerHTML = '<div class="font-semibold">' + escapeHtml(label) + '</div><div class="text-xs text-muted">' + type + '</div>';
        tip.style.display = 'block';
        const rect = container.getBoundingClientRect();
        tip.style.left = (ev.clientX - rect.left + 10) + 'px';
        tip.style.top = (ev.clientY - rect.top - 30) + 'px';
      });
      g.addEventListener('mouseleave', function() {
        document.getElementById('topo-tooltip').style.display = 'none';
      });
      g.addEventListener('click', function() {
        const id = g.dataset.topoId;
        if (g.dataset.topoType === 'node') openNodeDetail(id);
      });
    });
  } catch {
    document.getElementById('fleet-topology').innerHTML = '<span class="text-muted">Could not load topology</span>';
  }
}

async function openNodeDetail(nodeId) {
  const panel = document.getElementById('fleet-detail');
  panel.classList.add('open');
  panel.innerHTML = `<div class="panel-header"><h2>Node Details</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-muted">Loading...</p>`;
  try {
    const node = await API.getNode(nodeId);
    const n = node.node || node;
    // Load blast radius
    let brHtml = '';
    try {
      const br = await API.getBlastRadius(nodeId);
      const b = br.blastRadius || {};
      brHtml = `
        <div class="blast-radius-card mb-4">
          <div class="br-header">Blast Radius Preview</div>
          <div class="br-stat"><span>Active Sessions</span><span>${(b.activeSessions || []).length}</span></div>
          <div class="br-stat"><span>Tokens at Risk</span><span>${(b.totalTokensAtRisk || 0).toLocaleString()}</span></div>
          <div class="br-stat"><span>Cost at Risk</span><span>$${(b.totalCostAtRisk || 0).toFixed(4)}</span></div>
          <div class="br-stat"><span>Connected Nodes</span><span>${(b.connectedNodes || []).length}</span></div>
          <div class="br-stat"><span>Affected Tools</span><span>${(b.affectedTools || []).length}</span></div>
        </div>`;
    } catch { /* blast radius optional */ }

    panel.innerHTML = `
      <div class="panel-header"><h2>${escapeHtml(n.hostname || n.id)}</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div>
      <div class="mb-4">
        ${statusBadge(n.status)}
        <span class="text-muted text-sm" style="margin-left:8px">${escapeHtml(n.os || '')}</span>
      </div>
      <div class="mb-4">
        <div class="text-secondary text-sm mb-2">Tailscale IP</div>
        <div class="text-mono">${escapeHtml(n.tailscaleIp || '--')}</div>
      </div>
      <div class="mb-4">
        <div class="text-secondary text-sm mb-2">Tags</div>
        <div>${(n.tags || []).map(t => `<span class="badge badge-neutral">${escapeHtml(t)}</span>`).join(' ') || 'None'}</div>
      </div>
      <div class="mb-4">
        <div class="text-secondary text-sm mb-2">Last Heartbeat</div>
        <div>${n.lastHeartbeat ? new Date(n.lastHeartbeat).toLocaleString() : '--'}</div>
      </div>
      <div class="mb-4">
        <div class="text-secondary text-sm mb-2">Active Sessions</div>
        <div>${n.sessions ?? '--'}</div>
      </div>
      ${brHtml}
      <div class="mt-6 flex gap-2">
        <button class="btn btn-ghost btn-sm" data-node-action="restart" data-node-id="${escapeHtml(n.id)}">Restart</button>
        <button class="btn btn-ghost btn-sm" data-node-action="drain" data-node-id="${escapeHtml(n.id)}">Drain</button>
        <button class="btn btn-danger btn-sm" data-node-action="kill" data-node-id="${escapeHtml(n.id)}">Kill</button>
      </div>
    `;
  } catch (err) {
    panel.innerHTML = `<div class="panel-header"><h2>Error</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-danger">${escapeHtml(err.message)}</p>`;
  }
}

async function handleNodeAction(nodeId, action) {
  if (action === 'kill') {
    App.showModal('Kill Node', `<p>Are you sure you want to kill node <strong>${truncId(nodeId)}</strong>? This will terminate all sessions.</p>`, [
      { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
      { label: 'Kill Node', class: 'btn btn-danger', action: async () => { try { await API.killNode(nodeId); App.hideModal(); App.showToast('Node killed', 'success'); loadFleetData(); } catch (e) { App.showToast(e.message, 'error'); } } }
    ]);
  } else {
    try {
      await API.nodeAction(nodeId, action);
      App.showToast(`Action "${action}" sent`, 'success');
    } catch (e) { App.showToast(e.message, 'error'); }
  }
}

/* ── Sessions Page ───────────────────────────────────── */

async function renderSessionsPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Sessions</h1>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" id="sessions-refresh">Refresh</button>
      </div>
    </div>
    <div class="filter-bar">
      <select id="filter-status"><option value="">All Status</option><option value="active">Active</option><option value="idle">Idle</option><option value="completed">Completed</option><option value="failed">Failed</option></select>
      <select id="filter-node"><option value="">All Nodes</option></select>
      <select id="filter-model"><option value="">All Models</option></select>
      <input type="text" id="filter-search" placeholder="Search sessions..." style="width:200px">
    </div>
    <div class="glass-card table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Session ID</th>
            <th>Node</th>
            <th>Status</th>
            <th>Provider / Model</th>
            <th>Tools</th>
            <th>Tokens</th>
            <th>Cost</th>
            <th>Drift</th>
            <th>Last Activity</th>
          </tr>
        </thead>
        <tbody id="sessions-table-body">
          <tr><td colspan="9" class="text-center text-muted p-4">Loading sessions...</td></tr>
        </tbody>
      </table>
    </div>
    <div id="session-detail" class="detail-panel"></div>
  `;

  loadSessionsData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    const row = e.target.closest('tr[data-session-id]');
    if (row) {
      openSessionDetail(row.dataset.sessionId);
      return;
    }
    if (e.target.id === 'sessions-refresh' || e.target.closest('#sessions-refresh')) {
      loadSessionsData();
      return;
    }
    if (e.target.closest('.panel-close')) {
      document.getElementById('session-detail')?.classList.remove('open');
      return;
    }
    const killBtn = e.target.closest('[data-kill-session]');
    if (killBtn) {
      const sid = killBtn.dataset.killSession;
      App.showModal('Kill Session', `<p>Terminate session <strong>${truncId(sid)}</strong>?</p>`, [
        { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
        { label: 'Kill', class: 'btn btn-danger', action: async () => { try { await API.killSession(sid); App.hideModal(); App.showToast('Session killed', 'success'); loadSessionsData(); } catch (e) { App.showToast(e.message, 'error'); } } }
      ]);
    }
    const compareBtn = e.target.closest('[data-compare-session]');
    if (compareBtn) {
      openSessionCompare(compareBtn.dataset.compareSession);
    }
    const replayBtn = e.target.closest('[data-replay-session]');
    if (replayBtn) {
      startSessionReplay(replayBtn.dataset.replaySession);
    }
    if (e.target.id === 'replay-play') { resumeReplay(); }
    if (e.target.id === 'replay-pause') { pauseReplay(); }
  });

  // Filter listeners
  ['filter-status', 'filter-node', 'filter-model', 'filter-search'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.addEventListener('input', () => filterSessions());
  });
}

let _sessionsCache = [];

async function loadSessionsData() {
  try {
    const resp = await API.getSessions();
    _sessionsCache = resp.sessions || resp || [];
    renderSessionsTable(_sessionsCache);
  } catch (err) {
    document.getElementById('sessions-table-body').innerHTML =
      `<tr><td colspan="9" class="text-center text-danger p-4">Failed: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderSessionsTable(sessions) {
  const tbody = document.getElementById('sessions-table-body');
  if (!sessions.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted p-4">No sessions found</td></tr>';
    return;
  }
  tbody.innerHTML = sessions.map(s => {
    const drift = s.driftScore ?? 0;
    return `
      <tr class="clickable" data-session-id="${escapeHtml(s.id)}">
        <td><span class="text-mono truncate" title="${escapeHtml(s.id)}">${truncId(s.id)}</span></td>
        <td class="text-sm">${escapeHtml(s.node || '--')}</td>
        <td>${statusBadge(s.status)}</td>
        <td class="text-sm">${s.provider ? escapeHtml(s.provider) + ' / ' : ''}${escapeHtml(s.model || '--')}</td>
        <td class="text-sm text-muted">${s.toolsUsed ?? '--'}</td>
        <td class="text-sm text-mono">${s.tokens != null ? s.tokens.toLocaleString() : '--'}</td>
        <td class="text-sm">${s.cost != null ? '$' + s.cost.toFixed(4) : '--'}</td>
        <td style="min-width:80px">
          <div class="drift-meter"><div class="drift-fill ${driftClass(drift)}" style="width:${drift}%"></div></div>
          <span class="text-xs text-muted">${drift}%</span>
        </td>
        <td class="text-muted text-sm">${timeAgo(s.lastActivity)}</td>
      </tr>
    `;
  }).join('');
}

function filterSessions() {
  const status = document.getElementById('filter-status')?.value || '';
  const node = document.getElementById('filter-node')?.value || '';
  const model = document.getElementById('filter-model')?.value || '';
  const search = (document.getElementById('filter-search')?.value || '').toLowerCase();

  const filtered = _sessionsCache.filter(s => {
    if (status && (s.status || '').toLowerCase() !== status) return false;
    if (node && s.node !== node) return false;
    if (model && s.model !== model) return false;
    if (search && !JSON.stringify(s).toLowerCase().includes(search)) return false;
    return true;
  });
  renderSessionsTable(filtered);
}

async function openSessionDetail(sessionId) {
  const panel = document.getElementById('session-detail');
  panel.classList.add('open');
  panel.innerHTML = `<div class="panel-header"><h2>Session</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-muted">Loading...</p>`;
  try {
    const resp = await API.getSession(sessionId);
    const s = resp.session || resp;
    let timelineHtml = '';
    try {
      const tlResp = await API.getSessionTimeline(sessionId);
      const events = tlResp.events || tlResp || [];
      timelineHtml = `<div class="section-title mt-6">Timeline</div><div class="timeline">${events.map(e => `
        <div class="timeline-item">
          <div class="tl-time">${e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : ''}</div>
          <div class="tl-type">${escapeHtml(e.type || e.event || '')}</div>
          <div class="tl-detail">${escapeHtml(e.detail || e.message || '')}</div>
        </div>
      `).join('')}</div>`;
    } catch { /* timeline optional */ }

    // Load blast radius for this session
    let blastHtml = '';
    try {
      const br = await API.getSessionBlastRadius(sessionId);
      const b = br.blastRadius || {};
      blastHtml = `
        <div class="blast-radius-card mb-4">
          <div class="br-header">Blast Radius</div>
          <div class="br-stat"><span>Events</span><span>${b.eventsCount || 0}</span></div>
          <div class="br-stat"><span>Tools Used</span><span>${escapeHtml((b.toolsUsed || []).join(', ') || 'None')}</span></div>
          <div class="br-stat"><span>Files Accessed</span><span>${(b.filesAccessed || []).length}</span></div>
          <div class="br-stat"><span>Cost at Risk</span><span>$${(b.cost || 0).toFixed(4)}</span></div>
        </div>`;
    } catch { /* blast radius optional */ }

    // Drift score breakdown
    const drift = s.driftScore ?? 0;
    const driftFactorsHtml = s.driftFactors ? `
      <div class="drift-reasons mt-4 mb-4">
        <div class="text-secondary text-sm mb-2">Drift Score Factors</div>
        ${Object.entries(s.driftFactors || {}).map(([name, val]) => {
          const cls = val < 5 ? 'df-low' : val < 12 ? 'df-medium' : 'df-high';
          return '<div class="drift-factor"><span class="text-sm" style="min-width:110px">' + escapeHtml(name) + '</span><div class="drift-factor-bar"><div class="drift-factor-fill ' + cls + '" style="width:' + (val * 5) + '%"></div></div><span class="text-xs text-muted">' + val + '/20</span></div>';
        }).join('')}
        ${(s.driftReasons || []).map(r => '<div class="drift-reason-item">' + escapeHtml(r) + '</div>').join('')}
      </div>` : '';

    panel.innerHTML = `
      <div class="panel-header">
        <h2>Session ${truncId(s.id)}</h2>
        <button class="btn-icon panel-close" title="Close">&#x2715;</button>
      </div>
      <div class="mb-4">${statusBadge(s.status)}</div>
      <div class="grid-2 mb-4">
        <div><span class="text-secondary text-sm">Node</span><div>${escapeHtml(s.node || '--')}</div></div>
        <div><span class="text-secondary text-sm">Model</span><div>${s.provider ? escapeHtml(s.provider) + '/' : ''}${escapeHtml(s.model || '--')}</div></div>
        <div><span class="text-secondary text-sm">Tokens</span><div class="text-mono">${s.tokens != null ? s.tokens.toLocaleString() : '--'}</div></div>
        <div><span class="text-secondary text-sm">Cost</span><div>${s.cost != null ? '$' + s.cost.toFixed(4) : '--'}</div></div>
        <div><span class="text-secondary text-sm">Drift Score</span><div><div class="drift-meter"><div class="drift-fill ${driftClass(drift)}" style="width:${drift}%"></div></div><span class="text-xs text-muted">${drift}%</span></div></div>
        <div><span class="text-secondary text-sm">Tools Used</span><div>${s.toolsUsed ?? '--'}</div></div>
      </div>
      ${driftFactorsHtml}
      ${blastHtml}
      <div class="flex gap-2 mb-4">
        <button class="btn btn-ghost btn-sm" data-compare-session="${escapeHtml(s.id)}">Compare</button>
        <button class="btn btn-primary btn-sm" data-replay-session="${escapeHtml(s.id)}">Replay</button>
        <button class="btn btn-danger btn-sm" data-kill-session="${escapeHtml(s.id)}">Kill Session</button>
      </div>
      <div id="replay-container"></div>
      ${timelineHtml}
    `;
  } catch (err) {
    panel.innerHTML = `<div class="panel-header"><h2>Error</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-danger">${escapeHtml(err.message)}</p>`;
  }
}

let _replayInterval = null;
let _replayData = [];

async function startSessionReplay(sessionId) {
  const container = document.getElementById('replay-container');
  if (!container) return;
  container.innerHTML = '<div class="text-muted text-sm">Loading replay data...</div>';
  try {
    const resp = await API.getSessionReplay(sessionId);
    _replayData = resp.replay || [];
    if (!_replayData.length) {
      container.innerHTML = '<div class="text-muted text-sm">No events to replay</div>';
      return;
    }
    container.innerHTML =
      '<div class="replay-controls">' +
      '<button class="btn btn-sm btn-primary" id="replay-play">Play</button>' +
      '<button class="btn btn-sm btn-ghost" id="replay-pause">Pause</button>' +
      '<input type="range" id="replay-scrubber" min="0" max="' + (_replayData.length - 1) + '" value="0">' +
      '<span class="replay-step" id="replay-step-label">1 / ' + _replayData.length + '</span>' +
      '</div>';
    const scrubber = document.getElementById('replay-scrubber');
    if (scrubber) {
      scrubber.addEventListener('input', function() {
        highlightReplayStep(parseInt(this.value, 10));
      });
    }
    highlightReplayStep(0);
  } catch (err) {
    container.innerHTML = '<div class="text-danger text-sm">' + escapeHtml(err.message) + '</div>';
  }
}

function highlightReplayStep(index) {
  const items = document.querySelectorAll('.timeline-item');
  items.forEach(el => el.classList.remove('replay-active'));
  if (items[index]) {
    items[index].classList.add('replay-active');
    items[index].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  const label = document.getElementById('replay-step-label');
  if (label) label.textContent = (index + 1) + ' / ' + _replayData.length;
  const scrubber = document.getElementById('replay-scrubber');
  if (scrubber) scrubber.value = index;
}

function resumeReplay() {
  pauseReplay();
  const scrubber = document.getElementById('replay-scrubber');
  if (!scrubber) return;
  _replayInterval = setInterval(function() {
    let current = parseInt(scrubber.value, 10);
    if (current >= _replayData.length - 1) { pauseReplay(); return; }
    highlightReplayStep(current + 1);
  }, 800);
}

function pauseReplay() {
  if (_replayInterval) { clearInterval(_replayInterval); _replayInterval = null; }
}

async function openSessionCompare(sessionId) {
  const otherId = prompt('Enter session ID to compare with:');
  if (!otherId) return;
  try {
    const result = await API.compareSessions(sessionId, otherId);
    const a = result.comparison ? result.comparison.a : (result.left || {});
    const b = result.comparison ? result.comparison.b : (result.right || {});

    // Build visual diff of key metrics
    function diffRow(label, valA, valB) {
      const cls = valA === valB ? 'diff-same' : (valA > valB ? 'diff-add' : 'diff-remove');
      return '<div class="diff-line ' + cls + '"><span style="min-width:120px;display:inline-block">' + label + '</span> ' + valA + ' vs ' + valB + '</div>';
    }
    const summaryA = a.summary || a;
    const summaryB = b.summary || b;
    const diffHtml =
      diffRow('Events', a.events || 0, b.events || 0) +
      diffRow('Tool Calls', summaryA.toolCalls || 0, summaryB.toolCalls || 0) +
      diffRow('Errors', summaryA.errors || 0, summaryB.errors || 0) +
      diffRow('Tokens', summaryA.tokens || 0, summaryB.tokens || 0) +
      diffRow('Cost', '$' + (summaryA.cost || 0).toFixed(4), '$' + (summaryB.cost || 0).toFixed(4)) +
      diffRow('Drift', (summaryA.driftScore || 0) + '%', (summaryB.driftScore || 0) + '%') +
      diffRow('Status', summaryA.status || '--', summaryB.status || '--');

    App.showModal('Session Comparison', `
      <div class="compare-grid">
        <div class="compare-col glass-card">
          <h4>Session A: ${truncId(a.sessionId || sessionId)}</h4>
          <div class="mb-4">
            <div class="text-sm text-secondary">Node: ${escapeHtml(summaryA.nodeId || '--')}</div>
            <div class="text-sm text-secondary">Model: ${escapeHtml(summaryA.model || '--')}</div>
            <div class="text-sm text-secondary">Started: ${summaryA.startedAt ? new Date(summaryA.startedAt).toLocaleString() : '--'}</div>
          </div>
        </div>
        <div class="compare-col glass-card">
          <h4>Session B: ${truncId(b.sessionId || otherId)}</h4>
          <div class="mb-4">
            <div class="text-sm text-secondary">Node: ${escapeHtml(summaryB.nodeId || '--')}</div>
            <div class="text-sm text-secondary">Model: ${escapeHtml(summaryB.model || '--')}</div>
            <div class="text-sm text-secondary">Started: ${summaryB.startedAt ? new Date(summaryB.startedAt).toLocaleString() : '--'}</div>
          </div>
        </div>
      </div>
      <div class="section-title mt-4">Metric Comparison</div>
      <div class="diff-preview">${diffHtml}</div>
    `, [{ label: 'Close', class: 'btn btn-ghost', action: () => App.hideModal() }]);
  } catch (e) { App.showToast(e.message, 'error'); }
}

/* ── Live Feed Page ──────────────────────────────────── */

async function renderLiveFeedPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Live Feed</h1>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" id="feed-toggle-pause">Pause (Space)</button>
        <button class="btn btn-ghost btn-sm" id="feed-clear">Clear</button>
      </div>
    </div>
    <div class="filter-bar">
      <div class="feed-status">
        <div class="status-dot" id="feed-status-dot"></div>
        <span class="text-sm text-secondary" id="feed-status-text">Connecting...</span>
      </div>
      <select id="feed-filter-severity">
        <option value="">All Severity</option>
        <option value="info">Info</option>
        <option value="warn">Warning</option>
        <option value="error">Error</option>
      </select>
      <select id="feed-filter-type">
        <option value="">All Types</option>
        <option value="tool_call">Tool Call</option>
        <option value="token_usage">Token Usage</option>
        <option value="heartbeat">Heartbeat</option>
        <option value="session_start">Session Start</option>
        <option value="session_end">Session End</option>
        <option value="tripwire">Tripwire</option>
      </select>
      <input type="text" id="feed-filter-node" placeholder="Node..." style="width:120px">
      <input type="text" id="feed-filter-session" placeholder="Session..." style="width:120px">
    </div>
    <div class="section-title flex items-center justify-between">
      <span>Activity (Last 30 Days)</span>
      <span id="streak-badge"></span>
    </div>
    <div class="glass-card p-4 mb-4">
      <div class="heatmap-grid heatmap-30d" id="heatmap-grid"></div>
      <div class="heatmap-label-row" id="heatmap-labels"></div>
    </div>
    <div class="feed-container glass-card" id="feed-items"></div>
  `;

  loadHeatmapData();

  SSE.connect('livefeed', '/api/events/stream', {
    onOpen() {
      const dot = document.getElementById('feed-status-dot');
      const txt = document.getElementById('feed-status-text');
      if (dot) dot.classList.remove('disconnected');
      if (txt) txt.textContent = 'Connected';
    },
    onEvent(data) {
      appendFeedItem(data);
    },
    onError() {
      const dot = document.getElementById('feed-status-dot');
      const txt = document.getElementById('feed-status-text');
      if (dot) dot.classList.add('disconnected');
      if (txt) txt.textContent = 'Reconnecting...';
    }
  });

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) {
      el.removeEventListener('click', handler);
      SSE.disconnect('livefeed');
      return;
    }
    if (e.target.id === 'feed-toggle-pause' || e.target.closest('#feed-toggle-pause')) {
      toggleFeedPause();
    }
    if (e.target.id === 'feed-clear' || e.target.closest('#feed-clear')) {
      const items = document.getElementById('feed-items');
      if (items) items.innerHTML = '';
    }
  });
}

function appendFeedItem(data) {
  const container = document.getElementById('feed-items');
  if (!container) return;

  // Apply filters
  const sevFilter = document.getElementById('feed-filter-severity')?.value || '';
  const typeFilter = document.getElementById('feed-filter-type')?.value || '';
  const nodeFilter = (document.getElementById('feed-filter-node')?.value || '').toLowerCase();
  const sessionFilter = (document.getElementById('feed-filter-session')?.value || '').toLowerCase();

  const severity = (data.severity || data.level || 'info').toLowerCase();
  const type = data.type || data.event || '';
  const node = data.node || data.nodeId || '';
  const session = data.session || data.sessionId || '';

  if (sevFilter && severity !== sevFilter) return;
  if (typeFilter && type !== typeFilter) return;
  if (nodeFilter && !node.toLowerCase().includes(nodeFilter)) return;
  if (sessionFilter && !session.toLowerCase().includes(sessionFilter)) return;

  const ts = data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = `feed-item severity-${severity}`;
  div.innerHTML = `<span class="feed-time">${ts}</span>` +
    (node ? `<span class="feed-node">${escapeHtml(node)}</span>` : '') +
    (session ? `<span class="feed-session">${truncId(session)}</span>` : '') +
    `<span class="feed-type">${escapeHtml(type)}</span>` +
    `<span>${escapeHtml(data.message || data.detail || JSON.stringify(data.data || ''))}</span>`;

  container.appendChild(div);

  // Auto-scroll if near bottom
  if (container.scrollHeight - container.scrollTop - container.clientHeight < 100) {
    container.scrollTop = container.scrollHeight;
  }

  // Cap items
  while (container.children.length > 500) {
    container.removeChild(container.firstChild);
  }
}

function toggleFeedPause() {
  const btn = document.getElementById('feed-toggle-pause');
  if (SSE.isPaused('livefeed')) {
    SSE.resume('livefeed');
    if (btn) btn.textContent = 'Pause (Space)';
  } else {
    SSE.pause('livefeed');
    if (btn) btn.textContent = 'Resume (Space)';
  }
}

async function loadHeatmapData() {
  try {
    const [heatResp, streakResp] = await Promise.allSettled([API.getHeatmap(), API.getStreak()]);

    if (heatResp.status === 'fulfilled') {
      const heatmap = heatResp.value.heatmap || {};
      const max = heatResp.value.max || 1;
      const grid = document.getElementById('heatmap-grid');
      const labels = document.getElementById('heatmap-labels');
      if (!grid) return;

      const days = Object.keys(heatmap).sort();
      grid.innerHTML = days.map(date => {
        const count = heatmap[date] || 0;
        let level = '';
        if (count > 0 && max > 0) {
          const pct = count / max;
          if (pct <= 0.25) level = 'level-1';
          else if (pct <= 0.5) level = 'level-2';
          else if (pct <= 0.75) level = 'level-3';
          else level = 'level-4';
        }
        return '<div class="heatmap-cell ' + level + '" title="' + date + ': ' + count + ' events"></div>';
      }).join('');

      labels.innerHTML = days.map((date, i) => {
        if (i % 5 === 0) return '<span>' + date.slice(5) + '</span>';
        return '<span></span>';
      }).join('');
    }

    // Streak badge
    if (streakResp.status === 'fulfilled') {
      const s = streakResp.value.streak || {};
      const badge = document.getElementById('streak-badge');
      if (badge && s.current > 0) {
        badge.innerHTML = '<span class="streak-badge"><span class="streak-fire">&#x1F525;</span> ' + s.current + ' day streak (longest: ' + s.longest + ')</span>';
      }
    }
  } catch { /* ignore heatmap errors */ }
}

/* ── Usage Page ──────────────────────────────────────── */

async function renderUsagePage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Usage & Costs</h1>
      <div class="page-actions">
        <div class="window-selector" id="usage-window-selector">
          <button data-window="1h">1h</button>
          <button data-window="24h" class="active">24h</button>
          <button data-window="7d">7d</button>
        </div>
        <button class="btn btn-ghost btn-sm" id="usage-refresh">Refresh</button>
      </div>
    </div>
    <div id="usage-alerts-banner"></div>
    <div class="stats-grid" id="usage-totals"></div>
    <div class="tabs" id="usage-tabs"></div>
    <div id="usage-tab-content"></div>
    <div class="section-title mt-6">Cost Breakdown</div>
    <div class="chart-container" id="usage-chart"><div class="bar-chart" id="usage-bars"></div></div>
    <div class="section-title mt-6">Alerts</div>
    <div id="usage-alerts" class="mb-4"></div>
  `;

  loadUsageData();
  loadUsageAlerts();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }
    if (e.target.id === 'usage-refresh') { loadUsageData(); loadUsageAlerts(); }
    const tab = e.target.closest('.tab-btn[data-provider]');
    if (tab) {
      document.querySelectorAll('#usage-tabs .tab-btn').forEach(b => b.classList.remove('active'));
      tab.classList.add('active');
      renderProviderDetail(tab.dataset.provider);
    }
    const winBtn = e.target.closest('#usage-window-selector button');
    if (winBtn) {
      document.querySelectorAll('#usage-window-selector button').forEach(b => b.classList.remove('active'));
      winBtn.classList.add('active');
      loadRollingUsage(winBtn.dataset.window);
    }
  });
}

async function loadUsageData() {
  try {
    const usage = await API.getUsage();
    const d = usage.usage || usage;

    document.getElementById('usage-totals').innerHTML = `
      <div class="stat-card glass-card"><div class="stat-label">Total Requests</div><div class="stat-value">${(d.totalRequests || 0).toLocaleString()}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Total Tokens</div><div class="stat-value">${(d.totalTokens || 0).toLocaleString()}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Total Cost</div><div class="stat-value">$${(d.totalCost || 0).toFixed(2)}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Active Providers</div><div class="stat-value">${(d.providers || []).length}</div></div>
    `;

    const providers = d.providers || [];
    document.getElementById('usage-tabs').innerHTML = providers.map((p, i) =>
      `<button class="tab-btn ${i === 0 ? 'active' : ''}" data-provider="${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>`
    ).join('');

    if (providers.length) renderProviderDetail(providers[0].name);

    // Cost chart
    const bars = document.getElementById('usage-bars');
    if (bars && providers.length) {
      const maxCost = Math.max(...providers.map(p => p.cost || 0), 1);
      bars.innerHTML = providers.map(p => {
        const h = ((p.cost || 0) / maxCost) * 100;
        return `<div class="bar" style="height:${h}%"><div class="bar-label">${escapeHtml(p.name)}</div></div>`;
      }).join('');
    }

    // Alerts
    const alerts = d.alerts || [];
    document.getElementById('usage-alerts').innerHTML = alerts.length
      ? alerts.map(a => `<div class="feed-item severity-${escapeHtml(a.severity || 'warn')}">${escapeHtml(a.message)}</div>`).join('')
      : '<div class="text-muted text-sm">No active alerts</div>';
  } catch (err) {
    document.getElementById('usage-totals').innerHTML = `<div class="text-danger">${escapeHtml(err.message)}</div>`;
  }
}

async function renderProviderDetail(provider) {
  const container = document.getElementById('usage-tab-content');
  try {
    const resp = await API.getUsageBreakdown({ provider });
    const models = resp.models || resp.breakdown || [];
    container.innerHTML = `
      <div class="stats-grid">
        ${models.map(m => `
          <div class="stat-card glass-card">
            <div class="stat-label">${escapeHtml(m.model || m.name)}</div>
            <div class="stat-value text-sm">${(m.requests || 0).toLocaleString()} req</div>
            <div class="stat-sub">In: ${(m.tokensIn || 0).toLocaleString()} / Out: ${(m.tokensOut || 0).toLocaleString()}</div>
            <div class="stat-sub">$${(m.cost || 0).toFixed(4)}</div>
          </div>
        `).join('')}
      </div>
    `;
  } catch {
    container.innerHTML = '<div class="text-muted text-sm">No breakdown data available</div>';
  }
}

async function loadUsageAlerts() {
  try {
    const resp = await API.getUsageAlerts();
    const alerts = resp.alerts || [];
    const banner = document.getElementById('usage-alerts-banner');
    if (!banner) return;
    if (!alerts.length) {
      banner.innerHTML = '';
      return;
    }
    banner.innerHTML = alerts.map(a =>
      '<div class="alert-banner alert-' + escapeHtml(a.severity || 'warning') + '">' +
      '<strong>' + escapeHtml(a.type || '') + '</strong> ' + escapeHtml(a.message || '') +
      '</div>'
    ).join('');
  } catch { /* ignore */ }
}

async function loadRollingUsage(window) {
  try {
    const resp = await API.getUsageRolling(window);
    const totals = resp.totals || {};
    const providers = resp.providers || {};

    document.getElementById('usage-totals').innerHTML = [
      { label: 'Requests (' + (resp.window || window) + ')', value: (totals.requests || 0).toLocaleString() },
      { label: 'Tokens (' + (resp.window || window) + ')', value: (totals.tokens || 0).toLocaleString() },
      { label: 'Cost (' + (resp.window || window) + ')', value: '$' + (totals.cost || 0).toFixed(2) },
      { label: 'Providers', value: Object.keys(providers).length }
    ].map(i =>
      '<div class="stat-card glass-card"><div class="stat-label">' + i.label + '</div><div class="stat-value">' + i.value + '</div></div>'
    ).join('');

    const provNames = Object.keys(providers);
    document.getElementById('usage-tabs').innerHTML = provNames.map((name, i) =>
      '<button class="tab-btn ' + (i === 0 ? 'active' : '') + '" data-provider="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>'
    ).join('');

    if (provNames.length) {
      const first = providers[provNames[0]];
      const models = first.models || {};
      document.getElementById('usage-tab-content').innerHTML = '<div class="stats-grid">' +
        Object.entries(models).map(([model, m]) =>
          '<div class="stat-card glass-card">' +
          '<div class="stat-label">' + escapeHtml(model) + '</div>' +
          '<div class="stat-value text-sm">' + (m.requests || 0).toLocaleString() + ' req</div>' +
          '<div class="stat-sub">In: ' + (m.inputTokens || 0).toLocaleString() + ' / Out: ' + (m.outputTokens || 0).toLocaleString() + '</div>' +
          '<div class="stat-sub">$' + (m.cost || 0).toFixed(4) + '</div></div>'
        ).join('') + '</div>';
    }

    // Update chart
    const bars = document.getElementById('usage-bars');
    if (bars && provNames.length) {
      const maxCost = Math.max(...provNames.map(n => providers[n].totalCost || 0), 1);
      bars.innerHTML = provNames.map(n => {
        const h = ((providers[n].totalCost || 0) / maxCost) * 100;
        return '<div class="bar" style="height:' + h + '%"><div class="bar-label">' + escapeHtml(n) + '</div></div>';
      }).join('');
    }
  } catch { /* ignore */ }
}

/* ── Memory & Files Page ─────────────────────────────── */

async function renderMemoryPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Memory & Files</h1>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" id="memory-refresh">Refresh</button>
      </div>
    </div>
    <div class="split-view">
      <div class="file-tree glass-card" id="file-tree">
        <div class="text-muted text-sm p-4">Loading files...</div>
      </div>
      <div class="file-content glass-card" id="file-content">
        <div class="text-muted text-sm p-4">Select a file to view its contents</div>
      </div>
    </div>
    <div class="section-title mt-6">Git Activity</div>
    <div class="glass-card p-4" id="git-activity">
      <div class="text-muted text-sm">Loading git info...</div>
    </div>
  `;

  loadMemoryData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }
    if (e.target.id === 'memory-refresh') loadMemoryData();

    const fileItem = e.target.closest('.file-tree-item');
    if (fileItem) {
      document.querySelectorAll('.file-tree-item').forEach(i => i.classList.remove('active'));
      fileItem.classList.add('active');
      loadFileContent(fileItem.dataset.path);
    }

    if (e.target.id === 'file-edit-btn') {
      enableFileEdit();
    }
    if (e.target.id === 'file-save-btn') {
      saveFileContent();
    }
    if (e.target.id === 'file-cancel-btn') {
      const path = document.querySelector('.file-tree-item.active')?.dataset.path;
      if (path) loadFileContent(path);
    }
  });
}

async function loadMemoryData() {
  try {
    const [filesResp, gitResp] = await Promise.allSettled([API.getFiles(), API.getGit()]);

    const tree = document.getElementById('file-tree');
    if (filesResp.status === 'fulfilled') {
      const files = filesResp.value.files || filesResp.value || [];
      tree.innerHTML = files.map(f => {
        const name = typeof f === 'string' ? f : (f.path || f.name);
        const icon = name.endsWith('.md') ? '\u{1F4C4}' : '\u{1F4C1}';
        return `<div class="file-tree-item" data-path="${escapeHtml(name)}"><span class="file-icon">${icon}</span><span>${escapeHtml(name)}</span></div>`;
      }).join('') || '<div class="text-muted text-sm p-4">No files found</div>';
    } else {
      tree.innerHTML = '<div class="text-muted text-sm p-4">Could not load files</div>';
    }

    const gitEl = document.getElementById('git-activity');
    if (gitResp.status === 'fulfilled') {
      const git = gitResp.value.git || gitResp.value;
      const commits = git.recentCommits || git.commits || [];
      gitEl.innerHTML = `
        <div class="flex items-center justify-between mb-4">
          <div>
            <span class="text-secondary text-sm">Branch:</span>
            <span class="text-mono">${escapeHtml(git.branch || '--')}</span>
          </div>
          <div>${git.dirty ? '<span class="badge badge-warning">Dirty</span>' : '<span class="badge badge-online">Clean</span>'}</div>
        </div>
        ${commits.length ? `<div class="text-secondary text-sm mb-2">Recent Commits</div>` + commits.map(c => `
          <div class="feed-item severity-info">
            <span class="feed-time">${c.date ? new Date(c.date).toLocaleDateString() : ''}</span>
            <span class="text-mono text-sm" style="margin-right:8px">${escapeHtml((c.hash || c.sha || '').slice(0, 7))}</span>
            <span>${escapeHtml(c.message || '')}</span>
          </div>
        `).join('') : '<div class="text-muted text-sm">No commits</div>'}
      `;
    } else {
      gitEl.innerHTML = '<div class="text-muted text-sm">Could not load git info</div>';
    }
  } catch (err) {
    App.showToast('Failed to load memory data: ' + err.message, 'error');
  }
}

let _currentFileContent = '';

async function loadFileContent(path) {
  const el = document.getElementById('file-content');
  el.innerHTML = '<div class="text-muted text-sm p-4">Loading...</div>';
  try {
    const resp = await API.getFile(path);
    _currentFileContent = resp.content || resp.data || '';
    el.innerHTML = `
      <div class="flex items-center justify-between mb-4">
        <div class="text-sm font-semibold">${escapeHtml(path)}</div>
        <button class="btn btn-ghost btn-sm" id="file-edit-btn">Edit</button>
      </div>
      <pre>${escapeHtml(_currentFileContent)}</pre>
    `;
  } catch (err) {
    el.innerHTML = `<div class="text-danger text-sm p-4">${escapeHtml(err.message)}</div>`;
  }
}

function enableFileEdit() {
  const el = document.getElementById('file-content');
  const path = document.querySelector('.file-tree-item.active')?.dataset.path;
  if (!path) return;
  el.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <div class="text-sm font-semibold">${escapeHtml(path)}</div>
      <div class="flex gap-2">
        <button class="btn btn-ghost btn-sm" id="file-cancel-btn">Cancel</button>
        <button class="btn btn-primary btn-sm" id="file-save-btn">Save</button>
      </div>
    </div>
    <div class="form-group"><label>Reason for change</label><input type="text" id="file-edit-reason" style="width:100%" placeholder="Describe your change..."></div>
    <textarea id="file-edit-textarea" style="width:100%;min-height:300px;font-family:monospace;font-size:0.82rem">${escapeHtml(_currentFileContent)}</textarea>
  `;
}

async function saveFileContent() {
  const filePath = document.querySelector('.file-tree-item.active')?.dataset.path;
  const content = document.getElementById('file-edit-textarea')?.value;
  const reason = document.getElementById('file-edit-reason')?.value || '';
  if (!filePath || content == null) return;

  // Show diff preview before saving
  const oldLines = _currentFileContent.split('\n');
  const newLines = content.split('\n');
  let diffHtml = '';
  const maxLen = Math.max(oldLines.length, newLines.length);
  let hasChanges = false;
  for (let i = 0; i < maxLen; i++) {
    if (i >= oldLines.length) {
      diffHtml += '<div class="diff-line diff-add">+ ' + escapeHtml(newLines[i]) + '</div>';
      hasChanges = true;
    } else if (i >= newLines.length) {
      diffHtml += '<div class="diff-line diff-remove">- ' + escapeHtml(oldLines[i]) + '</div>';
      hasChanges = true;
    } else if (oldLines[i] !== newLines[i]) {
      diffHtml += '<div class="diff-line diff-remove">- ' + escapeHtml(oldLines[i]) + '</div>';
      diffHtml += '<div class="diff-line diff-add">+ ' + escapeHtml(newLines[i]) + '</div>';
      hasChanges = true;
    }
  }

  if (!hasChanges) {
    App.showToast('No changes detected', 'info');
    return;
  }

  App.showModal('Confirm Save', `
    <div class="text-sm text-secondary mb-2">Changes to <strong>${escapeHtml(filePath)}</strong>:</div>
    <div class="diff-preview">${diffHtml}</div>
    <div class="form-group"><label>Reason</label><div class="text-sm">${escapeHtml(reason || '(none)')}</div></div>
  `, [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Save Changes', class: 'btn btn-primary', action: async () => {
      try {
        await API.saveFile(filePath, content, reason);
        App.hideModal();
        App.showToast('File saved', 'success');
        loadFileContent(filePath);
      } catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Ops Page ────────────────────────────────────────── */

async function renderOpsPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Operations</h1>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" id="ops-refresh">Refresh</button>
      </div>
    </div>
    <div class="gauge-grid" id="ops-gauges"></div>
    <div class="section-title">24h Health History</div>
    <div class="chart-container mb-6" id="ops-health-chart"><div class="bar-chart" id="ops-health-bars"></div></div>
    <div class="grid-2 mb-6">
      <div>
        <div class="section-title">Log Viewer</div>
        <div class="flex gap-2 mb-2">
          <select id="log-source"><option value="supervisor">Supervisor</option><option value="proxy">Proxy</option><option value="gateway">Gateway</option><option value="cron">Cron</option></select>
          <button class="btn btn-ghost btn-sm" id="log-fetch">Fetch</button>
          <label class="flex items-center gap-2 text-sm text-secondary"><input type="checkbox" id="log-autotail" checked> Auto-tail</label>
        </div>
        <div class="log-viewer" id="log-output"><div class="text-muted">Select a source and click Fetch</div></div>
      </div>
      <div>
        <div class="section-title">Cron Jobs</div>
        <div class="glass-card table-wrapper">
          <table>
            <thead><tr><th>Job</th><th>Status</th><th>Next Run</th><th>Actions</th></tr></thead>
            <tbody id="cron-table-body"><tr><td colspan="4" class="text-muted text-center p-4">Loading...</td></tr></tbody>
          </table>
        </div>
        <div class="section-title mt-4">Run History</div>
        <div class="glass-card p-4" id="cron-history" style="max-height:200px;overflow-y:auto">
          <div class="text-muted text-sm">Loading history...</div>
        </div>
      </div>
    </div>
  `;

  loadOpsData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }
    if (e.target.id === 'ops-refresh') loadOpsData();
    if (e.target.id === 'log-fetch' || e.target.closest('#log-fetch')) fetchLogs();

    const cronRun = e.target.closest('[data-cron-run]');
    if (cronRun) {
      API.runCron(cronRun.dataset.cronRun).then(() => {
        App.showToast('Cron job triggered', 'success');
        loadCronData();
      }).catch(e => App.showToast(e.message, 'error'));
    }
    const cronToggle = e.target.closest('[data-cron-toggle]');
    if (cronToggle) {
      API.toggleCron(cronToggle.dataset.cronToggle).then(() => {
        loadCronData();
      }).catch(e => App.showToast(e.message, 'error'));
    }
  });
}

async function loadOpsData() {
  try {
    const [healthResp, histResp] = await Promise.allSettled([API.getHealth(), API.getHealthHistory()]);

    const gauges = document.getElementById('ops-gauges');
    if (healthResp.status === 'fulfilled') {
      const h = healthResp.value.health || healthResp.value;
      const items = [
        { label: 'CPU', value: h.cpu ?? 0, color: (h.cpu || 0) > 80 ? 'var(--accent-danger)' : 'var(--accent-primary)' },
        { label: 'RAM', value: h.ram ?? h.memory ?? 0, color: (h.ram || h.memory || 0) > 80 ? 'var(--accent-danger)' : 'var(--accent-info)' },
        { label: 'Disk', value: h.disk ?? 0, color: (h.disk || 0) > 80 ? 'var(--accent-danger)' : 'var(--accent-success)' },
      ];
      gauges.innerHTML = items.map(i => `
        <div class="gauge-card glass-card">
          <div class="gauge-label">${i.label}</div>
          <div class="gauge-value" style="color:${i.color}">${i.value}%</div>
          <div class="gauge-bar"><div class="gauge-bar-fill" style="width:${i.value}%;background:${i.color}"></div></div>
        </div>
      `).join('') + `
        <div class="gauge-card glass-card">
          <div class="gauge-label">Status</div>
          <div class="gauge-value">${statusBadge(h.status || 'healthy')}</div>
          <div class="text-muted text-sm mt-4">Uptime: ${h.uptime || '--'}</div>
        </div>
      `;
    }

    if (histResp.status === 'fulfilled') {
      const history = histResp.value.history || histResp.value || [];
      const bars = document.getElementById('ops-health-bars');
      if (bars && history.length) {
        const max = Math.max(...history.map(h => h.cpu || h.value || 0), 1);
        bars.innerHTML = history.map(h => {
          const v = h.cpu || h.value || 0;
          const pct = (v / max) * 100;
          return `<div class="bar" style="height:${pct}%" title="${h.time || ''}: ${v}%"><div class="bar-label">${h.hour || ''}</div></div>`;
        }).join('');
      }
    }

    loadCronData();
  } catch (err) {
    App.showToast('Failed to load ops data: ' + err.message, 'error');
  }
}

async function loadCronData() {
  try {
    const [cronResp, histResp] = await Promise.allSettled([API.getCron(), API.getCronHistory()]);

    if (cronResp.status === 'fulfilled') {
      const jobs = cronResp.value.jobs || cronResp.value || [];
      const tbody = document.getElementById('cron-table-body');
      tbody.innerHTML = jobs.length ? jobs.map(j => `
        <tr>
          <td class="font-semibold text-sm">${escapeHtml(j.name || j.id)}</td>
          <td>${j.enabled !== false ? '<span class="badge badge-online">Enabled</span>' : '<span class="badge badge-offline">Disabled</span>'}</td>
          <td class="text-muted text-sm">${j.nextRun ? new Date(j.nextRun).toLocaleString() : '--'}</td>
          <td>
            <button class="btn btn-ghost btn-sm" data-cron-run="${escapeHtml(j.id)}">Run</button>
            <button class="btn btn-ghost btn-sm" data-cron-toggle="${escapeHtml(j.id)}">${j.enabled !== false ? 'Disable' : 'Enable'}</button>
          </td>
        </tr>
      `).join('') : '<tr><td colspan="4" class="text-muted text-center p-4">No cron jobs</td></tr>';
    }

    const histEl = document.getElementById('cron-history');
    if (histEl && histResp.status === 'fulfilled') {
      const history = histResp.value.history || [];
      histEl.innerHTML = history.length ? history.reverse().map(h =>
        '<div class="cron-history-item"><span class="badge badge-online">' + escapeHtml(h.status || 'completed') + '</span><span class="text-sm font-semibold">' + escapeHtml(h.jobId || '--') + '</span><span class="text-muted text-sm">' + escapeHtml(h.triggeredBy || '') + '</span><span class="text-muted text-xs">' + timeAgo(h.triggeredAt) + '</span></div>'
      ).join('') : '<div class="text-muted text-sm">No run history</div>';
    }
  } catch { /* ignore */ }
}

async function fetchLogs() {
  const source = document.getElementById('log-source')?.value || 'supervisor';
  const output = document.getElementById('log-output');
  output.innerHTML = '<div class="text-muted">Fetching...</div>';
  try {
    const resp = await API.getLogs(source);
    const lines = resp.lines || resp.logs || [];
    output.innerHTML = lines.map(l => {
      const levelClass = l.includes('ERROR') ? 'log-level-error' : l.includes('WARN') ? 'log-level-warn' : 'log-level-info';
      return `<div class="log-line"><span class="${levelClass}">${escapeHtml(l)}</span></div>`;
    }).join('') || '<div class="text-muted">No logs</div>';
    const autoTail = document.getElementById('log-autotail');
    if (autoTail?.checked) output.scrollTop = output.scrollHeight;
  } catch (e) {
    output.innerHTML = `<div class="text-danger">${escapeHtml(e.message)}</div>`;
  }
}

/* ── Governance Page ─────────────────────────────────── */

async function renderGovernancePage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Governance</h1>
    </div>
    <div class="tabs">
      <button class="tab-btn active" data-gov-tab="policies">Policies</button>
      <button class="tab-btn" data-gov-tab="approvals">Approvals</button>
      <button class="tab-btn" data-gov-tab="tripwires">Tripwires</button>
      <button class="tab-btn" data-gov-tab="audit">Audit Log</button>
      <button class="tab-btn" data-gov-tab="evidence">Evidence</button>
      <button class="tab-btn" data-gov-tab="skills">Skills</button>
      <button class="tab-btn" data-gov-tab="access">Access Review</button>
    </div>
    <div id="gov-tab-content"></div>
  `;

  renderGovTab('policies');

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }
    const tab = e.target.closest('.tab-btn[data-gov-tab]');
    if (tab) {
      document.querySelectorAll('.tabs .tab-btn').forEach(b => b.classList.remove('active'));
      tab.classList.add('active');
      renderGovTab(tab.dataset.govTab);
    }

    // Approval actions
    const grantBtn = e.target.closest('[data-approve-grant]');
    if (grantBtn) {
      API.grantApproval(grantBtn.dataset.approveGrant).then(() => { App.showToast('Approved', 'success'); renderGovTab('approvals'); }).catch(e => App.showToast(e.message, 'error'));
    }
    const denyBtn = e.target.closest('[data-approve-deny]');
    if (denyBtn) {
      API.denyApproval(denyBtn.dataset.approveDeny).then(() => { App.showToast('Denied', 'success'); renderGovTab('approvals'); }).catch(e => App.showToast(e.message, 'error'));
    }

    // Skill actions
    const deployBtn = e.target.closest('[data-skill-deploy]');
    if (deployBtn) {
      API.deploySkill(deployBtn.dataset.skillDeploy).then(() => { App.showToast('Deployed', 'success'); renderGovTab('skills'); }).catch(e => App.showToast(e.message, 'error'));
    }
    const rollbackBtn = e.target.closest('[data-skill-rollback]');
    if (rollbackBtn) {
      API.rollbackSkill(rollbackBtn.dataset.skillRollback).then(() => { App.showToast('Rolled back', 'success'); renderGovTab('skills'); }).catch(e => App.showToast(e.message, 'error'));
    }

    // Policy simulate
    const simBtn = e.target.closest('[data-policy-simulate]');
    if (simBtn) {
      const sid = prompt('Enter session ID to simulate against:');
      if (sid) {
        API.simulatePolicy(simBtn.dataset.policySimulate, sid).then(res => {
          App.showModal('Simulation Result', `<pre class="text-sm" style="max-height:400px;overflow:auto">${JSON.stringify(res, null, 2)}</pre>`, [{ label: 'Close', class: 'btn btn-ghost', action: () => App.hideModal() }]);
        }).catch(e => App.showToast(e.message, 'error'));
      }
    }

    // Evidence export as ZIP
    if (e.target.id === 'evidence-export-btn') {
      const from = document.getElementById('evidence-from')?.value;
      const to = document.getElementById('evidence-to')?.value;
      App.showToast('Exporting evidence bundle...', 'info');
      API.exportEvidenceZip({ from, to }).then(() => {
        App.showToast('Evidence bundle downloaded', 'success');
      }).catch(e => App.showToast(e.message, 'error'));
    }

    // Audit export
    if (e.target.id === 'audit-export-btn') {
      App.showToast('Exporting audit log...', 'info');
    }
  });
}

async function renderGovTab(tab) {
  const container = document.getElementById('gov-tab-content');
  container.innerHTML = '<div class="text-muted p-4">Loading...</div>';

  try {
    switch (tab) {
      case 'policies': {
        const resp = await API.getPolicies();
        const policies = resp.policies || resp || [];
        container.innerHTML = `
          <div class="glass-card table-wrapper">
            <table>
              <thead><tr><th>Policy</th><th>Status</th><th>Type</th><th>Description</th><th>Actions</th></tr></thead>
              <tbody>${policies.map(p => `
                <tr>
                  <td class="font-semibold">${escapeHtml(p.name || p.id)}</td>
                  <td>${p.enabled !== false ? '<span class="badge badge-online">Active</span>' : '<span class="badge badge-offline">Disabled</span>'}</td>
                  <td class="text-sm text-secondary">${escapeHtml(p.type || '--')}</td>
                  <td class="text-sm text-muted">${escapeHtml(p.description || '')}</td>
                  <td>
                    <button class="btn btn-ghost btn-sm" data-policy-simulate="${escapeHtml(p.id)}">Simulate</button>
                  </td>
                </tr>
              `).join('')}</tbody>
            </table>
          </div>
        `;
        break;
      }
      case 'approvals': {
        const resp = await API.getApprovals();
        const approvals = resp.approvals || resp || [];
        container.innerHTML = `
          <div class="glass-card table-wrapper">
            <table>
              <thead><tr><th>Request</th><th>Requester</th><th>Type</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
              <tbody>${approvals.length ? approvals.map(a => `
                <tr>
                  <td class="font-semibold text-sm">${escapeHtml(a.description || a.id)}</td>
                  <td class="text-sm">${escapeHtml(a.requester || '--')}</td>
                  <td class="text-sm text-secondary">${escapeHtml(a.type || '--')}</td>
                  <td>${statusBadge(a.status)}</td>
                  <td class="text-muted text-sm">${timeAgo(a.createdAt)}</td>
                  <td>${a.status === 'pending' ? `
                    <button class="btn btn-success btn-sm" data-approve-grant="${escapeHtml(a.id)}">Grant</button>
                    <button class="btn btn-danger btn-sm" data-approve-deny="${escapeHtml(a.id)}">Deny</button>
                  ` : '--'}</td>
                </tr>
              `).join('') : '<tr><td colspan="6" class="text-muted text-center p-4">No pending approvals</td></tr>'}</tbody>
            </table>
          </div>
        `;
        break;
      }
      case 'tripwires': {
        const [twResp, trigResp] = await Promise.allSettled([API.getTripwires(), API.getTripwireTriggers()]);
        const tripwires = twResp.status === 'fulfilled' ? (twResp.value.tripwires || twResp.value || []) : [];
        const triggers = trigResp.status === 'fulfilled' ? (trigResp.value.triggers || trigResp.value || []) : [];
        container.innerHTML = `
          <div class="grid-2">
            <div>
              <div class="section-title">Configuration</div>
              <div class="glass-card table-wrapper">
                <table>
                  <thead><tr><th>Tripwire</th><th>Status</th><th>Threshold</th></tr></thead>
                  <tbody>${tripwires.map(t => `
                    <tr>
                      <td class="font-semibold text-sm">${escapeHtml(t.name || t.id)}</td>
                      <td>${t.enabled !== false ? '<span class="badge badge-online">Active</span>' : '<span class="badge badge-offline">Disabled</span>'}</td>
                      <td class="text-sm text-secondary">${escapeHtml(t.threshold || '--')}</td>
                    </tr>
                  `).join('')}</tbody>
                </table>
              </div>
            </div>
            <div>
              <div class="section-title">Recent Triggers</div>
              <div class="glass-card p-4" style="max-height:400px;overflow-y:auto">
                ${triggers.length ? triggers.map(t => `
                  <div class="feed-item severity-${escapeHtml(t.severity || 'warn')}">
                    <span class="feed-time">${timeAgo(t.triggeredAt)}</span>
                    <span class="font-semibold">${escapeHtml(t.tripwire || '')}</span>: ${escapeHtml(t.message || t.detail || '')}
                  </div>
                `).join('') : '<div class="text-muted text-sm">No recent triggers</div>'}
              </div>
            </div>
          </div>
        `;
        break;
      }
      case 'audit': {
        const resp = await API.getAuditLog({});
        const entries = resp.entries || resp.events || resp || [];
        container.innerHTML = `
          <div class="flex items-center justify-between mb-4">
            <div class="filter-bar">
              <input type="text" placeholder="Filter audit log..." id="audit-filter" style="width:250px">
            </div>
            <button class="btn btn-ghost btn-sm" id="audit-export-btn">Export</button>
          </div>
          <div class="glass-card table-wrapper">
            <table>
              <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Detail</th></tr></thead>
              <tbody>${entries.length ? entries.map(e => `
                <tr>
                  <td class="text-muted text-sm">${e.timestamp ? new Date(e.timestamp).toLocaleString() : '--'}</td>
                  <td class="text-sm">${escapeHtml(e.actor || e.user || '--')}</td>
                  <td class="text-sm font-semibold">${escapeHtml(e.action || '--')}</td>
                  <td class="text-sm text-secondary">${escapeHtml(e.resource || '--')}</td>
                  <td class="text-sm text-muted">${escapeHtml(e.detail || e.message || '')}</td>
                </tr>
              `).join('') : '<tr><td colspan="5" class="text-muted text-center p-4">No audit entries</td></tr>'}</tbody>
            </table>
          </div>
        `;
        break;
      }
      case 'evidence': {
        container.innerHTML = `
          <div class="grid-2">
            <div class="glass-card p-4">
              <div class="section-title">Export Evidence Bundle</div>
              <div class="form-group"><label>From Date</label><input type="date" id="evidence-from"></div>
              <div class="form-group"><label>To Date</label><input type="date" id="evidence-to"></div>
              <button class="btn btn-primary btn-sm" id="evidence-export-btn">Export</button>
            </div>
            <div class="glass-card p-4">
              <div class="section-title">Verify Evidence Bundle</div>
              <div class="form-group"><label>Upload Bundle (JSON)</label><textarea id="evidence-verify-input" placeholder="Paste evidence bundle JSON..."></textarea></div>
              <button class="btn btn-ghost btn-sm" onclick="(async()=>{try{const b=JSON.parse(document.getElementById('evidence-verify-input').value);const r=await API.verifyEvidence(b);App.showToast(r.valid?'Evidence verified':'Verification failed',r.valid?'success':'error');}catch(e){App.showToast(e.message,'error');}})()">Verify</button>
            </div>
          </div>
        `;
        break;
      }
      case 'skills': {
        const resp = await API.getSkills();
        const skills = resp.skills || resp || [];
        container.innerHTML = `
          <div class="glass-card table-wrapper">
            <table>
              <thead><tr><th>Skill</th><th>Version</th><th>Status</th><th>Canary</th><th>Actions</th></tr></thead>
              <tbody>${skills.length ? skills.map(s => `
                <tr>
                  <td class="font-semibold">${escapeHtml(s.name || s.id)}</td>
                  <td class="text-mono text-sm">${escapeHtml(s.version || '--')}</td>
                  <td>${statusBadge(s.status)}</td>
                  <td>${s.canary ? '<span class="badge badge-warning">Canary</span>' : '<span class="badge badge-neutral">Stable</span>'}</td>
                  <td>
                    <button class="btn btn-primary btn-sm" data-skill-deploy="${escapeHtml(s.id)}">Deploy</button>
                    <button class="btn btn-ghost btn-sm" data-skill-rollback="${escapeHtml(s.id)}">Rollback</button>
                  </td>
                </tr>
              `).join('') : '<tr><td colspan="5" class="text-muted text-center p-4">No skills registered</td></tr>'}</tbody>
            </table>
          </div>
        `;
        break;
      }
      case 'access': {
        let accessHtml = '<tr><td colspan="5" class="text-muted text-center p-4">Loading...</td></tr>';
        try {
          const resp = await fetch('/api/governance/access-review', { credentials: 'same-origin' }).then(r => r.json());
          const users = resp.users || [];
          accessHtml = users.length ? users.map(u => `
            <tr>
              <td class="font-semibold">${escapeHtml(u.username || '--')}</td>
              <td><span class="badge badge-neutral">${escapeHtml(u.role || '--')}</span></td>
              <td>${u.mfaEnabled ? '<span class="badge badge-online">Enabled</span>' : '<span class="badge badge-offline">Disabled</span>'}</td>
              <td class="text-muted text-sm">${u.lastLogin ? timeAgo(u.lastLogin) : 'Never'}</td>
              <td>${statusBadge('active')}</td>
            </tr>
          `).join('') : '<tr><td colspan="5" class="text-muted text-center p-4">No users found</td></tr>';
        } catch { accessHtml = '<tr><td colspan="5" class="text-muted text-center p-4">Could not load access review data</td></tr>'; }
        container.innerHTML = `
          <div class="glass-card table-wrapper">
            <table>
              <thead><tr><th>User</th><th>Role</th><th>MFA</th><th>Last Login</th><th>Status</th></tr></thead>
              <tbody>${accessHtml}</tbody>
            </table>
          </div>
        `;
        break;
      }
      default:
        container.innerHTML = '<div class="text-muted p-4">Unknown tab</div>';
    }
  } catch (err) {
    container.innerHTML = `<div class="text-danger p-4">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

/* ===================================================================
   Agents Page
   =================================================================== */

function agentTypeBadge(type) {
  const t = (type || 'unknown').toLowerCase();
  const colors = {
    claude: '#6366f1', codex: '#22c55e', hermes: '#f59e0b',
    openclaw: '#3b82f6', custom: '#a855f7'
  };
  const color = colors[t] || '#71717a';
  return '<span class="agent-type-badge" style="--agent-color:' + color + '">' + escapeHtml(type || 'Unknown') + '</span>';
}

let _agentsCache = [];
let _agentTypeFilter = '';

async function renderAgentsPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Agents</h1>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" id="agents-refresh">Refresh</button>
      </div>
    </div>
    <div class="stats-grid" id="agents-stats"></div>
    <div class="filter-bar" id="agents-type-filters">
      <button class="btn btn-sm btn-primary" data-agent-type="">All</button>
      <button class="btn btn-sm btn-ghost" data-agent-type="claude">Claude</button>
      <button class="btn btn-sm btn-ghost" data-agent-type="codex">Codex</button>
      <button class="btn btn-sm btn-ghost" data-agent-type="hermes">Hermes</button>
      <button class="btn btn-sm btn-ghost" data-agent-type="openclaw">OpenClaw</button>
      <button class="btn btn-sm btn-ghost" data-agent-type="custom">Custom</button>
    </div>
    <div class="glass-card table-wrapper mb-6">
      <table>
        <thead>
          <tr>
            <th>Agent Name</th>
            <th>Type</th>
            <th>Node</th>
            <th>Status</th>
            <th>Sessions</th>
            <th>Tokens</th>
            <th>Last Seen</th>
          </tr>
        </thead>
        <tbody id="agents-table-body">
          <tr><td colspan="7" class="text-center text-muted p-4">Loading agents...</td></tr>
        </tbody>
      </table>
    </div>
    <div id="agent-detail" class="detail-panel"></div>
  `;

  _agentTypeFilter = '';
  loadAgentsData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'agents-refresh' || e.target.closest('#agents-refresh')) {
      loadAgentsData();
      return;
    }

    const typeBtn = e.target.closest('[data-agent-type]');
    if (typeBtn) {
      _agentTypeFilter = typeBtn.dataset.agentType;
      el.querySelectorAll('[data-agent-type]').forEach(b => {
        b.className = b.dataset.agentType === _agentTypeFilter ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';
      });
      renderAgentsTable();
      return;
    }

    const row = e.target.closest('tr[data-agent-id]');
    if (row) {
      openAgentDetail(row.dataset.agentId);
      return;
    }

    if (e.target.closest('.panel-close')) {
      document.getElementById('agent-detail')?.classList.remove('open');
      return;
    }
  });
}

async function loadAgentsData() {
  try {
    const [agentsResp, summaryResp] = await Promise.all([
      API.getAgents(),
      API.getAgentSummary()
    ]);
    _agentsCache = agentsResp.agents || agentsResp || [];
    const summary = summaryResp.summary || summaryResp || {};

    const active = _agentsCache.filter(a => (a.status || '').toLowerCase() === 'active' || (a.status || '').toLowerCase() === 'online').length;
    const byType = summary.byType || {};
    const typeBreakdown = Object.entries(byType).map(([t, c]) =>
      '<span class="text-sm">' + escapeHtml(t) + ': <strong>' + c + '</strong></span>'
    ).join(' &nbsp; ') || '--';

    document.getElementById('agents-stats').innerHTML = `
      <div class="stat-card glass-card"><div class="stat-label">Total Agents</div><div class="stat-value">${_agentsCache.length}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Active</div><div class="stat-value text-success">${active}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">By Type</div><div class="stat-sub">${typeBreakdown}</div></div>
    `;

    renderAgentsTable();
  } catch (err) {
    document.getElementById('agents-table-body').innerHTML =
      '<tr><td colspan="7" class="text-center text-danger p-4">Failed to load: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function renderAgentsTable() {
  const filtered = _agentTypeFilter
    ? _agentsCache.filter(a => (a.type || '').toLowerCase() === _agentTypeFilter)
    : _agentsCache;
  const tbody = document.getElementById('agents-table-body');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted p-4">No agents found</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.map(a => `
    <tr class="clickable" data-agent-id="${escapeHtml(a.id)}">
      <td class="font-semibold">${escapeHtml(a.name || a.id)}</td>
      <td>${agentTypeBadge(a.type)}</td>
      <td class="text-sm">${escapeHtml(a.nodeId || a.node || '--')}</td>
      <td>${statusBadge(a.status)}</td>
      <td class="text-center">${a.sessions ?? a.sessionCount ?? '--'}</td>
      <td class="text-mono text-sm">${a.tokens != null ? a.tokens.toLocaleString() : '--'}</td>
      <td class="text-muted text-sm">${timeAgo(a.lastSeen || a.lastActivity)}</td>
    </tr>
  `).join('');
}

async function openAgentDetail(agentId) {
  const panel = document.getElementById('agent-detail');
  panel.classList.add('open');
  panel.innerHTML = '<div class="panel-header"><h2>Agent Details</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-muted">Loading...</p>';
  try {
    const resp = await API.getAgent(agentId);
    const a = resp.agent || resp;

    let timelineHtml = '';
    try {
      const tlResp = await API.getAgentTimeline(agentId);
      const events = tlResp.events || tlResp.timeline || tlResp || [];
      if (events.length) {
        timelineHtml = '<div class="section-title mt-6">Timeline</div><div class="timeline">' + events.map(e =>
          '<div class="timeline-item"><div class="tl-time">' + (e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '') + '</div><div class="tl-type">' + escapeHtml(e.type || e.event || '') + '</div><div class="tl-detail">' + escapeHtml(e.detail || e.message || '') + '</div></div>'
        ).join('') + '</div>';
      }
    } catch { /* timeline optional */ }

    let metricsHtml = '';
    try {
      const mResp = await API.getAgentMetrics(agentId);
      const m = mResp.metrics || mResp || {};
      metricsHtml = `
        <div class="section-title mt-6">Metrics</div>
        <div class="grid-2 mb-4">
          <div><span class="text-secondary text-sm">Total Tokens</span><div class="text-mono">${m.totalTokens != null ? m.totalTokens.toLocaleString() : '--'}</div></div>
          <div><span class="text-secondary text-sm">Total Cost</span><div>${m.totalCost != null ? '$' + m.totalCost.toFixed(4) : '--'}</div></div>
          <div><span class="text-secondary text-sm">Avg Drift</span><div>${m.avgDrift != null ? m.avgDrift.toFixed(1) + '%' : '--'}</div></div>
          <div><span class="text-secondary text-sm">Error Rate</span><div>${m.errorRate != null ? (m.errorRate * 100).toFixed(1) + '%' : '--'}</div></div>
        </div>`;
    } catch { /* metrics optional */ }

    panel.innerHTML = `
      <div class="panel-header"><h2>${escapeHtml(a.name || a.id)}</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div>
      <div class="mb-4">${agentTypeBadge(a.type)} ${statusBadge(a.status)}</div>
      <div class="grid-2 mb-4">
        <div><span class="text-secondary text-sm">Node</span><div>${escapeHtml(a.nodeId || a.node || '--')}</div></div>
        <div><span class="text-secondary text-sm">Sessions</span><div>${a.sessions ?? a.sessionCount ?? '--'}</div></div>
        <div><span class="text-secondary text-sm">Model</span><div>${escapeHtml(a.model || '--')}</div></div>
        <div><span class="text-secondary text-sm">Last Seen</span><div>${timeAgo(a.lastSeen || a.lastActivity)}</div></div>
      </div>
      ${metricsHtml}
      ${timelineHtml}
    `;
  } catch (err) {
    panel.innerHTML = '<div class="panel-header"><h2>Error</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-danger">' + escapeHtml(err.message) + '</p>';
  }
}

/* ===================================================================
   Channels Page
   =================================================================== */

let _channelsList = [];
let _selectedChannelId = null;

async function renderChannelsPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Channels</h1>
      <div class="page-actions">
        <button class="btn btn-primary btn-sm" id="new-channel-btn">New Channel</button>
      </div>
    </div>
    <div class="channel-layout">
      <div class="channel-sidebar glass-card">
        <div class="channel-list" id="channel-list"><div class="text-muted p-4 text-sm">Loading channels...</div></div>
      </div>
      <div class="channel-main glass-card" id="channel-main">
        <div class="text-muted p-4 text-center">Select a channel to start</div>
      </div>
    </div>
  `;

  loadChannelsList();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'new-channel-btn' || e.target.closest('#new-channel-btn')) {
      showNewChannelModal();
      return;
    }
    const chItem = e.target.closest('[data-channel-id]');
    if (chItem && chItem.closest('.channel-list')) {
      selectChannel(chItem.dataset.channelId);
      return;
    }
    const sendBtn = e.target.closest('#channel-send-btn');
    if (sendBtn) {
      sendCurrentMessage();
      return;
    }
  });

  // Handle Enter key in message input
  el.addEventListener('keydown', function kHandler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('keydown', kHandler); return; }
    if (e.target.id === 'channel-msg-input' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCurrentMessage();
    }
  });
}

async function loadChannelsList() {
  try {
    const resp = await API.getChannels();
    _channelsList = resp.channels || resp || [];
    const list = document.getElementById('channel-list');
    if (!_channelsList.length) {
      list.innerHTML = '<div class="text-muted p-4 text-sm">No channels yet</div>';
      return;
    }
    list.innerHTML = _channelsList.map(ch => `
      <div class="channel-list-item${_selectedChannelId === ch.id ? ' active' : ''}" data-channel-id="${escapeHtml(ch.id)}">
        <span class="channel-name"># ${escapeHtml(ch.name || ch.id)}</span>
        ${ch.unread ? '<span class="channel-unread">' + ch.unread + '</span>' : ''}
      </div>
    `).join('');
  } catch (err) {
    document.getElementById('channel-list').innerHTML = '<div class="text-danger p-4 text-sm">' + escapeHtml(err.message) + '</div>';
  }
}

async function selectChannel(channelId) {
  _selectedChannelId = channelId;
  // Update active state
  document.querySelectorAll('.channel-list-item').forEach(item => {
    item.classList.toggle('active', item.dataset.channelId === channelId);
  });

  const main = document.getElementById('channel-main');
  const ch = _channelsList.find(c => c.id === channelId);
  main.innerHTML = `
    <div class="channel-header">
      <span class="font-semibold"># ${escapeHtml(ch ? ch.name || ch.id : channelId)}</span>
      <div class="flex gap-2">
        <button class="btn btn-ghost btn-sm" id="channel-join-btn">Join</button>
        <button class="btn btn-ghost btn-sm" id="channel-leave-btn">Leave</button>
      </div>
    </div>
    <div class="message-list" id="message-list"><div class="text-muted p-4 text-sm text-center">Loading messages...</div></div>
    <div class="message-input-bar">
      <input type="text" id="channel-msg-input" placeholder="Type a message..." style="flex:1">
      <button class="btn btn-primary btn-sm" id="channel-send-btn">Send</button>
    </div>
  `;

  document.getElementById('channel-join-btn')?.addEventListener('click', async () => {
    try { await API.joinChannel(channelId); App.showToast('Joined channel', 'success'); } catch (e) { App.showToast(e.message, 'error'); }
  });
  document.getElementById('channel-leave-btn')?.addEventListener('click', async () => {
    try { await API.leaveChannel(channelId); App.showToast('Left channel', 'success'); } catch (e) { App.showToast(e.message, 'error'); }
  });

  loadChannelMessages(channelId);

  // SSE for real-time messages
  SSE.disconnect('channel');
  SSE.connect('channel', '/api/channels/' + channelId + '/stream', {
    onEvent(msg) {
      appendChannelMessage(msg);
    }
  });
}

async function loadChannelMessages(channelId) {
  try {
    const resp = await API.getChannelMessages(channelId);
    const messages = resp.messages || resp || [];
    const list = document.getElementById('message-list');
    if (!messages.length) {
      list.innerHTML = '<div class="text-muted p-4 text-sm text-center">No messages yet</div>';
      return;
    }
    list.innerHTML = messages.map(m => messageItemHtml(m)).join('');
    list.scrollTop = list.scrollHeight;
  } catch (err) {
    document.getElementById('message-list').innerHTML = '<div class="text-danger p-4 text-sm">' + escapeHtml(err.message) + '</div>';
  }
}

function messageItemHtml(m) {
  const ts = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
  return '<div class="message-item"><div class="message-meta"><span class="message-sender">' + escapeHtml(m.sender || m.user || 'unknown') + '</span><span class="message-time">' + escapeHtml(ts) + '</span></div><div class="message-content">' + escapeHtml(m.content || m.text || '') + '</div></div>';
}

function appendChannelMessage(msg) {
  const list = document.getElementById('message-list');
  if (!list) return;
  // Remove "no messages" placeholder
  const placeholder = list.querySelector('.text-muted');
  if (placeholder) placeholder.remove();
  list.insertAdjacentHTML('beforeend', messageItemHtml(msg));
  list.scrollTop = list.scrollHeight;
}

async function sendCurrentMessage() {
  const input = document.getElementById('channel-msg-input');
  if (!input || !input.value.trim() || !_selectedChannelId) return;
  const content = input.value.trim();
  input.value = '';
  try {
    await API.sendChannelMessage(_selectedChannelId, { content });
  } catch (err) {
    App.showToast(err.message, 'error');
  }
}

function showNewChannelModal() {
  App.showModal('New Channel', `
    <div class="form-group"><label>Channel Name</label><input type="text" id="new-channel-name" placeholder="general" style="width:100%"></div>
    <div class="form-group"><label>Description (optional)</label><input type="text" id="new-channel-desc" placeholder="Description..." style="width:100%"></div>
  `, [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Create', class: 'btn btn-primary', action: async () => {
      const name = document.getElementById('new-channel-name')?.value.trim();
      const description = document.getElementById('new-channel-desc')?.value.trim();
      if (!name) { App.showToast('Name is required', 'error'); return; }
      try {
        await API.createChannel({ name, description });
        App.hideModal();
        App.showToast('Channel created', 'success');
        loadChannelsList();
      } catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

/* ===================================================================
   Knowledge Graph Page
   =================================================================== */

async function renderKnowledgePage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Knowledge Graph</h1>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" id="knowledge-ingest-btn">Ingest from Events</button>
        <button class="btn btn-ghost btn-sm" id="knowledge-refresh">Refresh</button>
      </div>
    </div>
    <div class="stats-grid" id="knowledge-stats"></div>
    <div class="filter-bar">
      <input type="text" id="knowledge-search" placeholder="Search knowledge graph..." style="width:300px">
      <button class="btn btn-sm btn-primary" id="knowledge-search-btn">Search</button>
    </div>
    <div class="grid-2">
      <div class="graph-container glass-card" id="knowledge-graph-container">
        <div class="text-muted p-4 text-center">Loading graph...</div>
      </div>
      <div class="glass-card p-4">
        <div class="section-title">Most Connected</div>
        <div id="knowledge-top-list"><div class="text-muted text-sm">Loading...</div></div>
        <div class="section-title mt-6" id="knowledge-search-title" style="display:none">Search Results</div>
        <div id="knowledge-search-results"></div>
      </div>
    </div>
  `;

  loadKnowledgeData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'knowledge-refresh' || e.target.closest('#knowledge-refresh')) {
      loadKnowledgeData();
      return;
    }
    if (e.target.id === 'knowledge-ingest-btn' || e.target.closest('#knowledge-ingest-btn')) {
      ingestKnowledgeAction();
      return;
    }
    if (e.target.id === 'knowledge-search-btn' || e.target.closest('#knowledge-search-btn')) {
      runKnowledgeSearch();
      return;
    }
  });

  document.getElementById('knowledge-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runKnowledgeSearch();
  });
}

async function loadKnowledgeData() {
  try {
    const [statsResp, graphResp, topResp] = await Promise.all([
      API.getKnowledgeStats(),
      API.getKnowledgeGraph(),
      API.getKnowledgeTop(10)
    ]);

    const stats = statsResp.stats || statsResp || {};
    document.getElementById('knowledge-stats').innerHTML = `
      <div class="stat-card glass-card"><div class="stat-label">Nodes</div><div class="stat-value">${stats.nodes || stats.nodeCount || 0}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Edges</div><div class="stat-value">${stats.edges || stats.edgeCount || 0}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Components</div><div class="stat-value">${stats.components || stats.componentCount || 0}</div></div>
    `;

    // Render graph
    const graph = graphResp.graph || graphResp || {};
    renderKnowledgeGraph(graph);

    // Render top nodes
    const top = topResp.nodes || topResp.top || topResp || [];
    const topList = document.getElementById('knowledge-top-list');
    if (!top.length) {
      topList.innerHTML = '<div class="text-muted text-sm">No data</div>';
    } else {
      topList.innerHTML = top.map((n, i) => `
        <div class="flex items-center justify-between" style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
          <div class="flex items-center gap-2">
            <span class="text-muted text-sm">${i + 1}.</span>
            <span class="graph-node-badge graph-node-${(n.type || 'tag').toLowerCase()}" style="width:8px;height:8px;border-radius:50%;display:inline-block"></span>
            <span class="text-sm font-semibold">${escapeHtml(n.label || n.id || '--')}</span>
          </div>
          <span class="text-muted text-xs">${n.connections || n.degree || 0} connections</span>
        </div>
      `).join('');
    }
  } catch (err) {
    document.getElementById('knowledge-graph-container').innerHTML = '<div class="text-danger p-4">' + escapeHtml(err.message) + '</div>';
  }
}

function renderKnowledgeGraph(graph) {
  const container = document.getElementById('knowledge-graph-container');
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  if (!nodes.length) {
    container.innerHTML = '<div class="text-muted p-4 text-center">No graph data. Click "Ingest from Events" to populate.</div>';
    return;
  }

  const w = container.clientWidth || 500;
  const h = 400;
  const typeColors = {
    session: '#3b82f6', file: '#22c55e', tool: '#f59e0b',
    agent: '#a855f7', memory: '#06b6d4', tag: '#71717a'
  };

  // Initialize positions randomly
  const simNodes = nodes.map(n => ({
    id: n.id, label: n.label || n.id, type: n.type || 'tag',
    x: w * 0.2 + Math.random() * w * 0.6,
    y: h * 0.2 + Math.random() * h * 0.6,
    vx: 0, vy: 0
  }));

  const nodeMap = new Map();
  simNodes.forEach(n => nodeMap.set(n.id, n));

  const simEdges = edges.filter(e => nodeMap.has(e.source) && nodeMap.has(e.target));

  // Simple force simulation
  function simulate(iterations) {
    for (let iter = 0; iter < iterations; iter++) {
      // Repulsion between all nodes
      for (let i = 0; i < simNodes.length; i++) {
        for (let j = i + 1; j < simNodes.length; j++) {
          const a = simNodes[i], b = simNodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 800 / (dist * dist);
          dx = (dx / dist) * force;
          dy = (dy / dist) * force;
          a.vx -= dx; a.vy -= dy;
          b.vx += dx; b.vy += dy;
        }
      }
      // Attraction along edges
      for (const e of simEdges) {
        const a = nodeMap.get(e.source), b = nodeMap.get(e.target);
        if (!a || !b) continue;
        let dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - 60) * 0.01;
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        a.vx += dx; a.vy += dy;
        b.vx -= dx; b.vy -= dy;
      }
      // Centering force
      for (const n of simNodes) {
        n.vx += (w / 2 - n.x) * 0.005;
        n.vy += (h / 2 - n.y) * 0.005;
      }
      // Apply velocity with damping
      for (const n of simNodes) {
        n.vx *= 0.7; n.vy *= 0.7;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(20, Math.min(w - 20, n.x));
        n.y = Math.max(20, Math.min(h - 20, n.y));
      }
    }
  }

  simulate(100);

  // Render SVG
  let svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">';
  // Edges
  for (const e of simEdges) {
    const a = nodeMap.get(e.source), b = nodeMap.get(e.target);
    if (a && b) {
      svg += '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>';
    }
  }
  // Nodes
  for (const n of simNodes) {
    const color = typeColors[n.type] || '#71717a';
    svg += '<g class="kg-node" data-kg-id="' + escapeHtml(n.id) + '">';
    svg += '<circle cx="' + n.x.toFixed(1) + '" cy="' + n.y.toFixed(1) + '" r="6" fill="' + color + '" opacity="0.85"/>';
    svg += '<text x="' + n.x.toFixed(1) + '" y="' + (n.y + 16).toFixed(1) + '" fill="#a1a1aa" font-size="8" text-anchor="middle">' + escapeHtml(n.label.length > 15 ? n.label.slice(0, 13) + '..' : n.label) + '</text>';
    svg += '</g>';
  }
  svg += '</svg>';

  container.innerHTML = svg;
}

async function runKnowledgeSearch() {
  const q = document.getElementById('knowledge-search')?.value.trim();
  if (!q) return;
  const titleEl = document.getElementById('knowledge-search-title');
  const resultsEl = document.getElementById('knowledge-search-results');
  titleEl.style.display = 'block';
  resultsEl.innerHTML = '<div class="text-muted text-sm">Searching...</div>';
  try {
    const resp = await API.searchKnowledge(q);
    const results = resp.results || resp.nodes || resp || [];
    if (!results.length) {
      resultsEl.innerHTML = '<div class="text-muted text-sm">No results found</div>';
      return;
    }
    resultsEl.innerHTML = results.map(r => `
      <div class="flex items-center gap-2" style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
        <span class="graph-node-badge graph-node-${(r.type || 'tag').toLowerCase()}" style="width:8px;height:8px;border-radius:50%;display:inline-block"></span>
        <span class="text-sm">${escapeHtml(r.label || r.id || '--')}</span>
        <span class="text-xs text-muted">${escapeHtml(r.type || '')}</span>
      </div>
    `).join('');
  } catch (err) {
    resultsEl.innerHTML = '<div class="text-danger text-sm">' + escapeHtml(err.message) + '</div>';
  }
}

async function ingestKnowledgeAction() {
  try {
    App.showToast('Ingesting events into knowledge graph...', 'info');
    await API.ingestKnowledge();
    App.showToast('Knowledge graph updated', 'success');
    loadKnowledgeData();
  } catch (err) {
    App.showToast(err.message, 'error');
  }
}

/* ===================================================================
   Doctor Page
   =================================================================== */

async function renderDoctorPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>System Doctor</h1>
      <div class="page-actions">
        <button class="btn btn-primary btn-sm" id="doctor-run-btn">Run Diagnostics</button>
      </div>
    </div>
    <div class="grid-2">
      <div>
        <div class="section-title">System Health</div>
        <div id="doctor-posture" class="mb-4"></div>
        <div id="doctor-checks"><div class="text-muted text-sm">Click "Run Diagnostics" to start</div></div>
      </div>
      <div>
        <div class="section-title flex items-center justify-between">
          <span>Backups</span>
          <button class="btn btn-sm btn-ghost" id="backup-create-btn">Create Backup</button>
        </div>
        <div id="backup-list"><div class="text-muted text-sm">Loading backups...</div></div>
      </div>
    </div>
  `;

  loadBackupsList();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'doctor-run-btn' || e.target.closest('#doctor-run-btn')) {
      runDoctorDiagnostics();
      return;
    }
    if (e.target.id === 'backup-create-btn' || e.target.closest('#backup-create-btn')) {
      createBackupAction();
      return;
    }
    const fixBtn = e.target.closest('[data-doctor-fix]');
    if (fixBtn) {
      fixDoctorIssue(fixBtn.dataset.doctorFix);
      return;
    }
    const restoreBtn = e.target.closest('[data-restore-backup]');
    if (restoreBtn) {
      restoreBackupAction(restoreBtn.dataset.restoreBackup);
      return;
    }
    const deleteBtn = e.target.closest('[data-delete-backup]');
    if (deleteBtn) {
      deleteBackupAction(deleteBtn.dataset.deleteBackup);
      return;
    }
  });
}

async function runDoctorDiagnostics() {
  const checksEl = document.getElementById('doctor-checks');
  const postureEl = document.getElementById('doctor-posture');
  checksEl.innerHTML = '<div class="text-muted text-sm">Running diagnostics...</div>';
  try {
    const resp = await API.getDoctor();
    const checks = resp.checks || resp.results || resp || [];
    const total = checks.length || 1;
    const passes = checks.filter(c => (c.status || '').toLowerCase() === 'pass').length;
    const score = Math.round((passes / total) * 100);

    // Posture score
    const scoreColor = score >= 80 ? 'var(--accent-success)' : score >= 50 ? 'var(--accent-warning)' : 'var(--accent-danger)';
    postureEl.innerHTML = `
      <div class="posture-score glass-card">
        <div class="posture-ring" style="--score:${score};--score-color:${scoreColor}">
          <span class="posture-value">${score}</span>
        </div>
        <div class="text-sm text-secondary mt-2">Security Posture</div>
      </div>
    `;

    if (!checks.length) {
      checksEl.innerHTML = '<div class="text-muted text-sm">No diagnostic checks returned</div>';
      return;
    }
    checksEl.innerHTML = checks.map(c => {
      const status = (c.status || 'unknown').toLowerCase();
      const statusClass = status === 'pass' ? 'doctor-pass' : status === 'warn' ? 'doctor-warn' : 'doctor-fail';
      const statusLabel = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL';
      return `
        <div class="doctor-card glass-card mb-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="doctor-status ${statusClass}">${statusLabel}</span>
              <span class="font-semibold text-sm">${escapeHtml(c.name || c.check || c.id || '--')}</span>
            </div>
            ${c.fixable ? '<button class="btn btn-sm btn-ghost" data-doctor-fix="' + escapeHtml(c.id || c.check || '') + '">Fix</button>' : ''}
          </div>
          <div class="text-sm text-muted mt-2">${escapeHtml(c.message || c.detail || '')}</div>
        </div>
      `;
    }).join('');
  } catch (err) {
    checksEl.innerHTML = '<div class="text-danger text-sm">' + escapeHtml(err.message) + '</div>';
  }
}

async function fixDoctorIssue(checkId) {
  try {
    await API.fixDoctor(checkId);
    App.showToast('Fix applied for: ' + checkId, 'success');
    runDoctorDiagnostics();
  } catch (err) {
    App.showToast(err.message, 'error');
  }
}

async function loadBackupsList() {
  try {
    const resp = await API.getBackups();
    const backups = resp.backups || resp || [];
    const listEl = document.getElementById('backup-list');
    if (!backups.length) {
      listEl.innerHTML = '<div class="text-muted text-sm">No backups found</div>';
      return;
    }
    listEl.innerHTML = backups.map(b => `
      <div class="glass-card p-4 mb-4 flex items-center justify-between">
        <div>
          <div class="font-semibold text-sm">${escapeHtml(b.id || b.name || '--')}</div>
          <div class="text-xs text-muted">${b.timestamp ? new Date(b.timestamp).toLocaleString() : '--'} ${b.size ? '&middot; ' + escapeHtml(b.size) : ''}</div>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-sm btn-ghost" data-restore-backup="${escapeHtml(b.id)}">Restore</button>
          <button class="btn btn-sm btn-danger" data-delete-backup="${escapeHtml(b.id)}">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    document.getElementById('backup-list').innerHTML = '<div class="text-danger text-sm">' + escapeHtml(err.message) + '</div>';
  }
}

async function createBackupAction() {
  try {
    App.showToast('Creating backup...', 'info');
    await API.createBackup();
    App.showToast('Backup created', 'success');
    loadBackupsList();
  } catch (err) {
    App.showToast(err.message, 'error');
  }
}

async function restoreBackupAction(backupId) {
  App.showModal('Restore Backup', '<p>Are you sure you want to restore backup <strong>' + escapeHtml(backupId) + '</strong>? This will overwrite current data.</p>', [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Restore', class: 'btn btn-danger', action: async () => {
      try {
        await API.restoreBackup(backupId);
        App.hideModal();
        App.showToast('Backup restored', 'success');
      } catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

async function deleteBackupAction(backupId) {
  App.showModal('Delete Backup', '<p>Delete backup <strong>' + escapeHtml(backupId) + '</strong>? This cannot be undone.</p>', [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Delete', class: 'btn btn-danger', action: async () => {
      try {
        await API.deleteBackup(backupId);
        App.hideModal();
        App.showToast('Backup deleted', 'success');
        loadBackupsList();
      } catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

/* ===================================================================
   Gateway Page
   =================================================================== */

async function renderGatewayPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Gateway</h1>
      <div class="page-actions">
        <button class="btn btn-primary btn-sm" id="add-upstream-btn">Add Upstream</button>
        <button class="btn btn-ghost btn-sm" id="gateway-refresh">Refresh</button>
      </div>
    </div>
    <div class="stats-grid" id="gateway-status-bar"></div>
    <div class="section-title">Upstreams</div>
    <div class="glass-card table-wrapper mb-6">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>URL</th>
            <th>Status</th>
            <th>Latency</th>
            <th>Last Seen</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="upstream-table-body">
          <tr><td colspan="6" class="text-center text-muted p-4">Loading upstreams...</td></tr>
        </tbody>
      </table>
    </div>
    <div class="tabs" id="gateway-tabs">
      <button class="tab-btn active" data-gw-tab="nodes">Federated Nodes</button>
      <button class="tab-btn" data-gw-tab="sessions">Federated Sessions</button>
    </div>
    <div id="gateway-tab-content"><div class="text-muted text-sm">Loading...</div></div>
  `;

  loadGatewayData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'gateway-refresh' || e.target.closest('#gateway-refresh')) {
      loadGatewayData();
      return;
    }
    if (e.target.id === 'add-upstream-btn' || e.target.closest('#add-upstream-btn')) {
      showAddUpstreamModal();
      return;
    }
    const tabBtn = e.target.closest('[data-gw-tab]');
    if (tabBtn) {
      el.querySelectorAll('[data-gw-tab]').forEach(b => b.classList.toggle('active', b === tabBtn));
      loadGatewayTabContent(tabBtn.dataset.gwTab);
      return;
    }
    const editBtn = e.target.closest('[data-edit-upstream]');
    if (editBtn) {
      showEditUpstreamModal(editBtn.dataset.editUpstream);
      return;
    }
    const removeBtn = e.target.closest('[data-remove-upstream]');
    if (removeBtn) {
      removeUpstreamAction(removeBtn.dataset.removeUpstream);
      return;
    }
  });
}

let _upstreamsCache = [];

async function loadGatewayData() {
  try {
    const [statusResp, upstreamsResp] = await Promise.all([
      API.getGatewayStatus(),
      API.getUpstreams()
    ]);

    const status = statusResp.status || statusResp || {};
    const gwState = (status.state || status.status || 'unknown').toLowerCase();
    const stateColor = gwState === 'active' || gwState === 'healthy' || gwState === 'online' ? 'text-success' : gwState === 'degraded' ? 'text-warning' : 'text-danger';
    document.getElementById('gateway-status-bar').innerHTML = `
      <div class="stat-card glass-card"><div class="stat-label">Gateway Status</div><div class="stat-value ${stateColor}">${escapeHtml(status.state || status.status || 'Unknown')}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Upstreams</div><div class="stat-value">${status.upstreamCount || 0}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Healthy</div><div class="stat-value text-success">${status.healthyCount || 0}</div></div>
    `;

    _upstreamsCache = upstreamsResp.upstreams || upstreamsResp || [];
    renderUpstreamsTable();
    loadGatewayTabContent('nodes');
  } catch (err) {
    document.getElementById('upstream-table-body').innerHTML =
      '<tr><td colspan="6" class="text-center text-danger p-4">' + escapeHtml(err.message) + '</td></tr>';
  }
}

function renderUpstreamsTable() {
  const tbody = document.getElementById('upstream-table-body');
  if (!_upstreamsCache.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted p-4">No upstreams configured</td></tr>';
    return;
  }
  tbody.innerHTML = _upstreamsCache.map(u => {
    const st = (u.status || 'unknown').toLowerCase();
    const stClass = st === 'healthy' || st === 'online' ? 'upstream-healthy' : 'upstream-unhealthy';
    return `
      <tr>
        <td class="font-semibold">${escapeHtml(u.name || u.id || '--')}</td>
        <td class="text-mono text-sm">${escapeHtml(u.url || '--')}</td>
        <td><span class="upstream-status ${stClass}">${escapeHtml(u.status || 'unknown')}</span></td>
        <td class="text-sm">${u.latency != null ? u.latency + 'ms' : '--'}</td>
        <td class="text-muted text-sm">${timeAgo(u.lastSeen)}</td>
        <td>
          <div class="flex gap-2">
            <button class="btn btn-sm btn-ghost" data-edit-upstream="${escapeHtml(u.id)}">Edit</button>
            <button class="btn btn-sm btn-danger" data-remove-upstream="${escapeHtml(u.id)}">Remove</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function loadGatewayTabContent(tab) {
  const container = document.getElementById('gateway-tab-content');
  container.innerHTML = '<div class="text-muted text-sm">Loading...</div>';
  try {
    if (tab === 'nodes') {
      const resp = await API.getAggregateNodes();
      const nodes = resp.nodes || resp || [];
      if (!nodes.length) { container.innerHTML = '<div class="text-muted text-sm">No federated nodes</div>'; return; }
      container.innerHTML = '<div class="glass-card table-wrapper"><table><thead><tr><th>Hostname</th><th>Source</th><th>Status</th><th>Sessions</th><th>Last Seen</th></tr></thead><tbody>' +
        nodes.map(n => '<tr><td class="font-semibold">' + escapeHtml(n.hostname || n.id || '--') + '</td><td class="text-sm text-muted">' + escapeHtml(n.source || '--') + '</td><td>' + statusBadge(n.status) + '</td><td class="text-center">' + (n.sessions ?? '--') + '</td><td class="text-muted text-sm">' + timeAgo(n.lastSeen || n.lastHeartbeat) + '</td></tr>').join('') +
        '</tbody></table></div>';
    } else {
      const resp = await API.getAggregateSessions();
      const sessions = resp.sessions || resp || [];
      if (!sessions.length) { container.innerHTML = '<div class="text-muted text-sm">No federated sessions</div>'; return; }
      container.innerHTML = '<div class="glass-card table-wrapper"><table><thead><tr><th>Session ID</th><th>Source</th><th>Status</th><th>Model</th><th>Tokens</th></tr></thead><tbody>' +
        sessions.map(s => '<tr><td class="text-mono truncate">' + truncId(s.id) + '</td><td class="text-sm text-muted">' + escapeHtml(s.source || '--') + '</td><td>' + statusBadge(s.status) + '</td><td class="text-sm">' + escapeHtml(s.model || '--') + '</td><td class="text-mono text-sm">' + (s.tokens != null ? s.tokens.toLocaleString() : '--') + '</td></tr>').join('') +
        '</tbody></table></div>';
    }
  } catch (err) {
    container.innerHTML = '<div class="text-danger text-sm">' + escapeHtml(err.message) + '</div>';
  }
}

function showAddUpstreamModal() {
  App.showModal('Add Upstream', `
    <div class="form-group"><label>Name</label><input type="text" id="upstream-name" placeholder="production-east" style="width:100%"></div>
    <div class="form-group"><label>URL</label><input type="text" id="upstream-url" placeholder="https://host:port" style="width:100%"></div>
  `, [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Add', class: 'btn btn-primary', action: async () => {
      const name = document.getElementById('upstream-name')?.value.trim();
      const url = document.getElementById('upstream-url')?.value.trim();
      if (!name || !url) { App.showToast('Name and URL required', 'error'); return; }
      try {
        await API.addUpstream({ name, url });
        App.hideModal();
        App.showToast('Upstream added', 'success');
        loadGatewayData();
      } catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

function showEditUpstreamModal(upstreamId) {
  const u = _upstreamsCache.find(x => x.id === upstreamId) || {};
  App.showModal('Edit Upstream', `
    <div class="form-group"><label>Name</label><input type="text" id="edit-upstream-name" value="${escapeHtml(u.name || '')}" style="width:100%"></div>
    <div class="form-group"><label>URL</label><input type="text" id="edit-upstream-url" value="${escapeHtml(u.url || '')}" style="width:100%"></div>
  `, [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Save', class: 'btn btn-primary', action: async () => {
      const name = document.getElementById('edit-upstream-name')?.value.trim();
      const url = document.getElementById('edit-upstream-url')?.value.trim();
      try {
        await API.updateUpstream(upstreamId, { name, url });
        App.hideModal();
        App.showToast('Upstream updated', 'success');
        loadGatewayData();
      } catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

function removeUpstreamAction(upstreamId) {
  App.showModal('Remove Upstream', '<p>Remove upstream <strong>' + escapeHtml(upstreamId) + '</strong>?</p>', [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Remove', class: 'btn btn-danger', action: async () => {
      try {
        await API.removeUpstream(upstreamId);
        App.hideModal();
        App.showToast('Upstream removed', 'success');
        loadGatewayData();
      } catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

/* ===================================================================
   Tasks Page (Kanban)
   =================================================================== */

let _tasksCache = [];
let _taskBoardCache = {};

const TASK_COLUMNS = ['inbox', 'assigned', 'in_progress', 'review', 'done', 'archived'];
const TASK_COLUMN_LABELS = { inbox: 'Inbox', assigned: 'Assigned', in_progress: 'In Progress', review: 'Review', done: 'Done', archived: 'Archived' };

function priorityBadge(priority) {
  const p = (priority || 'medium').toLowerCase();
  return '<span class="priority-' + p + '">' + escapeHtml(p) + '</span>';
}

async function renderTasksPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Tasks</h1>
      <div class="page-actions">
        <button class="btn btn-primary btn-sm" id="new-task-btn">New Task</button>
        <button class="btn btn-ghost btn-sm" id="tasks-refresh">Refresh</button>
      </div>
    </div>
    <div class="stats-grid" id="tasks-stats"></div>
    <div class="kanban-board" id="tasks-board"></div>
    <div id="task-detail" class="detail-panel"></div>
  `;

  loadTasksData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'tasks-refresh' || e.target.closest('#tasks-refresh')) {
      loadTasksData();
      return;
    }
    if (e.target.id === 'new-task-btn' || e.target.closest('#new-task-btn')) {
      showNewTaskModal();
      return;
    }
    const card = e.target.closest('.kanban-card[data-task-id]');
    if (card) {
      openTaskDetail(card.dataset.taskId);
      return;
    }
    if (e.target.closest('.panel-close')) {
      document.getElementById('task-detail')?.classList.remove('open');
      return;
    }
  });
}

async function loadTasksData() {
  try {
    const [boardResp, statsResp] = await Promise.all([
      API.getTaskBoard(),
      API.getTaskStats()
    ]);
    _taskBoardCache = boardResp.board || boardResp || {};
    const stats = statsResp.stats || statsResp || {};

    const total = stats.total || 0;
    const overdue = stats.overdue || 0;
    const byPriority = stats.byPriority || {};

    document.getElementById('tasks-stats').innerHTML = `
      <div class="stat-card glass-card"><div class="stat-label">Total Tasks</div><div class="stat-value">${total}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Overdue</div><div class="stat-value ${overdue > 0 ? 'text-danger' : ''}">${overdue}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Critical</div><div class="stat-value priority-critical">${byPriority.critical || 0}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">High</div><div class="stat-value priority-high">${byPriority.high || 0}</div></div>
    `;

    renderTaskBoard();
  } catch (err) {
    document.getElementById('tasks-board').innerHTML = '<div class="text-danger p-4">' + escapeHtml(err.message) + '</div>';
  }
}

function renderTaskBoard() {
  const boardEl = document.getElementById('tasks-board');
  boardEl.innerHTML = TASK_COLUMNS.map(col => {
    const tasks = _taskBoardCache[col] || [];
    return `
      <div class="kanban-column">
        <div class="kanban-column-header">
          <span>${TASK_COLUMN_LABELS[col]}</span>
          <span class="kanban-column-count">${tasks.length}</span>
        </div>
        ${tasks.map(t => `
          <div class="kanban-card" data-task-id="${escapeHtml(t.id)}">
            <div class="kanban-card-title">${escapeHtml(t.title || t.id)}</div>
            <div class="kanban-card-meta">
              ${priorityBadge(t.priority)}
              <span>${escapeHtml(t.assignee || 'unassigned')}</span>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }).join('');
}

function showNewTaskModal() {
  App.showModal('New Task', `
    <div class="form-group"><label>Title</label><input type="text" id="task-title" placeholder="Task title" style="width:100%"></div>
    <div class="form-group"><label>Description</label><textarea id="task-desc" placeholder="Description" style="width:100%;min-height:80px"></textarea></div>
    <div class="form-group"><label>Priority</label>
      <select id="task-priority" style="width:100%">
        <option value="low">Low</option>
        <option value="medium" selected>Medium</option>
        <option value="high">High</option>
        <option value="critical">Critical</option>
      </select>
    </div>
    <div class="form-group"><label>Tags (comma-separated)</label><input type="text" id="task-tags" placeholder="tag1, tag2" style="width:100%"></div>
  `, [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Create', class: 'btn btn-primary', action: async () => {
      const title = document.getElementById('task-title')?.value.trim();
      if (!title) { App.showToast('Title required', 'error'); return; }
      const data = {
        title,
        description: document.getElementById('task-desc')?.value.trim(),
        priority: document.getElementById('task-priority')?.value,
        tags: (document.getElementById('task-tags')?.value || '').split(',').map(t => t.trim()).filter(Boolean)
      };
      try {
        await API.createTask(data);
        App.hideModal();
        App.showToast('Task created', 'success');
        loadTasksData();
      } catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

async function openTaskDetail(taskId) {
  const panel = document.getElementById('task-detail');
  panel.classList.add('open');
  panel.innerHTML = '<div class="panel-header"><h2>Task Details</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-muted">Loading...</p>';
  try {
    const [tasksResp, commentsResp] = await Promise.all([
      API.getTasks(),
      API.getTaskComments(taskId)
    ]);
    const tasks = tasksResp.tasks || tasksResp || [];
    const t = tasks.find(x => x.id === taskId) || {};
    const comments = commentsResp.comments || commentsResp || [];

    const statusOptions = TASK_COLUMNS.map(s =>
      '<option value="' + s + '"' + (t.status === s ? ' selected' : '') + '>' + TASK_COLUMN_LABELS[s] + '</option>'
    ).join('');

    const commentsHtml = comments.length
      ? comments.map(c => '<div class="glass-card p-3 mb-2"><div class="text-sm">' + escapeHtml(c.content || '') + '</div><div class="text-xs text-muted mt-1">' + escapeHtml(c.author || '') + ' - ' + timeAgo(c.createdAt) + '</div></div>').join('')
      : '<div class="text-muted text-sm">No comments yet</div>';

    panel.innerHTML = `
      <div class="panel-header"><h2>${escapeHtml(t.title || taskId)}</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div>
      <div class="mb-4">${priorityBadge(t.priority)} ${statusBadge(t.status)}</div>
      <div class="mb-4 text-sm">${escapeHtml(t.description || 'No description')}</div>
      <div class="grid-2 mb-4">
        <div><span class="text-secondary text-sm">Assignee</span><div>${escapeHtml(t.assignee || 'Unassigned')}</div></div>
        <div><span class="text-secondary text-sm">Created</span><div>${timeAgo(t.createdAt)}</div></div>
      </div>
      <div class="form-group">
        <label>Move to</label>
        <div class="flex gap-2">
          <select id="task-move-status" style="flex:1">${statusOptions}</select>
          <button class="btn btn-sm btn-primary" id="task-move-btn">Move</button>
        </div>
      </div>
      <div class="form-group">
        <label>Assign to</label>
        <div class="flex gap-2">
          <input type="text" id="task-assign-to" placeholder="Username or agent ID" style="flex:1" value="${escapeHtml(t.assignee || '')}">
          <button class="btn btn-sm btn-primary" id="task-assign-btn">Assign</button>
        </div>
      </div>
      <div class="section-title mt-6">Comments</div>
      <div id="task-comments">${commentsHtml}</div>
      <div class="form-group mt-4">
        <div class="flex gap-2">
          <input type="text" id="task-comment-input" placeholder="Add a comment..." style="flex:1">
          <button class="btn btn-sm btn-ghost" id="task-comment-btn">Post</button>
        </div>
      </div>
    `;

    document.getElementById('task-move-btn')?.addEventListener('click', async () => {
      const status = document.getElementById('task-move-status')?.value;
      try { await API.moveTask(taskId, status); App.showToast('Task moved', 'success'); loadTasksData(); } catch (e) { App.showToast(e.message, 'error'); }
    });
    document.getElementById('task-assign-btn')?.addEventListener('click', async () => {
      const assignee = document.getElementById('task-assign-to')?.value.trim();
      if (!assignee) return;
      try { await API.assignTask(taskId, assignee, 'user'); App.showToast('Task assigned', 'success'); } catch (e) { App.showToast(e.message, 'error'); }
    });
    document.getElementById('task-comment-btn')?.addEventListener('click', async () => {
      const content = document.getElementById('task-comment-input')?.value.trim();
      if (!content) return;
      try { await API.addTaskComment(taskId, content); App.showToast('Comment added', 'success'); openTaskDetail(taskId); } catch (e) { App.showToast(e.message, 'error'); }
    });
  } catch (err) {
    panel.innerHTML = '<div class="panel-header"><h2>Error</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-danger">' + escapeHtml(err.message) + '</p>';
  }
}

/* ===================================================================
   Webhooks Page
   =================================================================== */

let _webhooksCache = [];

async function renderWebhooksPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Webhooks</h1>
      <div class="page-actions">
        <button class="btn btn-primary btn-sm" id="new-webhook-btn">Add Webhook</button>
        <button class="btn btn-ghost btn-sm" id="webhooks-refresh">Refresh</button>
      </div>
    </div>
    <div class="glass-card table-wrapper mb-6">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>URL</th>
            <th>Events</th>
            <th>Status</th>
            <th>Circuit</th>
            <th>Last Delivery</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="webhooks-table-body">
          <tr><td colspan="7" class="text-center text-muted p-4">Loading webhooks...</td></tr>
        </tbody>
      </table>
    </div>
    <div id="webhook-detail" class="detail-panel"></div>
  `;

  loadWebhooksData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'webhooks-refresh' || e.target.closest('#webhooks-refresh')) {
      loadWebhooksData();
      return;
    }
    if (e.target.id === 'new-webhook-btn' || e.target.closest('#new-webhook-btn')) {
      showNewWebhookModal();
      return;
    }
    const testBtn = e.target.closest('[data-wh-test]');
    if (testBtn) {
      testWebhookAction(testBtn.dataset.whTest);
      return;
    }
    const delBtn = e.target.closest('[data-wh-delete]');
    if (delBtn) {
      deleteWebhookAction(delBtn.dataset.whDelete);
      return;
    }
    const row = e.target.closest('tr[data-wh-id]');
    if (row && !e.target.closest('button')) {
      openWebhookDetail(row.dataset.whId);
      return;
    }
    if (e.target.closest('.panel-close')) {
      document.getElementById('webhook-detail')?.classList.remove('open');
      return;
    }
  });
}

async function loadWebhooksData() {
  try {
    const resp = await API.getWebhooks();
    _webhooksCache = resp.webhooks || resp || [];
    const tbody = document.getElementById('webhooks-table-body');
    if (!_webhooksCache.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted p-4">No webhooks configured</td></tr>';
      return;
    }
    tbody.innerHTML = _webhooksCache.map(w => {
      const urlDisplay = (w.url || '').length > 40 ? w.url.slice(0, 38) + '...' : (w.url || '--');
      const events = (w.events || []).join(', ') || 'all';
      const circuit = (w.circuitBreaker || 'closed').toLowerCase();
      const circuitClass = circuit === 'closed' ? 'circuit-closed' : circuit === 'open' ? 'circuit-open' : 'circuit-half-open';
      return `
        <tr class="clickable" data-wh-id="${escapeHtml(w.id)}">
          <td class="font-semibold">${escapeHtml(w.name || w.id)}</td>
          <td class="text-mono text-sm" title="${escapeHtml(w.url || '')}">${escapeHtml(urlDisplay)}</td>
          <td class="text-sm">${escapeHtml(events)}</td>
          <td>${statusBadge(w.enabled !== false ? 'active' : 'stopped')}</td>
          <td class="${circuitClass}">${escapeHtml(circuit)}</td>
          <td class="text-muted text-sm">${w.lastDelivery ? timeAgo(w.lastDelivery) : '--'}</td>
          <td>
            <button class="btn btn-xs btn-ghost" data-wh-test="${escapeHtml(w.id)}" title="Test">Ping</button>
            <button class="btn btn-xs btn-danger" data-wh-delete="${escapeHtml(w.id)}" title="Delete">Del</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    document.getElementById('webhooks-table-body').innerHTML =
      '<tr><td colspan="7" class="text-center text-danger p-4">' + escapeHtml(err.message) + '</td></tr>';
  }
}

function showNewWebhookModal() {
  App.showModal('Add Webhook', `
    <div class="form-group"><label>Name</label><input type="text" id="wh-name" placeholder="My webhook" style="width:100%"></div>
    <div class="form-group"><label>URL</label><input type="text" id="wh-url" placeholder="https://example.com/webhook" style="width:100%"></div>
    <div class="form-group"><label>Events (comma-separated, blank=all)</label><input type="text" id="wh-events" placeholder="session.start, policy.violation" style="width:100%"></div>
    <div class="form-group"><label>Secret (optional)</label><input type="text" id="wh-secret" placeholder="HMAC secret" style="width:100%"></div>
  `, [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Create', class: 'btn btn-primary', action: async () => {
      const name = document.getElementById('wh-name')?.value.trim();
      const url = document.getElementById('wh-url')?.value.trim();
      if (!name || !url) { App.showToast('Name and URL required', 'error'); return; }
      const events = (document.getElementById('wh-events')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
      const secret = document.getElementById('wh-secret')?.value.trim();
      try {
        await API.createWebhook({ name, url, events: events.length ? events : undefined, secret: secret || undefined });
        App.hideModal();
        App.showToast('Webhook created', 'success');
        loadWebhooksData();
      } catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

async function testWebhookAction(id) {
  try {
    await API.testWebhook(id);
    App.showToast('Test ping sent', 'success');
  } catch (e) { App.showToast(e.message, 'error'); }
}

async function deleteWebhookAction(id) {
  App.showModal('Delete Webhook', '<p>Delete webhook <strong>' + escapeHtml(id) + '</strong>?</p>', [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Delete', class: 'btn btn-danger', action: async () => {
      try { await API.deleteWebhook(id); App.hideModal(); App.showToast('Webhook deleted', 'success'); loadWebhooksData(); }
      catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

async function openWebhookDetail(whId) {
  const panel = document.getElementById('webhook-detail');
  panel.classList.add('open');
  panel.innerHTML = '<div class="panel-header"><h2>Webhook Details</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-muted">Loading...</p>';
  try {
    const w = _webhooksCache.find(x => x.id === whId) || {};
    let deliveriesHtml = '';
    try {
      const delResp = await API.getWebhookDeliveries(whId);
      const deliveries = delResp.deliveries || delResp || [];
      if (deliveries.length) {
        deliveriesHtml = `
          <div class="section-title mt-6">Delivery History</div>
          <div class="glass-card table-wrapper">
            <table>
              <thead><tr><th>Time</th><th>Status</th><th>Response</th><th>Action</th></tr></thead>
              <tbody>${deliveries.map(d => `
                <tr>
                  <td class="text-sm">${timeAgo(d.timestamp || d.createdAt)}</td>
                  <td>${statusBadge(d.success ? 'active' : 'failed')}</td>
                  <td class="text-mono text-sm">${d.statusCode || '--'}</td>
                  <td>${!d.success ? '<button class="btn btn-xs btn-ghost" data-retry-wh="' + escapeHtml(whId) + '" data-retry-del="' + escapeHtml(d.id) + '">Retry</button>' : ''}</td>
                </tr>
              `).join('')}</tbody>
            </table>
          </div>
        `;
      }
    } catch { /* deliveries optional */ }

    panel.innerHTML = `
      <div class="panel-header"><h2>${escapeHtml(w.name || whId)}</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div>
      <div class="mb-4">${statusBadge(w.enabled !== false ? 'active' : 'stopped')}</div>
      <div class="grid-2 mb-4">
        <div><span class="text-secondary text-sm">URL</span><div class="text-mono text-sm" style="word-break:break-all">${escapeHtml(w.url || '--')}</div></div>
        <div><span class="text-secondary text-sm">Events</span><div class="text-sm">${escapeHtml((w.events || []).join(', ') || 'all')}</div></div>
        <div><span class="text-secondary text-sm">Circuit Breaker</span><div class="${(w.circuitBreaker || 'closed') === 'closed' ? 'circuit-closed' : 'circuit-open'}">${escapeHtml(w.circuitBreaker || 'closed')}</div></div>
        <div><span class="text-secondary text-sm">Created</span><div>${timeAgo(w.createdAt)}</div></div>
      </div>
      ${deliveriesHtml}
    `;

    panel.querySelectorAll('[data-retry-wh]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try { await API.retryDelivery(btn.dataset.retryWh, btn.dataset.retryDel); App.showToast('Retry sent', 'success'); openWebhookDetail(whId); }
        catch (e) { App.showToast(e.message, 'error'); }
      });
    });
  } catch (err) {
    panel.innerHTML = '<div class="panel-header"><h2>Error</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-danger">' + escapeHtml(err.message) + '</p>';
  }
}

/* ===================================================================
   Claude Code Page
   =================================================================== */

async function renderClaudePage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Claude Code</h1>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" id="claude-refresh">Refresh</button>
      </div>
    </div>
    <div class="stats-grid" id="claude-stats"></div>
    <div id="claude-discovery" class="glass-card p-4 mb-6"><div class="text-muted text-sm">Discovering Claude Code installations...</div></div>
    <div class="section-title">Projects</div>
    <div class="glass-card table-wrapper mb-6">
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Sessions</th>
            <th>Last Activity</th>
            <th>CLAUDE.md</th>
            <th>Memory</th>
          </tr>
        </thead>
        <tbody id="claude-projects-body">
          <tr><td colspan="5" class="text-center text-muted p-4">Loading...</td></tr>
        </tbody>
      </table>
    </div>
    <div class="section-title">Recent Activity</div>
    <div id="claude-recent" class="mb-6"><div class="text-muted text-sm">Loading...</div></div>
    <div id="claude-detail" class="detail-panel"></div>
  `;

  loadClaudeData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'claude-refresh' || e.target.closest('#claude-refresh')) {
      loadClaudeData();
      return;
    }
    const row = e.target.closest('tr[data-claude-project]');
    if (row) {
      openClaudeProjectDetail(row.dataset.claudeProject);
      return;
    }
    if (e.target.closest('.panel-close')) {
      document.getElementById('claude-detail')?.classList.remove('open');
      return;
    }
  });
}

async function loadClaudeData() {
  try {
    const [discoverResp, projectsResp, statsResp] = await Promise.all([
      API.discoverClaude().catch(() => ({})),
      API.getClaudeProjects().catch(() => ({ projects: [] })),
      API.getClaudeStats().catch(() => ({}))
    ]);

    const discover = discoverResp.discovery || discoverResp || {};
    const projects = projectsResp.projects || projectsResp || [];
    const stats = statsResp.stats || statsResp || {};

    // Discovery card
    const installed = discover.installed !== false;
    document.getElementById('claude-discovery').innerHTML = `
      <div class="flex items-center gap-4">
        <div>
          <div class="font-semibold">${installed ? 'Claude Code Detected' : 'Claude Code Not Found'}</div>
          <div class="text-sm text-muted">${discover.version ? 'Version: ' + escapeHtml(discover.version) : ''} ${discover.projectCount != null ? '| ' + discover.projectCount + ' projects' : ''}</div>
        </div>
        <div class="ml-auto">${statusBadge(installed ? 'active' : 'offline')}</div>
      </div>
    `;

    // Stats
    document.getElementById('claude-stats').innerHTML = `
      <div class="stat-card glass-card"><div class="stat-label">Projects</div><div class="stat-value">${stats.projectCount || projects.length}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Total Sessions</div><div class="stat-value">${stats.totalSessions || 0}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Active Today</div><div class="stat-value">${stats.activeToday || 0}</div></div>
    `;

    // Projects table
    const tbody = document.getElementById('claude-projects-body');
    if (!projects.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted p-4">No projects found</td></tr>';
    } else {
      tbody.innerHTML = projects.map(p => `
        <tr class="clickable" data-claude-project="${escapeHtml(p.id || p.path || '')}">
          <td class="font-semibold">${escapeHtml(p.name || p.path || '--')}</td>
          <td class="text-center">${p.sessionCount ?? '--'}</td>
          <td class="text-muted text-sm">${timeAgo(p.lastActivity)}</td>
          <td>${p.hasClaudeMd ? '<span class="badge badge-online">Yes</span>' : '<span class="badge badge-neutral">No</span>'}</td>
          <td>${p.hasMemory ? '<span class="badge badge-online">Yes</span>' : '<span class="badge badge-neutral">No</span>'}</td>
        </tr>
      `).join('');
    }

    // Recent activity
    try {
      const recentResp = await API.getClaudeRecent();
      const recent = recentResp.recent || recentResp || [];
      document.getElementById('claude-recent').innerHTML = recent.length
        ? '<div class="timeline">' + recent.map(r =>
          '<div class="timeline-item"><div class="tl-time">' + timeAgo(r.timestamp) + '</div><div class="tl-type">' + escapeHtml(r.type || r.event || '') + '</div><div class="tl-detail">' + escapeHtml(r.detail || r.project || '') + '</div></div>'
        ).join('') + '</div>'
        : '<div class="text-muted text-sm">No recent activity</div>';
    } catch { document.getElementById('claude-recent').innerHTML = '<div class="text-muted text-sm">--</div>'; }
  } catch (err) {
    document.getElementById('claude-discovery').innerHTML = '<div class="text-danger">' + escapeHtml(err.message) + '</div>';
  }
}

async function openClaudeProjectDetail(projectId) {
  const panel = document.getElementById('claude-detail');
  panel.classList.add('open');
  panel.innerHTML = '<div class="panel-header"><h2>Project</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-muted">Loading...</p>';
  try {
    const resp = await API.getClaudeProject(projectId);
    const p = resp.project || resp || {};

    let memoryHtml = '';
    try {
      const memResp = await API.getClaudeMemory(projectId);
      const memory = memResp.memory || memResp.content || '';
      if (memory) {
        memoryHtml = '<div class="section-title mt-6">Memory</div><pre class="glass-card p-3 text-sm" style="white-space:pre-wrap;max-height:300px;overflow:auto">' + escapeHtml(typeof memory === 'string' ? memory : JSON.stringify(memory, null, 2)) + '</pre>';
      }
    } catch { /* memory optional */ }

    let sessionsHtml = '';
    try {
      const sessResp = await API.getClaudeSessions(projectId);
      const sessions = sessResp.sessions || sessResp || [];
      if (sessions.length) {
        sessionsHtml = '<div class="section-title mt-6">Sessions</div>' + sessions.map(s =>
          '<div class="glass-card p-3 mb-2"><div class="flex items-center justify-between"><span class="text-sm font-semibold">' + escapeHtml(s.id || '--') + '</span><span class="text-xs text-muted">' + timeAgo(s.startedAt || s.timestamp) + '</span></div></div>'
        ).join('');
      }
    } catch { /* sessions optional */ }

    panel.innerHTML = `
      <div class="panel-header"><h2>${escapeHtml(p.name || p.path || projectId)}</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div>
      <div class="grid-2 mb-4">
        <div><span class="text-secondary text-sm">Path</span><div class="text-mono text-sm">${escapeHtml(p.path || '--')}</div></div>
        <div><span class="text-secondary text-sm">Sessions</span><div>${p.sessionCount ?? '--'}</div></div>
        <div><span class="text-secondary text-sm">CLAUDE.md</span><div>${p.hasClaudeMd ? 'Yes' : 'No'}</div></div>
        <div><span class="text-secondary text-sm">Last Activity</span><div>${timeAgo(p.lastActivity)}</div></div>
      </div>
      ${memoryHtml}
      ${sessionsHtml}
    `;
  } catch (err) {
    panel.innerHTML = '<div class="panel-header"><h2>Error</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-danger">' + escapeHtml(err.message) + '</p>';
  }
}

/* ===================================================================
   Skills Hub Page
   =================================================================== */

let _skillsCache = [];
let _skillsCategoryFilter = '';

async function renderSkillsPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Skills Hub</h1>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" id="skills-refresh">Refresh</button>
      </div>
    </div>
    <div class="stats-grid" id="skills-stats"></div>
    <div class="flex gap-2 mb-4 items-center">
      <div class="search-wrapper" style="flex:1;max-width:300px">
        <input type="text" id="skills-search" placeholder="Search skills..." style="width:100%">
      </div>
      <div id="skills-categories" class="flex gap-2"></div>
    </div>
    <div class="skill-grid" id="skills-grid">
      <div class="text-muted p-4">Loading skills...</div>
    </div>
  `;

  loadSkillsData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'skills-refresh' || e.target.closest('#skills-refresh')) {
      loadSkillsData();
      return;
    }
    const catBtn = e.target.closest('[data-skill-cat]');
    if (catBtn) {
      _skillsCategoryFilter = catBtn.dataset.skillCat;
      el.querySelectorAll('[data-skill-cat]').forEach(b => {
        b.className = b.dataset.skillCat === _skillsCategoryFilter ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';
      });
      renderSkillsGrid();
      return;
    }
    const installBtn = e.target.closest('[data-skill-install]');
    if (installBtn) {
      installSkillAction(installBtn.dataset.skillInstall);
      return;
    }
    const uninstallBtn = e.target.closest('[data-skill-uninstall]');
    if (uninstallBtn) {
      uninstallSkillAction(uninstallBtn.dataset.skillUninstall);
      return;
    }
    const scanBtn = e.target.closest('[data-skill-scan]');
    if (scanBtn) {
      scanSkillAction(scanBtn.dataset.skillScan);
      return;
    }
  });

  document.getElementById('skills-search')?.addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    if (!q) { renderSkillsGrid(); return; }
    try {
      const resp = await API.searchSkillsHub(q);
      _skillsCache = resp.skills || resp || [];
      renderSkillsGrid();
    } catch { /* ignore search errors */ }
  });
}

async function loadSkillsData() {
  try {
    const [skillsResp, statsResp, catsResp] = await Promise.all([
      API.getSkillsHub(),
      API.getSkillsHubStats().catch(() => ({})),
      API.getSkillsHubCategories().catch(() => ({ categories: [] }))
    ]);
    _skillsCache = skillsResp.skills || skillsResp || [];
    const stats = statsResp.stats || statsResp || {};
    const categories = catsResp.categories || catsResp || [];

    document.getElementById('skills-stats').innerHTML = `
      <div class="stat-card glass-card"><div class="stat-label">Total</div><div class="stat-value">${stats.total || _skillsCache.length}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Installed</div><div class="stat-value text-success">${stats.installed || 0}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Active</div><div class="stat-value">${stats.active || 0}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Quarantined</div><div class="stat-value text-danger">${stats.quarantined || 0}</div></div>
    `;

    const allCats = ['All', ...categories.map(c => typeof c === 'string' ? c : c.name || '')].filter(Boolean);
    document.getElementById('skills-categories').innerHTML = allCats.map(c => {
      const val = c === 'All' ? '' : c.toLowerCase();
      return '<button class="btn btn-sm ' + (val === _skillsCategoryFilter ? 'btn-primary' : 'btn-ghost') + '" data-skill-cat="' + escapeHtml(val) + '">' + escapeHtml(c) + '</button>';
    }).join('');

    renderSkillsGrid();
  } catch (err) {
    document.getElementById('skills-grid').innerHTML = '<div class="text-danger p-4">' + escapeHtml(err.message) + '</div>';
  }
}

function renderSkillsGrid() {
  const filtered = _skillsCategoryFilter
    ? _skillsCache.filter(s => (s.category || '').toLowerCase() === _skillsCategoryFilter)
    : _skillsCache;
  const grid = document.getElementById('skills-grid');
  if (!filtered.length) {
    grid.innerHTML = '<div class="text-muted p-4">No skills found</div>';
    return;
  }
  grid.innerHTML = filtered.map(s => {
    const score = s.securityScore ?? s.score ?? 0;
    const scoreColor = score >= 80 ? '#22c55e' : score >= 50 ? '#eab308' : '#ef4444';
    const installed = s.installed || s.status === 'installed' || s.status === 'active';
    return `
      <div class="skill-card">
        <div class="flex items-center justify-between mb-2">
          <span class="font-semibold">${escapeHtml(s.name || s.id)}</span>
          ${statusBadge(s.status || (installed ? 'active' : 'available'))}
        </div>
        <div class="text-sm text-muted mb-2">${escapeHtml(s.description || '')}</div>
        <div class="flex items-center gap-2 mb-2">
          <span class="badge badge-neutral text-xs">${escapeHtml(s.category || 'general')}</span>
        </div>
        <div class="text-xs text-muted">Security Score: ${score}/100</div>
        <div class="skill-score-meter"><div class="skill-score-fill" style="width:${score}%;background:${scoreColor}"></div></div>
        <div class="flex gap-2 mt-3">
          ${installed
            ? '<button class="btn btn-xs btn-ghost" data-skill-uninstall="' + escapeHtml(s.id) + '">Uninstall</button>'
            : '<button class="btn btn-xs btn-primary" data-skill-install="' + escapeHtml(s.id) + '">Install</button>'
          }
          <button class="btn btn-xs btn-ghost" data-skill-scan="${escapeHtml(s.id)}">Scan</button>
        </div>
      </div>
    `;
  }).join('');
}

async function installSkillAction(id) {
  try { await API.installSkill(id); App.showToast('Skill installed', 'success'); loadSkillsData(); }
  catch (e) { App.showToast(e.message, 'error'); }
}

async function uninstallSkillAction(id) {
  try { await API.uninstallSkill(id); App.showToast('Skill uninstalled', 'success'); loadSkillsData(); }
  catch (e) { App.showToast(e.message, 'error'); }
}

async function scanSkillAction(id) {
  try { const resp = await API.scanSkill(id); App.showToast('Scan complete: ' + (resp.result || 'OK'), 'success'); loadSkillsData(); }
  catch (e) { App.showToast(e.message, 'error'); }
}

/* ===================================================================
   Evaluations Page
   =================================================================== */

let _evalsCache = [];

async function renderEvaluationsPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Evaluations</h1>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" id="evals-refresh">Refresh</button>
      </div>
    </div>
    <div class="stats-grid" id="evals-fleet-stats"></div>
    <div class="grid-2 mb-6">
      <div>
        <div class="section-title">Quality Gates</div>
        <div id="evals-gates"><div class="text-muted text-sm">Loading...</div></div>
      </div>
      <div>
        <div class="section-title flex items-center justify-between">
          <span>Agent Scorecard</span>
        </div>
        <div class="form-group">
          <div class="flex gap-2">
            <input type="text" id="eval-agent-id" placeholder="Agent ID" style="flex:1">
            <button class="btn btn-sm btn-primary" id="eval-agent-btn">View</button>
            <button class="btn btn-sm btn-ghost" id="eval-run-btn">Run Eval</button>
          </div>
        </div>
        <div id="evals-agent-scorecard"></div>
        <div id="evals-agent-optimize" class="mt-4"></div>
      </div>
    </div>
    <div class="section-title">Evaluation History</div>
    <div class="glass-card table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Score</th>
            <th>Result</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody id="evals-table-body">
          <tr><td colspan="4" class="text-center text-muted p-4">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  `;

  loadEvalsData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'evals-refresh' || e.target.closest('#evals-refresh')) {
      loadEvalsData();
      return;
    }
    if (e.target.id === 'eval-agent-btn' || e.target.closest('#eval-agent-btn')) {
      const agentId = document.getElementById('eval-agent-id')?.value.trim();
      if (agentId) loadAgentScorecard(agentId);
      return;
    }
    if (e.target.id === 'eval-run-btn' || e.target.closest('#eval-run-btn')) {
      const agentId = document.getElementById('eval-agent-id')?.value.trim();
      if (agentId) runEvaluation(agentId);
      return;
    }
  });
}

async function loadEvalsData() {
  try {
    const [fleetResp, gatesResp, evalsResp] = await Promise.all([
      API.getFleetScorecard().catch(() => ({})),
      API.getQualityGates().catch(() => ({ gates: [] })),
      API.getEvaluations().catch(() => ({ evaluations: [] }))
    ]);

    const fleet = fleetResp.scorecard || fleetResp || {};
    const gates = gatesResp.gates || gatesResp || [];
    const evals = evalsResp.evaluations || evalsResp || [];
    _evalsCache = evals;

    document.getElementById('evals-fleet-stats').innerHTML = `
      <div class="stat-card glass-card"><div class="stat-label">Fleet Avg Score</div><div class="stat-value">${fleet.averageScore != null ? fleet.averageScore.toFixed(1) : '--'}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Pass Rate</div><div class="stat-value">${fleet.passRate != null ? (fleet.passRate * 100).toFixed(0) + '%' : '--'}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Total Evaluations</div><div class="stat-value">${fleet.totalEvaluations || evals.length}</div></div>
    `;

    document.getElementById('evals-gates').innerHTML = gates.length
      ? gates.map(g => `
        <div class="glass-card p-3 mb-2">
          <div class="flex items-center justify-between">
            <span class="font-semibold text-sm">${escapeHtml(g.name || g.id)}</span>
            <span class="text-xs text-muted">Min: ${g.minScore || '--'}</span>
          </div>
          <div class="text-xs text-muted mt-1">${escapeHtml(g.criteria || g.description || '')}</div>
        </div>
      `).join('')
      : '<div class="text-muted text-sm">No quality gates configured</div>';

    const tbody = document.getElementById('evals-table-body');
    if (!evals.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted p-4">No evaluations yet</td></tr>';
    } else {
      tbody.innerHTML = evals.slice(0, 50).map(e => `
        <tr>
          <td class="text-sm">${escapeHtml(e.agentId || e.agent || '--')}</td>
          <td class="font-semibold">${e.score != null ? e.score.toFixed(1) : '--'}</td>
          <td>${statusBadge(e.passed ? 'active' : e.passed === false ? 'failed' : 'pending')}</td>
          <td class="text-muted text-sm">${timeAgo(e.timestamp || e.createdAt)}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    document.getElementById('evals-fleet-stats').innerHTML = '<div class="text-danger p-4">' + escapeHtml(err.message) + '</div>';
  }
}

async function loadAgentScorecard(agentId) {
  const container = document.getElementById('evals-agent-scorecard');
  container.innerHTML = '<div class="text-muted text-sm">Loading scorecard...</div>';
  try {
    const resp = await API.getAgentScorecard(agentId);
    const sc = resp.scorecard || resp || {};
    container.innerHTML = `
      <div class="glass-card p-4">
        <div class="flex items-center justify-between mb-2">
          <span class="font-semibold">${escapeHtml(agentId)}</span>
          <span class="stat-value">${sc.score != null ? sc.score.toFixed(1) : '--'}</span>
        </div>
        <div class="text-sm mb-2">${statusBadge(sc.passed ? 'active' : sc.passed === false ? 'failed' : 'pending')}</div>
        <div class="text-xs text-muted">Evaluations: ${sc.totalEvaluations || '--'} | Last: ${timeAgo(sc.lastEvaluation)}</div>
      </div>
    `;

    // Load optimization hints
    try {
      const optResp = await API.getAgentOptimize(agentId);
      const hints = optResp.hints || optResp.recommendations || optResp || [];
      const hintsArr = Array.isArray(hints) ? hints : [];
      document.getElementById('evals-agent-optimize').innerHTML = hintsArr.length
        ? '<div class="section-title">Optimization Hints</div>' + hintsArr.map(h =>
          '<div class="glass-card p-3 mb-2 text-sm">' + escapeHtml(typeof h === 'string' ? h : h.message || h.hint || JSON.stringify(h)) + '</div>'
        ).join('')
        : '';
    } catch { /* optimize optional */ }
  } catch (err) {
    container.innerHTML = '<div class="text-danger text-sm">' + escapeHtml(err.message) + '</div>';
  }
}

async function runEvaluation(agentId) {
  try {
    await API.evaluateAgent(agentId);
    App.showToast('Evaluation started for ' + agentId, 'success');
    loadEvalsData();
    loadAgentScorecard(agentId);
  } catch (e) { App.showToast(e.message, 'error'); }
}

/* ===================================================================
   Scheduler Page
   =================================================================== */

let _schedulerJobsCache = [];

async function renderSchedulerPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Scheduler</h1>
      <div class="page-actions">
        <button class="btn btn-primary btn-sm" id="new-scheduler-job-btn">New Job</button>
        <button class="btn btn-ghost btn-sm" id="scheduler-refresh">Refresh</button>
      </div>
    </div>
    <div class="glass-card table-wrapper mb-6">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Schedule</th>
            <th>Cron</th>
            <th>Status</th>
            <th>Last Run</th>
            <th>Next Run</th>
            <th>Runs</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="scheduler-table-body">
          <tr><td colspan="8" class="text-center text-muted p-4">Loading jobs...</td></tr>
        </tbody>
      </table>
    </div>
    <div id="scheduler-detail" class="detail-panel"></div>
  `;

  loadSchedulerData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'scheduler-refresh' || e.target.closest('#scheduler-refresh')) {
      loadSchedulerData();
      return;
    }
    if (e.target.id === 'new-scheduler-job-btn' || e.target.closest('#new-scheduler-job-btn')) {
      showNewSchedulerJobModal();
      return;
    }
    const runBtn = e.target.closest('[data-sched-run]');
    if (runBtn) { runSchedulerJobAction(runBtn.dataset.schedRun); return; }
    const pauseBtn = e.target.closest('[data-sched-pause]');
    if (pauseBtn) { pauseSchedulerJobAction(pauseBtn.dataset.schedPause); return; }
    const resumeBtn = e.target.closest('[data-sched-resume]');
    if (resumeBtn) { resumeSchedulerJobAction(resumeBtn.dataset.schedResume); return; }
    const delBtn = e.target.closest('[data-sched-delete]');
    if (delBtn) { deleteSchedulerJobAction(delBtn.dataset.schedDelete); return; }
    const row = e.target.closest('tr[data-sched-id]');
    if (row && !e.target.closest('button')) {
      openSchedulerJobDetail(row.dataset.schedId);
      return;
    }
    if (e.target.closest('.panel-close')) {
      document.getElementById('scheduler-detail')?.classList.remove('open');
      return;
    }
  });
}

async function loadSchedulerData() {
  try {
    const resp = await API.getSchedulerJobs();
    _schedulerJobsCache = resp.jobs || resp || [];
    const tbody = document.getElementById('scheduler-table-body');
    if (!_schedulerJobsCache.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted p-4">No scheduled jobs</td></tr>';
      return;
    }
    tbody.innerHTML = _schedulerJobsCache.map(j => {
      const isPaused = j.status === 'paused';
      return `
        <tr class="clickable" data-sched-id="${escapeHtml(j.id)}">
          <td class="font-semibold">${escapeHtml(j.name || j.id)}</td>
          <td class="text-sm">${escapeHtml(j.schedule || j.expression || '--')}</td>
          <td class="text-mono text-sm">${escapeHtml(j.cron || '--')}</td>
          <td>${statusBadge(j.status || 'active')}</td>
          <td class="text-muted text-sm">${timeAgo(j.lastRun)}</td>
          <td class="text-muted text-sm">${j.nextRun ? new Date(j.nextRun).toLocaleString() : '--'}</td>
          <td class="text-center">${j.runCount ?? '--'}</td>
          <td>
            <button class="btn btn-xs btn-ghost" data-sched-run="${escapeHtml(j.id)}" title="Run now">Run</button>
            ${isPaused
              ? '<button class="btn btn-xs btn-ghost" data-sched-resume="' + escapeHtml(j.id) + '">Resume</button>'
              : '<button class="btn btn-xs btn-ghost" data-sched-pause="' + escapeHtml(j.id) + '">Pause</button>'
            }
            <button class="btn btn-xs btn-danger" data-sched-delete="${escapeHtml(j.id)}">Del</button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    document.getElementById('scheduler-table-body').innerHTML =
      '<tr><td colspan="8" class="text-center text-danger p-4">' + escapeHtml(err.message) + '</td></tr>';
  }
}

function showNewSchedulerJobModal() {
  App.showModal('New Scheduled Job', `
    <div class="form-group"><label>Name</label><input type="text" id="sched-name" placeholder="Job name" style="width:100%"></div>
    <div class="form-group"><label>Schedule Expression</label><input type="text" id="sched-expression" placeholder="every 5 minutes" style="width:100%"></div>
    <div class="form-group"><label>Parsed Cron</label><div id="sched-parsed" class="text-mono text-sm text-muted p-2">--</div></div>
    <div class="form-group"><label>Action Type</label>
      <select id="sched-action-type" style="width:100%">
        <option value="http">HTTP Request</option>
        <option value="eval">Evaluation</option>
        <option value="backup">Backup</option>
        <option value="custom">Custom</option>
      </select>
    </div>
  `, [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Create', class: 'btn btn-primary', action: async () => {
      const name = document.getElementById('sched-name')?.value.trim();
      const expression = document.getElementById('sched-expression')?.value.trim();
      const actionType = document.getElementById('sched-action-type')?.value;
      if (!name || !expression) { App.showToast('Name and schedule required', 'error'); return; }
      try {
        await API.createSchedulerJob({ name, expression, actionType });
        App.hideModal();
        App.showToast('Job created', 'success');
        loadSchedulerData();
      } catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);

  // Live parse preview
  const exprInput = document.getElementById('sched-expression');
  let parseTimeout;
  exprInput?.addEventListener('input', () => {
    clearTimeout(parseTimeout);
    parseTimeout = setTimeout(async () => {
      const expr = exprInput.value.trim();
      if (!expr) { document.getElementById('sched-parsed').textContent = '--'; return; }
      try {
        const resp = await API.parseSchedule(expr);
        document.getElementById('sched-parsed').textContent = resp.cron || resp.parsed || JSON.stringify(resp);
      } catch { document.getElementById('sched-parsed').textContent = 'Invalid expression'; }
    }, 500);
  });
}

async function runSchedulerJobAction(id) {
  try { await API.runSchedulerJob(id); App.showToast('Job triggered', 'success'); loadSchedulerData(); }
  catch (e) { App.showToast(e.message, 'error'); }
}

async function pauseSchedulerJobAction(id) {
  try { await API.pauseSchedulerJob(id); App.showToast('Job paused', 'success'); loadSchedulerData(); }
  catch (e) { App.showToast(e.message, 'error'); }
}

async function resumeSchedulerJobAction(id) {
  try { await API.resumeSchedulerJob(id); App.showToast('Job resumed', 'success'); loadSchedulerData(); }
  catch (e) { App.showToast(e.message, 'error'); }
}

async function deleteSchedulerJobAction(id) {
  App.showModal('Delete Job', '<p>Delete scheduled job <strong>' + escapeHtml(id) + '</strong>?</p>', [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Delete', class: 'btn btn-danger', action: async () => {
      try { await API.deleteSchedulerJob(id); App.hideModal(); App.showToast('Job deleted', 'success'); loadSchedulerData(); }
      catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

async function openSchedulerJobDetail(jobId) {
  const panel = document.getElementById('scheduler-detail');
  panel.classList.add('open');
  panel.innerHTML = '<div class="panel-header"><h2>Job Details</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-muted">Loading...</p>';
  try {
    const j = _schedulerJobsCache.find(x => x.id === jobId) || {};
    let historyHtml = '';
    try {
      const histResp = await API.getSchedulerHistory(jobId);
      const history = histResp.history || histResp || [];
      if (history.length) {
        historyHtml = `
          <div class="section-title mt-6">Run History</div>
          <div class="glass-card table-wrapper">
            <table>
              <thead><tr><th>Time</th><th>Status</th><th>Duration</th></tr></thead>
              <tbody>${history.slice(0, 20).map(h => `
                <tr>
                  <td class="text-sm">${timeAgo(h.timestamp || h.startedAt)}</td>
                  <td>${statusBadge(h.status || (h.success ? 'active' : 'failed'))}</td>
                  <td class="text-mono text-sm">${h.duration != null ? h.duration + 'ms' : '--'}</td>
                </tr>
              `).join('')}</tbody>
            </table>
          </div>
        `;
      }
    } catch { /* history optional */ }

    panel.innerHTML = `
      <div class="panel-header"><h2>${escapeHtml(j.name || jobId)}</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div>
      <div class="mb-4">${statusBadge(j.status || 'active')}</div>
      <div class="grid-2 mb-4">
        <div><span class="text-secondary text-sm">Schedule</span><div>${escapeHtml(j.schedule || j.expression || '--')}</div></div>
        <div><span class="text-secondary text-sm">Cron</span><div class="text-mono">${escapeHtml(j.cron || '--')}</div></div>
        <div><span class="text-secondary text-sm">Last Run</span><div>${timeAgo(j.lastRun)}</div></div>
        <div><span class="text-secondary text-sm">Next Run</span><div>${j.nextRun ? new Date(j.nextRun).toLocaleString() : '--'}</div></div>
        <div><span class="text-secondary text-sm">Run Count</span><div>${j.runCount ?? '--'}</div></div>
        <div><span class="text-secondary text-sm">Action</span><div>${escapeHtml(j.actionType || j.action || '--')}</div></div>
      </div>
      ${historyHtml}
    `;
  } catch (err) {
    panel.innerHTML = '<div class="panel-header"><h2>Error</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-danger">' + escapeHtml(err.message) + '</p>';
  }
}

/* ===================================================================
   Security Page
   =================================================================== */

async function renderSecurityPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Security</h1>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" id="security-refresh">Refresh</button>
      </div>
    </div>
    <div class="stats-grid" id="security-stats"></div>
    <div class="grid-2 mb-6">
      <div>
        <div class="section-title">Security Profile</div>
        <div id="security-profile" class="mb-4"><div class="text-muted text-sm">Loading...</div></div>
        <div class="section-title">Posture Score</div>
        <div id="security-posture" class="mb-4"></div>
      </div>
      <div>
        <div class="section-title">Secret Scanner</div>
        <div class="glass-card p-4">
          <textarea class="scanner-input" id="secret-scan-input" placeholder="Paste text to scan for secrets..."></textarea>
          <button class="btn btn-sm btn-primary mt-2" id="secret-scan-btn">Scan</button>
          <div id="secret-scan-results" class="mt-2"></div>
        </div>
      </div>
    </div>
    <div class="section-title">Security Events</div>
    <div class="glass-card table-wrapper mb-6">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>Severity</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody id="security-events-body">
          <tr><td colspan="4" class="text-center text-muted p-4">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  `;

  loadSecurityData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'security-refresh' || e.target.closest('#security-refresh')) {
      loadSecurityData();
      return;
    }
    if (e.target.id === 'secret-scan-btn' || e.target.closest('#secret-scan-btn')) {
      runSecretScan();
      return;
    }
    const profileBtn = e.target.closest('[data-sec-profile]');
    if (profileBtn) {
      setSecurityProfileAction(profileBtn.dataset.secProfile);
      return;
    }
  });
}

async function loadSecurityData() {
  try {
    const [profileResp, statsResp, eventsResp] = await Promise.all([
      API.getSecurityProfile().catch(() => ({})),
      API.getSecurityStats().catch(() => ({})),
      API.getSecurityEvents().catch(() => ({ events: [] }))
    ]);

    const profile = profileResp.profile || profileResp.profileId || profileResp || {};
    const profileId = typeof profile === 'string' ? profile : profile.id || profile.profileId || 'standard';
    const stats = statsResp.stats || statsResp || {};
    const events = eventsResp.events || eventsResp || [];

    // Stats
    document.getElementById('security-stats').innerHTML = `
      <div class="stat-card glass-card"><div class="stat-label">Active Profile</div><div class="stat-value">${escapeHtml(profileId)}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Events (24h)</div><div class="stat-value">${stats.eventsToday || stats.total || 0}</div></div>
      <div class="stat-card glass-card"><div class="stat-label">Threats Blocked</div><div class="stat-value text-success">${stats.blocked || 0}</div></div>
    `;

    // Profile selector
    const profiles = ['minimal', 'standard', 'strict'];
    document.getElementById('security-profile').innerHTML = `
      <div class="profile-selector">
        ${profiles.map(p => `
          <button class="profile-btn profile-${p} ${p === profileId ? 'active' : ''}" data-sec-profile="${p}">${p.charAt(0).toUpperCase() + p.slice(1)}</button>
        `).join('')}
      </div>
    `;

    // Posture score from doctor
    try {
      const doctorResp = await API.getDoctor();
      const doctor = doctorResp.results || doctorResp || {};
      const posture = doctor.posture || doctor.score || {};
      const score = posture.score ?? posture.overall ?? '--';
      document.getElementById('security-posture').innerHTML = `
        <div class="glass-card p-4">
          <div class="stat-value">${typeof score === 'number' ? score.toFixed(0) + '/100' : escapeHtml(String(score))}</div>
          <div class="text-xs text-muted mt-1">Overall security posture</div>
        </div>
      `;
    } catch { document.getElementById('security-posture').innerHTML = '<div class="text-muted text-sm">Run Doctor diagnostics to see posture score</div>'; }

    // Events table
    const tbody = document.getElementById('security-events-body');
    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted p-4">No security events</td></tr>';
    } else {
      tbody.innerHTML = events.slice(0, 50).map(ev => `
        <tr>
          <td class="text-muted text-sm">${timeAgo(ev.timestamp)}</td>
          <td class="text-sm">${escapeHtml(ev.type || ev.event || '--')}</td>
          <td>${statusBadge(ev.severity || ev.level || 'info')}</td>
          <td class="text-sm">${escapeHtml(ev.detail || ev.message || '--')}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    document.getElementById('security-stats').innerHTML = '<div class="text-danger p-4">' + escapeHtml(err.message) + '</div>';
  }
}

async function setSecurityProfileAction(profileId) {
  try {
    await API.setSecurityProfile(profileId);
    App.showToast('Security profile set to ' + profileId, 'success');
    loadSecurityData();
  } catch (e) { App.showToast(e.message, 'error'); }
}

async function runSecretScan() {
  const text = document.getElementById('secret-scan-input')?.value;
  const resultsEl = document.getElementById('secret-scan-results');
  if (!text || !text.trim()) { App.showToast('Enter text to scan', 'error'); return; }
  resultsEl.innerHTML = '<div class="text-muted text-sm">Scanning...</div>';
  try {
    const resp = await API.scanSecrets(text);
    const findings = resp.findings || resp.results || resp || [];
    if (!findings.length) {
      resultsEl.innerHTML = '<div class="scanner-result" style="background:rgba(34,197,94,0.15);border-left:3px solid #22c55e">No secrets detected</div>';
      return;
    }
    resultsEl.innerHTML = findings.map(f => {
      const severity = (f.severity || f.level || 'medium').toLowerCase();
      return '<div class="scanner-result scanner-' + severity + '">' + escapeHtml(f.type || f.pattern || 'Secret') + ': ' + escapeHtml(f.detail || f.match || f.message || '') + '</div>';
    }).join('');
  } catch (err) {
    resultsEl.innerHTML = '<div class="text-danger text-sm">' + escapeHtml(err.message) + '</div>';
  }
}

/* ===================================================================
   Users Page
   =================================================================== */

let _usersCache = [];

async function renderUsersPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Users</h1>
      <div class="page-actions">
        <button class="btn btn-primary btn-sm" id="new-user-btn">Create User</button>
        <button class="btn btn-ghost btn-sm" id="users-refresh">Refresh</button>
      </div>
    </div>
    <div class="glass-card table-wrapper mb-6">
      <table>
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>MFA</th>
            <th>API Keys</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="users-table-body">
          <tr><td colspan="5" class="text-center text-muted p-4">Loading users...</td></tr>
        </tbody>
      </table>
    </div>
    <div id="user-detail" class="detail-panel"></div>
  `;

  loadUsersData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'users-refresh' || e.target.closest('#users-refresh')) {
      loadUsersData();
      return;
    }
    if (e.target.id === 'new-user-btn' || e.target.closest('#new-user-btn')) {
      showNewUserModal();
      return;
    }
    const row = e.target.closest('tr[data-user-id]');
    if (row) {
      openUserDetail(row.dataset.userId);
      return;
    }
    if (e.target.closest('.panel-close')) {
      document.getElementById('user-detail')?.classList.remove('open');
      return;
    }
  });
}

async function loadUsersData() {
  try {
    const resp = await API.getUsers();
    _usersCache = resp.users || resp || [];
    const tbody = document.getElementById('users-table-body');
    if (!_usersCache.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted p-4">No users</td></tr>';
      return;
    }
    tbody.innerHTML = _usersCache.map(u => `
      <tr class="clickable" data-user-id="${escapeHtml(u.id || u.username)}">
        <td class="font-semibold">${escapeHtml(u.username)}</td>
        <td><span class="badge badge-neutral">${escapeHtml(u.role || 'viewer')}</span></td>
        <td>${u.mfaEnabled ? '<span class="badge badge-online">Enabled</span>' : '<span class="badge badge-neutral">Off</span>'}</td>
        <td class="text-center">${u.apiKeyCount ?? u.apiKeys ?? '--'}</td>
        <td>${statusBadge(u.disabled ? 'stopped' : 'active')}</td>
      </tr>
    `).join('');
  } catch (err) {
    document.getElementById('users-table-body').innerHTML =
      '<tr><td colspan="5" class="text-center text-danger p-4">' + escapeHtml(err.message) + '</td></tr>';
  }
}

function showNewUserModal() {
  App.showModal('Create User', `
    <div class="form-group"><label>Username</label><input type="text" id="new-user-name" placeholder="username" style="width:100%"></div>
    <div class="form-group"><label>Password</label><input type="password" id="new-user-pass" placeholder="password" style="width:100%"></div>
    <div class="form-group"><label>Role</label>
      <select id="new-user-role" style="width:100%">
        <option value="viewer">Viewer</option>
        <option value="operator">Operator</option>
        <option value="auditor">Auditor</option>
        <option value="admin">Admin</option>
      </select>
    </div>
  `, [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Create', class: 'btn btn-primary', action: async () => {
      const username = document.getElementById('new-user-name')?.value.trim();
      const password = document.getElementById('new-user-pass')?.value;
      const role = document.getElementById('new-user-role')?.value;
      if (!username || !password) { App.showToast('Username and password required', 'error'); return; }
      try {
        await API.createUser({ username, password, role });
        App.hideModal();
        App.showToast('User created', 'success');
        loadUsersData();
      } catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

async function openUserDetail(userId) {
  const panel = document.getElementById('user-detail');
  panel.classList.add('open');
  panel.innerHTML = '<div class="panel-header"><h2>User Details</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-muted">Loading...</p>';
  try {
    const u = _usersCache.find(x => (x.id || x.username) === userId) || {};

    let apiKeysHtml = '';
    try {
      const keysResp = await API.listApiKeys(userId);
      const keys = keysResp.keys || keysResp || [];
      apiKeysHtml = `
        <div class="section-title mt-6 flex items-center justify-between">
          <span>API Keys</span>
          <button class="btn btn-xs btn-primary" id="create-api-key-btn">Create Key</button>
        </div>
        <div id="api-keys-list">
          ${keys.length ? keys.map(k => `
            <div class="glass-card p-3 mb-2 flex items-center justify-between">
              <div>
                <span class="text-mono text-sm">${escapeHtml(k.prefix || k.id || '--')}...</span>
                <span class="text-xs text-muted ml-2">${timeAgo(k.createdAt)}</span>
              </div>
              <button class="btn btn-xs btn-danger" data-revoke-key="${escapeHtml(k.prefix || k.id)}">Revoke</button>
            </div>
          `).join('') : '<div class="text-muted text-sm">No API keys</div>'}
        </div>
        <div id="api-key-created" class="mt-2"></div>
      `;
    } catch { apiKeysHtml = '<div class="text-muted text-sm mt-4">API keys not available</div>'; }

    const roles = ['viewer', 'operator', 'auditor', 'admin'];
    const roleOptions = roles.map(r =>
      '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r.charAt(0).toUpperCase() + r.slice(1) + '</option>'
    ).join('');

    panel.innerHTML = `
      <div class="panel-header"><h2>${escapeHtml(u.username || userId)}</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div>
      <div class="mb-4">${statusBadge(u.disabled ? 'stopped' : 'active')}</div>
      <div class="grid-2 mb-4">
        <div><span class="text-secondary text-sm">Role</span><div>${escapeHtml(u.role || 'viewer')}</div></div>
        <div><span class="text-secondary text-sm">MFA</span><div>${u.mfaEnabled ? 'Enabled' : 'Disabled'}</div></div>
      </div>
      <div class="form-group">
        <label>Change Role</label>
        <div class="flex gap-2">
          <select id="user-role-select" style="flex:1">${roleOptions}</select>
          <button class="btn btn-sm btn-primary" id="user-role-btn">Update</button>
        </div>
      </div>
      <div class="flex gap-2 mb-4">
        <button class="btn btn-sm btn-danger" id="user-delete-btn">Delete User</button>
      </div>
      ${apiKeysHtml}
    `;

    document.getElementById('user-role-btn')?.addEventListener('click', async () => {
      const role = document.getElementById('user-role-select')?.value;
      try { await API.setUserRole(userId, role); App.showToast('Role updated', 'success'); loadUsersData(); }
      catch (e) { App.showToast(e.message, 'error'); }
    });

    document.getElementById('user-delete-btn')?.addEventListener('click', () => {
      App.showModal('Delete User', '<p>Delete user <strong>' + escapeHtml(u.username || userId) + '</strong>? This cannot be undone.</p>', [
        { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
        { label: 'Delete', class: 'btn btn-danger', action: async () => {
          try { await API.deleteUser(userId); App.hideModal(); App.showToast('User deleted', 'success'); panel.classList.remove('open'); loadUsersData(); }
          catch (e) { App.showToast(e.message, 'error'); }
        }}
      ]);
    });

    document.getElementById('create-api-key-btn')?.addEventListener('click', async () => {
      try {
        const resp = await API.createApiKey(userId);
        const key = resp.key || resp.apiKey || '';
        document.getElementById('api-key-created').innerHTML =
          '<div class="glass-card p-3" style="border-left:3px solid #22c55e"><div class="text-xs text-muted mb-1">New API Key (copy now, shown once):</div><div class="text-mono text-sm" style="word-break:break-all">' + escapeHtml(key) + '</div></div>';
        openUserDetail(userId); // refresh key list
      } catch (e) { App.showToast(e.message, 'error'); }
    });

    panel.querySelectorAll('[data-revoke-key]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try { await API.revokeApiKey(userId, btn.dataset.revokeKey); App.showToast('Key revoked', 'success'); openUserDetail(userId); }
        catch (e) { App.showToast(e.message, 'error'); }
      });
    });
  } catch (err) {
    panel.innerHTML = '<div class="panel-header"><h2>Error</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-danger">' + escapeHtml(err.message) + '</p>';
  }
}

/* ===================================================================
   Projects Page
   =================================================================== */

let _projectsCache = [];

async function renderProjectsPage() {
  const el = document.getElementById('content');
  el.innerHTML = `
    <div class="page-header">
      <h1>Projects</h1>
      <div class="page-actions">
        <button class="btn btn-primary btn-sm" id="new-project-btn">New Project</button>
        <button class="btn btn-ghost btn-sm" id="projects-refresh">Refresh</button>
      </div>
    </div>
    <div class="project-grid" id="projects-grid">
      <div class="text-muted p-4">Loading projects...</div>
    </div>
    <div id="project-detail" class="detail-panel"></div>
  `;

  loadProjectsData();

  el.addEventListener('click', function handler(e) {
    if (document.getElementById('content') !== el) { el.removeEventListener('click', handler); return; }

    if (e.target.id === 'projects-refresh' || e.target.closest('#projects-refresh')) {
      loadProjectsData();
      return;
    }
    if (e.target.id === 'new-project-btn' || e.target.closest('#new-project-btn')) {
      showNewProjectModal();
      return;
    }
    const card = e.target.closest('.project-card[data-project-id]');
    if (card) {
      openProjectDetail(card.dataset.projectId);
      return;
    }
    if (e.target.closest('.panel-close')) {
      document.getElementById('project-detail')?.classList.remove('open');
      return;
    }
  });
}

async function loadProjectsData() {
  try {
    const resp = await API.getProjects();
    _projectsCache = resp.projects || resp || [];
    const grid = document.getElementById('projects-grid');
    if (!_projectsCache.length) {
      grid.innerHTML = '<div class="text-muted p-4">No projects</div>';
      return;
    }
    grid.innerHTML = _projectsCache.map(p => `
      <div class="project-card" data-project-id="${escapeHtml(p.id)}">
        <div class="flex items-center justify-between mb-2">
          <span class="font-semibold">${escapeHtml(p.name || p.id)}</span>
          ${statusBadge(p.status || 'active')}
        </div>
        <div class="text-sm text-muted mb-3">${escapeHtml(p.description || 'No description')}</div>
        <div class="flex gap-4 text-xs text-muted">
          <span>Agents: ${p.agentCount ?? '--'}</span>
          <span>Sessions: ${p.sessionCount ?? '--'}</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    document.getElementById('projects-grid').innerHTML = '<div class="text-danger p-4">' + escapeHtml(err.message) + '</div>';
  }
}

function showNewProjectModal() {
  App.showModal('New Project', `
    <div class="form-group"><label>Name</label><input type="text" id="proj-name" placeholder="Project name" style="width:100%"></div>
    <div class="form-group"><label>Description</label><textarea id="proj-desc" placeholder="Description" style="width:100%;min-height:60px"></textarea></div>
  `, [
    { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
    { label: 'Create', class: 'btn btn-primary', action: async () => {
      const name = document.getElementById('proj-name')?.value.trim();
      if (!name) { App.showToast('Name required', 'error'); return; }
      const description = document.getElementById('proj-desc')?.value.trim();
      try {
        await API.createProject({ name, description });
        App.hideModal();
        App.showToast('Project created', 'success');
        loadProjectsData();
      } catch (e) { App.showToast(e.message, 'error'); }
    }}
  ]);
}

async function openProjectDetail(projectId) {
  const panel = document.getElementById('project-detail');
  panel.classList.add('open');
  panel.innerHTML = '<div class="panel-header"><h2>Project</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-muted">Loading...</p>';
  try {
    const p = _projectsCache.find(x => x.id === projectId) || {};
    const isActive = (p.status || 'active') !== 'archived';

    panel.innerHTML = `
      <div class="panel-header"><h2>${escapeHtml(p.name || projectId)}</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div>
      <div class="mb-4">${statusBadge(p.status || 'active')}</div>
      <div class="mb-4 text-sm">${escapeHtml(p.description || 'No description')}</div>
      <div class="grid-2 mb-4">
        <div><span class="text-secondary text-sm">Agents</span><div>${p.agentCount ?? '--'}</div></div>
        <div><span class="text-secondary text-sm">Sessions</span><div>${p.sessionCount ?? '--'}</div></div>
        <div><span class="text-secondary text-sm">Created</span><div>${timeAgo(p.createdAt)}</div></div>
        <div><span class="text-secondary text-sm">Updated</span><div>${timeAgo(p.updatedAt)}</div></div>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-sm ${isActive ? 'btn-ghost' : 'btn-primary'}" id="project-toggle-btn">${isActive ? 'Archive' : 'Activate'}</button>
        <button class="btn btn-sm btn-danger" id="project-delete-btn">Delete</button>
      </div>
    `;

    document.getElementById('project-toggle-btn')?.addEventListener('click', async () => {
      const newStatus = isActive ? 'archived' : 'active';
      try {
        await API.updateProject(projectId, { status: newStatus });
        App.showToast('Project ' + newStatus, 'success');
        loadProjectsData();
        openProjectDetail(projectId);
      } catch (e) { App.showToast(e.message, 'error'); }
    });

    document.getElementById('project-delete-btn')?.addEventListener('click', () => {
      App.showModal('Delete Project', '<p>Delete project <strong>' + escapeHtml(p.name || projectId) + '</strong>?</p>', [
        { label: 'Cancel', class: 'btn btn-ghost', action: () => App.hideModal() },
        { label: 'Delete', class: 'btn btn-danger', action: async () => {
          try { await API.deleteProject(projectId); App.hideModal(); App.showToast('Project deleted', 'success'); panel.classList.remove('open'); loadProjectsData(); }
          catch (e) { App.showToast(e.message, 'error'); }
        }}
      ]);
    });
  } catch (err) {
    panel.innerHTML = '<div class="panel-header"><h2>Error</h2><button class="btn-icon panel-close" title="Close">&#x2715;</button></div><p class="text-danger">' + escapeHtml(err.message) + '</p>';
  }
}
