'use strict';

// ── Policy engine ──

const MAX_REGEX_PATTERN_LENGTH = 200;
const DANGEROUS_REGEX = /(\{[^}]*\{|\+\+|\*\*|\+\*|\*\+|\(\?[^)]*\(|\([^)]*\+[^)]*\)\+|\([^)]*\*[^)]*\)\*|\([^)]*\+[^)]*\)\*|\([^)]*\*[^)]*\)\+)/;

const MAX_REGEX_CACHE = 1000;

function compileRegex(pattern, cache) {
  if (cache.has(pattern)) return cache.get(pattern);
  if (typeof pattern !== 'string' || pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(`Regex pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} character limit or is not a string`);
  }
  if (DANGEROUS_REGEX.test(pattern)) {
    throw new Error('Regex pattern contains potentially dangerous constructs (nested quantifiers)');
  }
  const re = new RegExp(pattern);
  // Evict oldest entries if cache grows too large
  if (cache.size >= MAX_REGEX_CACHE) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(pattern, re);
  return re;
}

function createPolicyEngine() {
  const policies = new Map();
  const regexCache = new Map();

  function loadPolicy(policyData) {
    if (!policyData.id || !policyData.name) throw new Error('Policy must have id and name');
    const policy = {
      id: policyData.id,
      name: policyData.name,
      enabled: policyData.enabled !== false,
      priority: policyData.priority || 0,
      rules: (policyData.rules || []).map(r => ({
        field: r.field,
        operator: r.operator,
        value: r.value,
        score: r.score || 0,
        action: r.action || null,
        // ABAC conditions
        conditions: r.conditions || null
      })),
      enforcement: policyData.enforcement || {}
    };
    policies.set(policy.id, policy);
    return policy;
  }

  function evaluateABACConditions(conditions, context) {
    if (!conditions) return true;
    // Environment tags: { env: ["production", "staging"] }
    if (conditions.env) {
      const nodeEnv = getNestedField(context, 'env') || getNestedField(context, 'tags.env') || getNestedField(context, 'nodeEnv');
      if (nodeEnv && !conditions.env.includes(nodeEnv)) return false;
    }
    // Time window: { timeWindow: { after: "09:00", before: "17:00", timezone: "UTC" } }
    if (conditions.timeWindow) {
      const tw = conditions.timeWindow;
      const now = new Date();
      const hours = now.getUTCHours();
      const minutes = now.getUTCMinutes();
      const currentTime = hours * 60 + minutes;
      if (tw.after) {
        const [ah, am] = tw.after.split(':').map(Number);
        if (currentTime < ah * 60 + (am || 0)) return false;
      }
      if (tw.before) {
        const [bh, bm] = tw.before.split(':').map(Number);
        if (currentTime > bh * 60 + (bm || 0)) return false;
      }
      if (tw.days) {
        const dayOfWeek = now.getUTCDay();
        if (!tw.days.includes(dayOfWeek)) return false;
      }
    }
    // Risk score threshold: { minRiskScore: 30 }
    if (conditions.minRiskScore !== undefined) {
      const riskScore = getNestedField(context, 'riskScore') || getNestedField(context, 'driftScore') || 0;
      if (riskScore < conditions.minRiskScore) return false;
    }
    // Node tags: { nodeTags: { required: ["monitored"], forbidden: ["exempt"] } }
    if (conditions.nodeTags) {
      const tags = getNestedField(context, 'tags') || [];
      const tagSet = new Set(Array.isArray(tags) ? tags : []);
      if (conditions.nodeTags.required) {
        for (const t of conditions.nodeTags.required) {
          if (!tagSet.has(t)) return false;
        }
      }
      if (conditions.nodeTags.forbidden) {
        for (const t of conditions.nodeTags.forbidden) {
          if (tagSet.has(t)) return false;
        }
      }
    }
    // Role restriction: { roles: ["admin", "operator"] }
    if (conditions.roles) {
      const role = getNestedField(context, 'role') || getNestedField(context, 'user.role');
      if (role && !conditions.roles.includes(role)) return false;
    }
    return true;
  }

  function evaluateRule(rule, context) {
    const fieldValue = getNestedField(context, rule.field);
    if (fieldValue === undefined) return false;
    switch (rule.operator) {
      case 'eq': return fieldValue === rule.value;
      case 'neq': return fieldValue !== rule.value;
      case 'gt': return fieldValue > rule.value;
      case 'gte': return fieldValue >= rule.value;
      case 'lt': return fieldValue < rule.value;
      case 'lte': return fieldValue <= rule.value;
      case 'matches': {
        try {
          const re = compileRegex(rule.value, regexCache);
          return re.test(String(fieldValue));
        } catch (_) {
          return false;
        }
      }
      case 'contains': return String(fieldValue).includes(rule.value);
      default: return false;
    }
  }

  function getNestedField(obj, fieldPath) {
    const parts = fieldPath.split('.');
    let current = obj;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[part];
    }
    return current;
  }

  function evaluateDriftScore(events, policyId, context) {
    const policy = policies.get(policyId);
    if (!policy || !policy.enabled) return { score: 0, matched: [] };
    let score = 0;
    const matched = [];
    for (const event of events) {
      for (const rule of policy.rules) {
        // Check ABAC conditions before evaluating the rule
        const abacCtx = context ? { ...event, ...context } : event;
        if (!evaluateABACConditions(rule.conditions, abacCtx)) continue;
        if (evaluateRule(rule, event)) {
          score += rule.score;
          matched.push({ rule: rule.field + ' ' + rule.operator + ' ' + rule.value, event, score: rule.score });
        }
      }
    }
    return { score, matched };
  }

  function getEnforcementAction(score, policyId) {
    const policy = policies.get(policyId);
    if (!policy) return 'none';
    const ladder = policy.enforcement.ladder || [];
    // Sort descending by threshold
    const sorted = [...ladder].sort((a, b) => b.threshold - a.threshold);
    for (const step of sorted) {
      if (score >= step.threshold) return step.action;
    }
    return 'none';
  }

  function simulate(events, policyId) {
    const result = evaluateDriftScore(events, policyId);
    result.action = getEnforcementAction(result.score, policyId);
    return result;
  }

  function listPolicies() {
    return [...policies.values()].sort((a, b) => b.priority - a.priority);
  }

  function getPolicy(id) {
    return policies.get(id) || null;
  }

  return { loadPolicy, evaluateRule, evaluateABACConditions, evaluateDriftScore, getEnforcementAction, simulate, listPolicies, getPolicy };
}

module.exports = { createPolicyEngine };
