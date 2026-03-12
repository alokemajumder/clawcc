'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_SIZE = 1048576; // 1MB

const DEFAULT_PATTERNS = [
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/, severity: 'critical' },
  { name: 'AWS Secret Key', regex: /(?:aws|secret|key)[_\s:="']*([0-9a-zA-Z/+]{40})/, severity: 'critical' },
  { name: 'GitHub Token', regex: /gh[ps]_[A-Za-z0-9_]{36,}/, severity: 'high' },
  { name: 'GitHub Fine-Grained', regex: /github_pat_[A-Za-z0-9_]{22,}/, severity: 'high' },
  { name: 'Stripe Key', regex: /sk_live_[A-Za-z0-9]{24,}/, severity: 'high' },
  { name: 'JWT', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/, severity: 'medium' },
  { name: 'PEM Certificate', regex: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, severity: 'critical' },
  { name: 'Database URI', regex: /(mongodb|postgres|mysql|redis):\/\/[^\s'"]+/, severity: 'critical' },
  { name: 'Generic API Key', regex: /[a-zA-Z0-9_-]*(api[_-]?key|secret|token|password|credential)[a-zA-Z0-9_-]*\s*[:=]\s*['"][^'"]{8,}['"]/i, severity: 'low' },
  { name: 'Slack Token', regex: /xox[bpras]-[0-9]{10,}/, severity: 'medium' },
  { name: 'Anthropic Key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/, severity: 'high' },
  { name: 'OpenAI Key', regex: /sk-[A-Za-z0-9]{20,}/, severity: 'high' },
  { name: 'Bearer Token', regex: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/, severity: 'medium' },
  { name: 'Base64 Encoded Secret', regex: /(?:secret|key|token|password|credential)[_\s:="']*[A-Za-z0-9+/]{40,}={0,2}/i, severity: 'low' }
];

function createSecretScanner(opts = {}) {
  const patterns = DEFAULT_PATTERNS.map(p => ({ ...p, regex: new RegExp(p.regex.source, p.regex.flags), builtIn: true }));
  const customPatterns = [];
  let totalScans = 0;
  let secretsFound = 0;
  const byPattern = {};

  function getPatterns() {
    return [...patterns, ...customPatterns].map(p => ({
      name: p.name,
      regex: p.regex.source,
      flags: p.regex.flags,
      severity: p.severity,
      builtIn: !!p.builtIn
    }));
  }

  function addPattern(pattern) {
    if (!pattern || !pattern.name || !pattern.regex) {
      throw new Error('Pattern must have name and regex');
    }
    // Check for duplicate name
    const allPatterns = [...patterns, ...customPatterns];
    if (allPatterns.some(p => p.name === pattern.name)) {
      throw new Error('Pattern already exists: ' + pattern.name);
    }
    const entry = {
      name: pattern.name,
      regex: pattern.regex instanceof RegExp ? pattern.regex : new RegExp(pattern.regex, pattern.flags || ''),
      severity: pattern.severity || 'low',
      builtIn: false
    };
    customPatterns.push(entry);
    return { name: entry.name, regex: entry.regex.source, severity: entry.severity };
  }

  function removePattern(name) {
    const idx = customPatterns.findIndex(p => p.name === name);
    if (idx === -1) {
      // Check if it is built-in
      if (patterns.some(p => p.name === name)) {
        throw new Error('Cannot remove built-in pattern: ' + name);
      }
      throw new Error('Pattern not found: ' + name);
    }
    customPatterns.splice(idx, 1);
    return true;
  }

  function scan(text) {
    if (typeof text !== 'string') return [];
    totalScans++;
    const allPatterns = [...patterns, ...customPatterns];
    const findings = [];
    const lines = text.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      for (const pat of allPatterns) {
        // Create a fresh regex for each line to reset lastIndex
        const re = new RegExp(pat.regex.source, pat.regex.flags + (pat.regex.flags.includes('g') ? '' : 'g'));
        let m;
        let matchSafety = 0;
        const MAX_MATCHES_PER_LINE = 1000;
        while ((m = re.exec(line)) !== null) {
          if (++matchSafety > MAX_MATCHES_PER_LINE) break; // Safety: prevent infinite loops
          const matchStr = m[0];
          const masked = matchStr.substring(0, 8) + '***';
          findings.push({
            pattern: pat.name,
            match: masked,
            line: lineIdx + 1,
            column: m.index + 1,
            severity: pat.severity
          });
          secretsFound++;
          byPattern[pat.name] = (byPattern[pat.name] || 0) + 1;
          // Avoid infinite loop on zero-length match
          if (m[0].length === 0) { re.lastIndex++; if (re.lastIndex > line.length) break; }
        }
      }
    }

    return findings;
  }

  function scanObject(obj) {
    if (obj == null) return [];
    const findings = [];

    function recurse(val, keyPath) {
      if (typeof val === 'string') {
        const results = scan(val);
        for (const r of results) {
          findings.push({ ...r, path: keyPath });
        }
      } else if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          recurse(val[i], keyPath + '[' + i + ']');
        }
      } else if (typeof val === 'object' && val !== null) {
        for (const [k, v] of Object.entries(val)) {
          recurse(v, keyPath ? keyPath + '.' + k : k);
        }
      }
    }

    recurse(obj, '');
    return findings;
  }

  function scanFile(filePath) {
    const resolved = path.resolve(filePath);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error('File not found: ' + resolved);
    }
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error('File exceeds size limit (1MB): ' + resolved);
    }
    const content = fs.readFileSync(resolved, 'utf8');
    return scan(content);
  }

  function maskSecrets(text) {
    if (typeof text !== 'string') return text;
    const allPatterns = [...patterns, ...customPatterns];
    let result = text;

    for (const pat of allPatterns) {
      const re = new RegExp(pat.regex.source, pat.regex.flags + (pat.regex.flags.includes('g') ? '' : 'g'));
      result = result.replace(re, '***REDACTED***');
    }

    return result;
  }

  function getScanStats() {
    return {
      totalScans,
      secretsFound,
      byPattern: { ...byPattern }
    };
  }

  return {
    scan,
    scanObject,
    scanFile,
    getPatterns,
    addPattern,
    removePattern,
    maskSecrets,
    getScanStats
  };
}

module.exports = { createSecretScanner, DEFAULT_PATTERNS };
