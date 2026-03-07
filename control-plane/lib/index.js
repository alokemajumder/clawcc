'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Hybrid Index Layer
 *
 * In-memory indexes over the append-only JSONL event store.
 * JSONL remains the tamper-evident source of truth.
 * This layer provides O(1) lookups instead of O(n) full-file scans.
 *
 * Rebuilt from JSONL on boot, updated incrementally on every ingest.
 * Ephemeral - never persisted. Always rebuildable from JSONL.
 */
function createIndex() {
  // --- Primary event storage (all events in memory) ---
  const allEvents = [];

  // --- Secondary indexes (Maps for O(1) lookup) ---
  const bySessionId = new Map();   // sessionId -> [eventIndex, ...]
  const byNodeId = new Map();      // nodeId -> [eventIndex, ...]
  const byType = new Map();        // type -> [eventIndex, ...]
  const byDate = new Map();        // 'YYYY-MM-DD' -> [eventIndex, ...]

  // --- Aggregation caches ---
  const dailyCounts = new Map();   // 'YYYY-MM-DD' -> count
  const hourlyUsage = [];          // ring buffer of { ts, cost, inputTokens, outputTokens, provider, model }
  const HOURLY_USAGE_MAX = 100000; // cap ring buffer
  const ALL_EVENTS_MAX = 500000;   // cap in-memory events to prevent OOM

  // --- Entity caches ---
  let fleetCache = null;           // { nodes: {}, lastLoaded: timestamp }
  let policyCache = null;          // { policies: [], lastLoaded: timestamp }
  let snapshotCache = new Map();   // snapshotName -> { data, lastWritten }

  // --- Snapshot write debouncing ---
  const pendingSnapshots = new Set();
  let snapshotTimer = null;
  let snapshotDataDir = null;

  /**
   * Index a single event (called on ingest and during rebuild)
   */
  function indexEvent(event) {
    // Evict oldest events when at capacity to prevent OOM
    if (allEvents.length >= ALL_EVENTS_MAX) {
      const evictCount = Math.floor(ALL_EVENTS_MAX * 0.1);
      allEvents.splice(0, evictCount);
      // Rebuild secondary indexes after eviction (indexes store array positions)
      bySessionId.clear();
      byNodeId.clear();
      byType.clear();
      byDate.clear();
      for (let i = 0; i < allEvents.length; i++) {
        const e = allEvents[i];
        if (e.sessionId) { if (!bySessionId.has(e.sessionId)) bySessionId.set(e.sessionId, []); bySessionId.get(e.sessionId).push(i); }
        if (e.nodeId) { if (!byNodeId.has(e.nodeId)) byNodeId.set(e.nodeId, []); byNodeId.get(e.nodeId).push(i); }
        if (e.type) { if (!byType.has(e.type)) byType.set(e.type, []); byType.get(e.type).push(i); }
        const d = (e.ts || e.timestamp || '').slice(0, 10);
        if (d) { if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(i); }
      }
    }
    const idx = allEvents.length;
    allEvents.push(event);

    // Session index
    if (event.sessionId) {
      if (!bySessionId.has(event.sessionId)) bySessionId.set(event.sessionId, []);
      bySessionId.get(event.sessionId).push(idx);
    }

    // Node index
    if (event.nodeId) {
      if (!byNodeId.has(event.nodeId)) byNodeId.set(event.nodeId, []);
      byNodeId.get(event.nodeId).push(idx);
    }

    // Type index
    if (event.type) {
      if (!byType.has(event.type)) byType.set(event.type, []);
      byType.get(event.type).push(idx);
    }

    // Date index
    const dateStr = (event.ts || event.timestamp || '').slice(0, 10);
    if (dateStr) {
      if (!byDate.has(dateStr)) byDate.set(dateStr, []);
      byDate.get(dateStr).push(idx);
      dailyCounts.set(dateStr, (dailyCounts.get(dateStr) || 0) + 1);
    }

    // Usage aggregation (ring buffer for rolling windows)
    if (event.type === 'provider.usage' && event.payload) {
      const p = event.payload;
      hourlyUsage.push({
        ts: event.ts || event.timestamp,
        cost: p.cost || 0,
        inputTokens: p.inputTokens || 0,
        outputTokens: p.outputTokens || 0,
        provider: p.provider || 'unknown',
        model: p.model || 'unknown'
      });
      if (hourlyUsage.length > HOURLY_USAGE_MAX) hourlyUsage.shift();
    }
  }

  /**
   * Rebuild all indexes from JSONL files on disk
   */
  function rebuild(dataDir) {
    const eventsDir = path.join(dataDir, 'events');
    allEvents.length = 0;
    bySessionId.clear();
    byNodeId.clear();
    byType.clear();
    byDate.clear();
    dailyCounts.clear();
    hourlyUsage.length = 0;
    snapshotDataDir = dataDir;

    try {
      const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl')).sort();
      for (const file of files) {
        const content = fs.readFileSync(path.join(eventsDir, file), 'utf8').trim();
        if (!content) continue;
        for (const line of content.split('\n')) {
          try {
            indexEvent(JSON.parse(line));
          } catch { /* skip bad lines */ }
        }
      }
    } catch { /* no events dir */ }

    console.log(`  Index: ${allEvents.length} events, ${bySessionId.size} sessions, ${byNodeId.size} nodes, ${dailyCounts.size} days`);
  }

  /**
   * Query events using indexes (replaces full-file scan)
   * Returns newest-first like the original.
   */
  function query(filters) {
    filters = filters || {};
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    // Find the most selective index to start from
    let candidateIndices = null;

    if (filters.sessionId && bySessionId.has(filters.sessionId)) {
      candidateIndices = bySessionId.get(filters.sessionId);
    } else if (filters.nodeId && byNodeId.has(filters.nodeId)) {
      candidateIndices = byNodeId.get(filters.nodeId);
    } else if (filters.type && byType.has(filters.type)) {
      candidateIndices = byType.get(filters.type);
    }

    // If we have an index hit, filter those results
    if (candidateIndices) {
      const results = [];
      // Iterate in reverse for newest-first
      for (let i = candidateIndices.length - 1; i >= 0; i--) {
        const event = allEvents[candidateIndices[i]];
        if (!matchesFilters(event, filters)) continue;
        results.push(event);
        if (results.length >= offset + limit) break;
      }
      return results.slice(offset, offset + limit);
    }

    // Date range optimization: if from/to specified, only scan those dates
    if (filters.from || filters.to) {
      const results = [];
      const dates = [...byDate.keys()].sort().reverse();
      for (const date of dates) {
        if (filters.from && date < filters.from) continue;
        if (filters.to && date > filters.to) continue;
        const indices = byDate.get(date);
        for (let i = indices.length - 1; i >= 0; i--) {
          const event = allEvents[indices[i]];
          if (!matchesFilters(event, filters)) continue;
          results.push(event);
          if (results.length >= offset + limit) break;
        }
        if (results.length >= offset + limit) break;
      }
      return results.slice(offset, offset + limit);
    }

    // Fallback: scan all events in reverse
    const results = [];
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const event = allEvents[i];
      if (!matchesFilters(event, filters)) continue;
      results.push(event);
      if (results.length >= offset + limit) break;
    }
    return results.slice(offset, offset + limit);
  }

  function matchesFilters(event, filters) {
    if (filters.sessionId && event.sessionId !== filters.sessionId) return false;
    if (filters.nodeId && event.nodeId !== filters.nodeId) return false;
    if (filters.type && event.type !== filters.type) return false;
    if (filters.severity && event.severity !== filters.severity) return false;
    if (filters.from) {
      const date = (event.ts || event.timestamp || '').slice(0, 10);
      if (date < filters.from) return false;
    }
    if (filters.to) {
      const date = (event.ts || event.timestamp || '').slice(0, 10);
      if (date > filters.to) return false;
    }
    return true;
  }

  /**
   * Get 30-day heatmap from pre-computed daily counts (O(1))
   */
  function getHeatmap(days) {
    days = days || 30;
    const heatmap = {};
    const now = new Date();
    let max = 0;
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const count = dailyCounts.get(dateStr) || 0;
      heatmap[dateStr] = count;
      if (count > max) max = count;
    }
    return { heatmap, max };
  }

  /**
   * Rolling usage aggregation from the in-memory ring buffer (O(n) on buffer, not on disk)
   */
  function getRollingUsage(windowMs) {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const providers = {};
    let totalRequests = 0, totalTokens = 0, totalCost = 0;

    // Scan ring buffer from newest (binary search possible but linear is fine for <100k entries)
    for (let i = hourlyUsage.length - 1; i >= 0; i--) {
      const u = hourlyUsage[i];
      if (u.ts < cutoff) break; // sorted chronologically, can break early
      if (!providers[u.provider]) providers[u.provider] = { models: {}, totalCost: 0, totalRequests: 0 };
      const prov = providers[u.provider];
      if (!prov.models[u.model]) prov.models[u.model] = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
      const m = prov.models[u.model];
      m.requests++;
      m.inputTokens += u.inputTokens;
      m.outputTokens += u.outputTokens;
      m.cost += u.cost;
      prov.totalCost += u.cost;
      prov.totalRequests++;
      totalRequests++;
      totalTokens += u.inputTokens + u.outputTokens;
      totalCost += u.cost;
    }

    return { providers, totals: { requests: totalRequests, tokens: totalTokens, cost: totalCost } };
  }

  /**
   * Get usage alerts from in-memory aggregation (no disk scan)
   */
  function getUsageAlerts(alertConfig) {
    const costThreshold = alertConfig.costPerHour || 5.0;
    const tokenThreshold = alertConfig.tokensPerHour || 100000;
    const errorThreshold = alertConfig.errorRateThreshold || 0.10;

    const hourAgo = new Date(Date.now() - 3600000).toISOString();

    // Cost + tokens from usage ring buffer
    let costPerHour = 0, tokensPerHour = 0;
    for (let i = hourlyUsage.length - 1; i >= 0; i--) {
      if (hourlyUsage[i].ts < hourAgo) break;
      costPerHour += hourlyUsage[i].cost;
      tokensPerHour += hourlyUsage[i].inputTokens + hourlyUsage[i].outputTokens;
    }

    // Error rate from all events (scan from end)
    let totalHour = 0, errorsHour = 0;
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const ts = allEvents[i].ts || allEvents[i].timestamp || '';
      if (ts < hourAgo) break;
      totalHour++;
      if (allEvents[i].severity === 'error' || allEvents[i].severity === 'critical') errorsHour++;
    }
    const errorRate = totalHour > 0 ? errorsHour / totalHour : 0;

    const alerts = [];
    if (costPerHour > costThreshold) {
      alerts.push({ type: 'cost-spike', severity: 'warning', current: costPerHour, threshold: costThreshold,
        message: 'Cost per hour ($' + costPerHour.toFixed(2) + ') exceeds threshold ($' + costThreshold.toFixed(2) + ')' });
    }
    if (tokensPerHour > tokenThreshold) {
      alerts.push({ type: 'token-spike', severity: 'warning', current: tokensPerHour, threshold: tokenThreshold,
        message: 'Tokens per hour (' + tokensPerHour.toLocaleString() + ') exceeds threshold (' + tokenThreshold.toLocaleString() + ')' });
    }
    if (errorRate > errorThreshold) {
      alerts.push({ type: 'error-rate', severity: 'error', current: Math.round(errorRate * 100), threshold: Math.round(errorThreshold * 100),
        message: 'Error rate (' + Math.round(errorRate * 100) + '%) exceeds threshold (' + Math.round(errorThreshold * 100) + '%)' });
    }
    if (!alerts.find(a => a.type === 'cost-spike') && costPerHour > costThreshold * 0.8) {
      alerts.push({ type: 'cost-approaching', severity: 'info', current: costPerHour, threshold: costThreshold,
        message: 'Cost per hour ($' + costPerHour.toFixed(2) + ') approaching threshold ($' + costThreshold.toFixed(2) + ')' });
    }
    if (!alerts.find(a => a.type === 'token-spike') && tokensPerHour > tokenThreshold * 0.8) {
      alerts.push({ type: 'token-approaching', severity: 'info', current: tokensPerHour, threshold: tokenThreshold,
        message: 'Tokens per hour approaching threshold' });
    }

    return {
      alerts,
      thresholds: { costPerHour: costThreshold, tokensPerHour: tokenThreshold, errorRateThreshold: errorThreshold },
      current: { costPerHour, tokensPerHour, errorRate: Math.round(errorRate * 100) }
    };
  }

  // --- Fleet node cache ---
  function getFleetNodes(dataDir) {
    if (fleetCache && Date.now() - fleetCache.lastLoaded < 2000) return fleetCache.nodes;
    const filePath = path.join(dataDir, 'fleet', 'nodes.json');
    try {
      const nodes = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      fleetCache = { nodes, lastLoaded: Date.now() };
      return nodes;
    } catch {
      fleetCache = { nodes: {}, lastLoaded: Date.now() };
      return {};
    }
  }

  function saveFleetNodes(dataDir, nodes) {
    const dir = path.join(dataDir, 'fleet');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'nodes.json'), JSON.stringify(nodes, null, 2));
    fleetCache = { nodes, lastLoaded: Date.now() };
  }

  // --- Policy cache ---
  function getPolicies(policiesDir) {
    if (policyCache && Date.now() - policyCache.lastLoaded < 5000) return policyCache.policies;
    const policies = [];
    try {
      const files = fs.readdirSync(policiesDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try { policies.push(JSON.parse(fs.readFileSync(path.join(policiesDir, f), 'utf8'))); } catch {}
      }
    } catch {}
    policyCache = { policies, lastLoaded: Date.now() };
    return policies;
  }

  function invalidatePolicyCache() { policyCache = null; }

  // --- Snapshot cache with debounced writes ---
  function loadSnapshot(dataDir, name) {
    const cached = snapshotCache.get(name);
    if (cached) return cached.data;
    const filePath = path.join(dataDir, 'snapshots', name + '.json');
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      snapshotCache.set(name, { data, lastWritten: Date.now() });
      return data;
    } catch { return null; }
  }

  function updateSnapshotCache(name, data) {
    snapshotCache.set(name, { data, lastWritten: Date.now() });
    pendingSnapshots.add(name);
    scheduleSnapshotFlush();
  }

  function scheduleSnapshotFlush() {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      flushSnapshots();
      snapshotTimer = null;
    }, 1000); // debounce 1s
  }

  function flushSnapshots() {
    if (!snapshotDataDir) return;
    const snapshotsDir = path.join(snapshotDataDir, 'snapshots');
    fs.mkdirSync(snapshotsDir, { recursive: true });
    for (const name of pendingSnapshots) {
      const cached = snapshotCache.get(name);
      if (cached) {
        try {
          fs.writeFileSync(path.join(snapshotsDir, name + '.json'), JSON.stringify(cached.data, null, 2));
        } catch { /* ignore */ }
      }
    }
    pendingSnapshots.clear();
  }

  // --- Stats ---
  function stats() {
    return {
      totalEvents: allEvents.length,
      sessions: bySessionId.size,
      nodes: byNodeId.size,
      eventTypes: byType.size,
      days: dailyCounts.size,
      usageBufferSize: hourlyUsage.length
    };
  }

  return {
    indexEvent,
    rebuild,
    query,
    getHeatmap,
    getRollingUsage,
    getUsageAlerts,
    getFleetNodes,
    saveFleetNodes,
    getPolicies,
    invalidatePolicyCache,
    loadSnapshot,
    updateSnapshotCache,
    flushSnapshots,
    stats
  };
}

module.exports = { createIndex };
