'use strict';

const fs = require('fs');
const path = require('path');

function createContract(sessionId, options) {
  return {
    sessionId,
    goal: options.goal || '',
    constraints: options.constraints || [],
    allowedTools: options.allowedTools || [],
    allowedPaths: options.allowedPaths || [],
    allowedEndpoints: options.allowedEndpoints || [],
    maxBudget: options.maxBudget || Infinity,
    maxDuration: options.maxDuration || Infinity,
    createdAt: new Date().toISOString()
  };
}

function validateSessionId(sessionId) {
  if (!sessionId || /[^a-zA-Z0-9_-]/.test(sessionId)) {
    throw new Error('Invalid session ID');
  }
}

function attachContract(dataDir, sessionId, contract) {
  validateSessionId(sessionId);
  const dir = path.join(dataDir, 'intents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sessionId + '.json'), JSON.stringify(contract, null, 2));
}

function loadContract(dataDir, sessionId) {
  validateSessionId(sessionId);
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'intents', sessionId + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

function computeDrift(contract, events) {
  const factors = {
    toolDivergence: 0,
    scopeCreep: 0,
    loopiness: 0,
    costSpike: 0,
    forbiddenAccess: 0
  };
  const reasons = [];

  if (!contract || !events || events.length === 0) {
    return { score: 0, factors, reasons };
  }

  // Tool divergence
  const usedTools = new Set();
  const allowedSet = new Set(contract.allowedTools || []);
  for (const e of events) {
    if (e.type === 'tool.call' && e.payload && e.payload.tool) {
      usedTools.add(e.payload.tool);
    }
  }
  if (allowedSet.size > 0 && usedTools.size > 0) {
    let divergent = 0;
    for (const tool of usedTools) {
      if (!allowedSet.has(tool)) divergent++;
    }
    factors.toolDivergence = Math.min(20, Math.round(divergent / usedTools.size * 20));
    if (divergent > 0) reasons.push(`${divergent} tool(s) used outside allowed set`);
  }

  // Scope creep
  const allowedPaths = contract.allowedPaths || [];
  if (allowedPaths.length > 0) {
    let totalAccesses = 0;
    let outOfScope = 0;
    for (const e of events) {
      if ((e.type === 'file.read' || e.type === 'file.write') && e.payload && e.payload.path) {
        totalAccesses++;
        const inScope = allowedPaths.some(p => e.payload.path.startsWith(p));
        if (!inScope) outOfScope++;
      }
    }
    if (totalAccesses > 0) {
      factors.scopeCreep = Math.min(20, Math.round(outOfScope / totalAccesses * 20));
      if (outOfScope > 0) reasons.push(`${outOfScope} file access(es) outside declared scope`);
    }
  }

  // Loopiness
  const recentCalls = [];
  for (const e of events) {
    if (e.type === 'tool.call' && e.payload) {
      recentCalls.push(e.payload.tool + ':' + JSON.stringify(e.payload.args || {}).slice(0, 50));
    }
  }
  if (recentCalls.length > 5) {
    const windowSize = 10;
    let repeats = 0;
    for (let i = 1; i < recentCalls.length && i < windowSize; i++) {
      if (recentCalls[i] === recentCalls[i - 1]) repeats++;
    }
    factors.loopiness = Math.min(20, Math.round(repeats / Math.min(recentCalls.length, windowSize) * 20));
    if (repeats > 2) reasons.push(`Detected ${repeats} repeated consecutive tool calls`);
  }

  // Cost spike
  let totalCost = 0;
  for (const e of events) {
    if (e.type === 'provider.usage' && e.payload && e.payload.cost) {
      totalCost += e.payload.cost;
    }
  }
  if (contract.maxBudget && contract.maxBudget < Infinity) {
    const ratio = totalCost / contract.maxBudget;
    if (ratio > 0.5) {
      factors.costSpike = Math.min(20, Math.round((ratio - 0.5) * 40));
      if (ratio > 0.75) reasons.push(`Cost at ${Math.round(ratio * 100)}% of budget ($${totalCost.toFixed(2)}/$${contract.maxBudget})`);
    }
  }

  // Forbidden access
  for (const e of events) {
    if (e.type === 'tripwire.triggered' || e.type === 'policy.violation') {
      factors.forbiddenAccess = 20;
      reasons.push('Forbidden resource access or policy violation detected');
      break;
    }
  }

  const score = factors.toolDivergence + factors.scopeCreep + factors.loopiness + factors.costSpike + factors.forbiddenAccess;
  return { score: Math.min(100, score), factors, reasons };
}

function getEnforcementAction(driftScore, thresholds) {
  const t = thresholds || { warn: 20, approve: 40, throttle: 60, quarantine: 80, kill: 95 };

  if (driftScore >= t.kill) return 'kill';
  if (driftScore >= t.quarantine) return 'quarantine';
  if (driftScore >= t.throttle) return 'throttle';
  if (driftScore >= t.approve) return 'approve';
  if (driftScore >= t.warn) return 'warn';
  return 'none';
}

module.exports = { createContract, attachContract, loadContract, computeDrift, getEnforcementAction };
