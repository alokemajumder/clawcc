'use strict';

/* ===================================================================
   ClawCC Page Renderers
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
    const list = nodes.nodes || nodes || [];
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
