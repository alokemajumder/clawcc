'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseBody } = require('../middleware/security');
const { authenticate, requireStepUp } = require('../middleware/auth-middleware');
const { buildZip } = require('../lib/zip');

function registerGovernanceRoutes(router, config, modules) {
  const { auth, audit, events, index, snapshots, receipts, policy, intent, crypto: cryptoMod } = modules;

  // In-memory approval store for 4-eyes workflow (capped, expired entries evicted)
  const approvalRequests = new Map();
  const APPROVAL_MAX = 1000;

  const policiesDir = path.join(config.dataDir, '..', 'policies');

  function loadPoliciesCached() {
    return index ? index.getPolicies(policiesDir) : policy.loadPolicies(policiesDir);
  }

  router.get('/api/governance/policies', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    res.json(200, { success: true, policies: loadPoliciesCached() });
  });

  router.get('/api/governance/policies/:id', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const policies = loadPoliciesCached();
    const found = policies.find(p => p.id === req.params.id);
    if (!found) return res.error(404, 'Policy not found');
    res.json(200, { success: true, policy: found });
  });

  router.put('/api/governance/policies/:id', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (authResult.user.role !== 'ADMIN') return res.error(403, 'Admin required');
    const stepUp = requireStepUp(req, auth, config);
    if (!stepUp.authorized) return res.error(403, stepUp.reason);
    const body = await parseBody(req);
    fs.writeFileSync(path.join(policiesDir, req.params.id + '.policy.json'), JSON.stringify(body, null, 2));
    if (index) index.invalidatePolicyCache();
    audit.log({ actor: authResult.user.username, action: 'policy.updated', target: req.params.id, detail: JSON.stringify(body) });
    res.json(200, { success: true });
  });

  router.post('/api/governance/policies/simulate', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const body = await parseBody(req);
    const policies = loadPoliciesCached();
    const targetPolicy = policies.find(p => p.id === body.policyId);
    if (!targetPolicy) return res.error(404, 'Policy not found');
    const sessionEvents = events.query(config.dataDir, { sessionId: body.sessionId, limit: 1000 });
    const result = policy.simulatePolicy(targetPolicy, sessionEvents);
    res.json(200, { success: true, simulation: result });
  });

  // 4-Eyes Approval Workflow
  // High-risk actions require two different admins/operators to approve

  router.post('/api/governance/approvals', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const body = await parseBody(req);
    const approvalId = crypto.randomUUID();
    const request = {
      id: approvalId,
      action: body.action,
      target: body.target,
      detail: body.detail || '',
      requestedBy: authResult.user.username,
      requestedAt: new Date().toISOString(),
      requiredApprovals: body.requiredApprovals || 2,
      approvals: [],
      denials: [],
      status: 'pending',
      expiresAt: Date.now() + (body.expiresInMs || 3600000)
    };
    // Evict expired approvals if at capacity
    if (approvalRequests.size >= APPROVAL_MAX) {
      const now = Date.now();
      for (const [id, r] of approvalRequests) {
        if (r.status !== 'pending' || now >= r.expiresAt) approvalRequests.delete(id);
      }
    }
    approvalRequests.set(approvalId, request);
    events.ingest({ ts: request.requestedAt, nodeId: null, sessionId: null, type: 'approval.requested', severity: 'info',
      payload: { approvalId, action: body.action, target: body.target, requestedBy: authResult.user.username } });
    audit.log({ actor: authResult.user.username, action: 'approval.requested', target: approvalId, detail: JSON.stringify({ action: body.action, target: body.target }) });
    res.json(200, { success: true, approval: request });
  });

  router.get('/api/governance/approvals', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const now = Date.now();
    const pending = [];
    for (const [id, req_] of approvalRequests) {
      if (req_.status === 'pending' && now < req_.expiresAt) pending.push(req_);
      else if (req_.status === 'pending' && now >= req_.expiresAt) req_.status = 'expired';
    }
    // Also include from event store for historical approvals
    const all = req.query.all === 'true' ? [...approvalRequests.values()] : pending;
    res.json(200, { success: true, approvals: all });
  });

  router.post('/api/governance/approvals/:id/grant', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (!auth.checkPermission(authResult.user, 'action:safe')) return res.error(403, 'Insufficient permissions');
    const approval = approvalRequests.get(req.params.id);
    if (!approval) return res.error(404, 'Approval not found');
    if (approval.status !== 'pending') return res.error(400, 'Approval already ' + approval.status);
    if (Date.now() >= approval.expiresAt) { approval.status = 'expired'; return res.error(400, 'Approval expired'); }
    // 4-eyes: cannot approve your own request
    if (approval.requestedBy === authResult.user.username) return res.error(403, 'Cannot approve your own request (4-eyes policy)');
    // Cannot approve twice
    if (approval.approvals.some(a => a.username === authResult.user.username)) return res.error(400, 'Already approved by this user');
    approval.approvals.push({ username: authResult.user.username, at: new Date().toISOString() });
    if (approval.approvals.length >= approval.requiredApprovals) approval.status = 'approved';
    events.ingest({ ts: new Date().toISOString(), nodeId: null, sessionId: null, type: 'approval.granted', severity: 'info',
      payload: { approvalId: req.params.id, grantedBy: authResult.user.username, approvalsCount: approval.approvals.length, required: approval.requiredApprovals } });
    audit.log({ actor: authResult.user.username, action: 'approval.granted', target: req.params.id });
    res.json(200, { success: true, approval });
  });

  router.post('/api/governance/approvals/:id/deny', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const approval = approvalRequests.get(req.params.id);
    if (!approval) return res.error(404, 'Approval not found');
    if (approval.status !== 'pending') return res.error(400, 'Approval already ' + approval.status);
    approval.status = 'denied';
    approval.denials.push({ username: authResult.user.username, at: new Date().toISOString() });
    events.ingest({ ts: new Date().toISOString(), nodeId: null, sessionId: null, type: 'approval.denied', severity: 'info',
      payload: { approvalId: req.params.id, deniedBy: authResult.user.username } });
    audit.log({ actor: authResult.user.username, action: 'approval.denied', target: req.params.id });
    res.json(200, { success: true, approval });
  });

  router.get('/api/governance/approvals/:id', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const approval = approvalRequests.get(req.params.id);
    if (!approval) return res.error(404, 'Approval not found');
    res.json(200, { success: true, approval });
  });

  router.get('/api/governance/tripwires', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    try {
      const twPath = path.join(config.dataDir, '..', 'tripwires', 'default.tripwires.json');
      const data = JSON.parse(fs.readFileSync(twPath, 'utf8'));
      res.json(200, { success: true, tripwires: data.tripwires || [] });
    } catch { res.json(200, { success: true, tripwires: [] }); }
  });

  router.put('/api/governance/tripwires', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (authResult.user.role !== 'ADMIN') return res.error(403, 'Admin required');
    const stepUp = requireStepUp(req, auth, config);
    if (!stepUp.authorized) return res.error(403, stepUp.reason);
    const body = await parseBody(req);
    const twPath = path.join(config.dataDir, '..', 'tripwires', 'default.tripwires.json');
    fs.writeFileSync(twPath, JSON.stringify(body, null, 2));
    audit.log({ actor: authResult.user.username, action: 'tripwires.updated', target: 'default' });
    res.json(200, { success: true });
  });

  router.get('/api/governance/tripwires/triggers', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const triggers = events.query(config.dataDir, { type: 'tripwire.triggered', limit: 50 });
    res.json(200, { success: true, triggers });
  });

  router.get('/api/governance/audit', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (!auth.checkPermission(authResult.user, 'audit:read')) return res.error(403, 'Insufficient permissions');
    const entries = audit.query(config.dataDir, {
      actor: req.query.actor, action: req.query.action, from: req.query.from, to: req.query.to,
      limit: parseInt(req.query.limit || '100', 10)
    });
    res.json(200, { success: true, entries });
  });

  router.post('/api/governance/evidence/export', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (!auth.checkPermission(authResult.user, 'export:evidence')) return res.error(403, 'Insufficient permissions');
    const body = await parseBody(req);

    // Check if client wants ZIP format (default) or JSON
    const format = body.format || 'zip';

    // Gather evidence data
    const sessionId = body.sessionId || null;
    const from = body.from || null;
    const to = body.to || null;
    const queryFilters = { limit: 10000 };
    if (sessionId) queryFilters.sessionId = sessionId;
    if (from) queryFilters.from = from;
    if (to) queryFilters.to = to;

    const evidenceEvents = events.query(config.dataDir, queryFilters);
    const receiptBundle = receipts.exportBundle(config.dataDir, sessionId, body);
    const auditEntries = audit.query(config.dataDir, { from, to, limit: 10000 });
    const exportTs = new Date().toISOString();

    const manifest = {
      exportedAt: exportTs,
      exportedBy: authResult.user.username,
      sessionId: sessionId,
      dateRange: { from, to },
      files: ['events.jsonl', 'receipts.json', 'audit.jsonl', 'manifest.json'],
      counts: { events: evidenceEvents.length, receipts: receiptBundle ? 1 : 0, auditEntries: auditEntries.length },
      integrity: {
        eventsHash: crypto.createHash('sha256').update(evidenceEvents.map(e => JSON.stringify(e)).join('\n')).digest('hex'),
        auditHash: crypto.createHash('sha256').update(auditEntries.map(e => JSON.stringify(e)).join('\n')).digest('hex')
      }
    };

    audit.log({ actor: authResult.user.username, action: 'evidence.exported', target: sessionId || 'bulk',
      detail: JSON.stringify({ format, events: evidenceEvents.length, auditEntries: auditEntries.length }) });

    if (format === 'json') {
      // Legacy JSON response
      res.json(200, { success: true, bundle: receiptBundle, manifest });
      return;
    }

    // Build ZIP file
    const zipFiles = [
      { name: 'events.jsonl', data: evidenceEvents.map(e => JSON.stringify(e)).join('\n') },
      { name: 'receipts.json', data: JSON.stringify(receiptBundle, null, 2) },
      { name: 'audit.jsonl', data: auditEntries.map(e => JSON.stringify(e)).join('\n') },
      { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) }
    ];

    const zipBuffer = buildZip(zipFiles);
    const dateLabel = from || exportTs.slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="evidence-bundle-' + dateLabel + '.zip"',
      'Content-Length': zipBuffer.length
    });
    res.end(zipBuffer);
  });

  router.post('/api/governance/evidence/verify', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const body = await parseBody(req);
    const result = receipts.verifyBundle(body);
    res.json(200, { success: true, verification: result });
  });

  router.get('/api/governance/skills', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    try {
      const regPath = config.skills ? config.skills.registryPath || './skills/registry.json' : './skills/registry.json';
      const data = JSON.parse(fs.readFileSync(path.resolve(regPath), 'utf8'));
      res.json(200, { success: true, skills: data.skills || [] });
    } catch { res.json(200, { success: true, skills: [] }); }
  });

  router.post('/api/governance/skills/:id/deploy', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (authResult.user.role !== 'ADMIN') return res.error(403, 'Admin required');
    const stepUp = requireStepUp(req, auth, config);
    if (!stepUp.authorized) return res.error(403, stepUp.reason);
    const body = await parseBody(req);

    // Verify Ed25519 signature before deploy
    if (body.signature && body.publicKey && body.bundle) {
      const sigValid = cryptoMod.verify(body.bundle, body.signature, body.publicKey);
      if (!sigValid) {
        audit.log({ actor: authResult.user.username, action: 'skill.deploy.rejected', target: req.params.id, detail: 'Invalid signature' });
        return res.error(403, 'Skill bundle signature verification failed');
      }
    } else if (config.skills && config.skills.requireSignature !== false) {
      // Default: require signature unless explicitly disabled
      try {
        const regPath = config.skills ? config.skills.registryPath || './skills/registry.json' : './skills/registry.json';
        const registry = JSON.parse(fs.readFileSync(path.resolve(regPath), 'utf8'));
        const skill = (registry.skills || []).find(s => s.id === req.params.id);
        if (skill && skill.signed && !body.signature) {
          return res.error(403, 'Signed skill requires Ed25519 signature for deployment');
        }
      } catch { /* registry not found, allow */ }
    }

    // Canary rollout logic
    const targetNodes = body.targetNodes || body.canaryNodes || [];
    const canary = body.canary || false;
    const ts = new Date().toISOString();

    if (canary && targetNodes.length > 0) {
      // Deploy to canary subset only
      for (const nodeId of targetNodes) {
        events.ingest({ ts, nodeId, sessionId: null, type: 'skill.deployed', severity: 'info',
          payload: { skillId: req.params.id, deployedBy: authResult.user.username, canary: true, phase: 'canary' } });
      }
      audit.log({ actor: authResult.user.username, action: 'skill.canary-deployed', target: req.params.id,
        detail: JSON.stringify({ nodes: targetNodes }) });
      res.json(200, { success: true, message: 'Canary deployment initiated', canaryNodes: targetNodes, phase: 'canary' });
    } else {
      // Full fleet deploy
      events.ingest({ ts, nodeId: null, sessionId: null, type: 'skill.deployed', severity: 'info',
        payload: { skillId: req.params.id, deployedBy: authResult.user.username, canary: false, phase: 'full' } });
      audit.log({ actor: authResult.user.username, action: 'skill.deployed', target: req.params.id });
      res.json(200, { success: true, message: 'Skill deployment initiated', phase: 'full' });
    }
  });

  router.post('/api/governance/skills/:id/rollback', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (authResult.user.role !== 'ADMIN') return res.error(403, 'Admin required');
    audit.log({ actor: authResult.user.username, action: 'skill.rolledback', target: req.params.id });
    events.ingest({ ts: new Date().toISOString(), nodeId: null, sessionId: null, type: 'skill.rolledback', severity: 'warning', payload: { skillId: req.params.id } });
    res.json(200, { success: true });
  });

  router.get('/api/governance/access-review', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if (!auth.checkPermission(authResult.user, 'audit:read')) return res.error(403, 'Insufficient permissions');
    const users = auth.loadUsers(config.dataDir);
    const review = Object.values(users).map(u => ({ username: u.username, role: u.role, mfaEnabled: !!u.mfaEnabled, createdAt: u.createdAt, lastLogin: u.lastLogin || null }));
    res.json(200, { success: true, users: review });
  });

  router.get('/api/governance/receipts/verify', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const publicKey = config.adminKeyPublic || null;
    const result = receipts.verify(config.dataDir, date, publicKey);
    res.json(200, { success: true, verification: result });
  });
}

module.exports = { registerGovernanceRoutes };
