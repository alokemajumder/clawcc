'use strict';
const { parseBody } = require('../middleware/security');
const { authenticate, verifyNodeSignature } = require('../middleware/auth-middleware');

function registerEventRoutes(router, config, modules) {
  const { auth, events, index, snapshots, receipts, crypto: cryptoMod } = modules;

  router.post('/api/events/ingest', async (req, res) => {
    // Authenticate: try HMAC node signature first, fall back to session cookie
    const sigResult = verifyNodeSignature(req, config, cryptoMod);
    if (!sigResult.valid) {
      const authResult = authenticate(req, auth);
      if (!authResult.authenticated) {
        return res.error(401, 'Not authenticated');
      }
    }
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    // Input validation
    if (!body || typeof body !== 'object') return res.error(400, 'Request body must be a JSON object');
    if (body.type && typeof body.type !== 'string') return res.error(400, 'type must be a string');
    if (body.severity && typeof body.severity !== 'string') return res.error(400, 'severity must be a string');
    if (body.nodeId && typeof body.nodeId !== 'string') return res.error(400, 'nodeId must be a string');
    try {
      events.ingest(body);
      snapshots.update(config.dataDir, body);
      res.json(200, { success: true });
    } catch (err) {
      res.error(400, err.message);
    }
  });

  router.get('/api/events/stream', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) {
      return res.error(401, 'Not authenticated');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(':ok\n\n');

    const filter = {};
    if (req.query.nodeId) filter.nodeId = req.query.nodeId;
    if (req.query.sessionId) filter.sessionId = req.query.sessionId;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.severity) filter.severity = req.query.severity;

    const unsubscribe = events.subscribe(filter, (event) => {
      try { res.write('data: ' + JSON.stringify(event) + '\n\n'); } catch {}
    });

    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch { cleanup(); }
    }, 30000);

    // Max SSE connection lifetime: 1 hour (reconnect expected)
    const maxLifetime = setTimeout(() => { cleanup(); }, 3600000);

    function cleanup() {
      unsubscribe();
      clearInterval(keepalive);
      clearTimeout(maxLifetime);
      try { res.end(); } catch {}
    }

    req.on('close', cleanup);
    req.on('error', cleanup);
  });

  router.get('/api/events/query', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const result = events.query(config.dataDir, {
      from: req.query.from, to: req.query.to,
      nodeId: req.query.nodeId, sessionId: req.query.sessionId,
      type: req.query.type, severity: req.query.severity,
      limit: parseInt(req.query.limit || '100', 10),
      offset: parseInt(req.query.offset || '0', 10)
    });
    res.json(200, { success: true, events: result });
  });

  router.get('/api/sessions', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const sessData = snapshots.load(config.dataDir, 'sessions');
    res.json(200, { success: true, sessions: sessData ? sessData.sessions || {} : {} });
  });

  router.get('/api/sessions/:sessionId', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const sessEvents = events.query(config.dataDir, { sessionId: req.params.sessionId, limit: 1000 });
    res.json(200, { success: true, events: sessEvents });
  });

  router.get('/api/sessions/:sessionId/timeline', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const sessEvents = events.query(config.dataDir, { sessionId: req.params.sessionId, limit: 1000 });
    const timeline = sessEvents.map((e, i) => ({ step: i + 1, ts: e.ts, type: e.type, severity: e.severity, summary: e.payload && (e.payload.tool || e.payload.preview || e.type) }));
    res.json(200, { success: true, timeline });
  });

  router.get('/api/sessions/:sessionId/receipt', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const receipt = receipts.getSessionReceipt ? receipts.getSessionReceipt(req.params.sessionId) : null;
    res.json(200, { success: true, receipt });
  });

  router.post('/api/sessions/:sessionId/compare', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    let body;
    try { body = await parseBody(req); } catch (err) { return res.error(400, err.message); }
    const eventsA = events.query(config.dataDir, { sessionId: req.params.sessionId, limit: 1000 });
    const eventsB = events.query(config.dataDir, { sessionId: body.otherSessionId, limit: 1000 });
    const sessData = snapshots.load(config.dataDir, 'sessions');
    const sessions = sessData ? sessData.sessions || {} : {};
    res.json(200, {
      success: true,
      comparison: {
        a: { sessionId: req.params.sessionId, events: eventsA.length, summary: sessions[req.params.sessionId] || {} },
        b: { sessionId: body.otherSessionId, events: eventsB.length, summary: sessions[body.otherSessionId] || {} }
      }
    });
  });

  // Activity heatmap: 30-day event counts per day (from in-memory index)
  router.get('/api/events/heatmap', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');

    const result = index ? index.getHeatmap(30) : { heatmap: {}, max: 0 };
    res.json(200, { success: true, heatmap: result.heatmap, max: result.max });
  });

  // Session blast radius: what files/tools a session has touched
  router.get('/api/sessions/:sessionId/blast-radius', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const sessionId = req.params.sessionId;
    const sessEvents = events.query(config.dataDir, { sessionId, limit: 1000 });
    const toolsUsed = new Set();
    const filesAccessed = new Set();
    let cost = 0;
    let tokens = 0;
    for (const e of sessEvents) {
      if (e.payload) {
        if (e.payload.tool) toolsUsed.add(e.payload.tool);
        if (e.payload.path) filesAccessed.add(e.payload.path);
        if (e.payload.cost) cost += e.payload.cost;
        if (e.payload.tokens) tokens += e.payload.tokens;
      }
    }
    res.json(200, { success: true, blastRadius: { sessionId, eventsCount: sessEvents.length, toolsUsed: [...toolsUsed], filesAccessed: [...filesAccessed], cost, tokens } });
  });

  // Causality explorer: find sessions that reference a file or tool
  router.get('/api/events/causality', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const target = req.query.target;
    if (!target) return res.error(400, 'target query param required');
    const allEvents = events.query(config.dataDir, { limit: 5000 });
    const sessionMap = {};
    for (const e of allEvents) {
      let matches = false;
      if (e.payload) {
        if ((e.type === 'tool.call' || e.type === 'tool.error') && e.payload.tool === target) matches = true;
        if ((e.type === 'file.read' || e.type === 'file.write') && e.payload.path === target) matches = true;
      }
      if (!matches) continue;
      const sid = e.sessionId || 'unknown';
      if (!sessionMap[sid]) {
        sessionMap[sid] = { sessionId: sid, nodeId: e.nodeId, events: 0, firstSeen: e.ts || e.timestamp, lastSeen: e.ts || e.timestamp };
      }
      sessionMap[sid].events++;
      const ts = e.ts || e.timestamp;
      if (ts < sessionMap[sid].firstSeen) sessionMap[sid].firstSeen = ts;
      if (ts > sessionMap[sid].lastSeen) sessionMap[sid].lastSeen = ts;
    }
    res.json(200, { success: true, causality: { target, sessions: Object.values(sessionMap) } });
  });

  // Streak tracking: consecutive days with events
  router.get('/api/events/streak', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const result = index ? index.getHeatmap(365) : { heatmap: {}, max: 0 };
    const heatmap = result.heatmap;
    const days = Object.keys(heatmap).filter(d => heatmap[d] > 0).sort();
    const totalActiveDays = days.length;
    let current = 0;
    let longest = 0;
    let streak = 0;
    const today = new Date().toISOString().slice(0, 10);
    // Walk backwards from today to compute current streak
    for (let i = 0; i < 365; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      if (heatmap[d] && heatmap[d] > 0) {
        current++;
      } else {
        break;
      }
    }
    // Compute longest streak from sorted days
    if (days.length > 0) {
      streak = 1;
      longest = 1;
      for (let i = 1; i < days.length; i++) {
        const prev = new Date(days[i - 1]).getTime();
        const curr = new Date(days[i]).getTime();
        if (curr - prev === 86400000) {
          streak++;
          if (streak > longest) longest = streak;
        } else {
          streak = 1;
        }
      }
    }
    res.json(200, { success: true, streak: { current, longest, totalActiveDays } });
  });

  // Digital Twin Replay: session events with relative timestamps for playback
  router.get('/api/sessions/:sessionId/replay', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');

    const sessEvents = events.query(config.dataDir, { sessionId: req.params.sessionId, limit: 1000 });
    if (!sessEvents.length) return res.json(200, { success: true, replay: [], totalSteps: 0, durationMs: 0 });

    // Query returns newest-first, reverse for chronological order
    const sorted = sessEvents.reverse();
    const baseTs = new Date(sorted[0].ts || sorted[0].timestamp).getTime();

    const replay = sorted.map((e, i) => ({
      step: i + 1,
      ts: e.ts || e.timestamp,
      relativeMs: new Date(e.ts || e.timestamp).getTime() - baseTs,
      type: e.type,
      severity: e.severity,
      nodeId: e.nodeId,
      payload: e.payload,
      summary: (e.payload && (e.payload.tool || e.payload.preview)) || e.type
    }));

    res.json(200, {
      success: true,
      replay,
      totalSteps: replay.length,
      durationMs: replay.length > 1 ? replay[replay.length - 1].relativeMs : 0
    });
  });
}

module.exports = { registerEventRoutes };
