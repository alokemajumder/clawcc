# ClawCC Compliance Pack

## 1. Overview

This document maps ClawCC's security and governance controls to common compliance frameworks. ClawCC produces machine-verifiable evidence artifacts suitable for SOC 2 Type II, ISO 27001, and NIST Cybersecurity Framework (CSF) audits.

All evidence is stored in append-only, hash-chained formats with Ed25519 digital signatures for tamper detection.

---

## 2. Control Mapping Matrix

### SOC 2 Trust Service Criteria

| TSC | Control | ClawCC Implementation | Evidence |
|-----|---------|----------------------|----------|
| CC6.1 | Logical access controls | RBAC (4 roles: viewer/operator/auditor/admin), PBKDF2 passwords (100K iterations, SHA-512), session tokens (256-bit) | `data/users/users.json`, audit logs |
| CC6.1 | MFA for privileged access | TOTP MFA (RFC 6238) with recovery codes (SHA-256, timing-safe), step-up auth for high-risk ops, MFA-pending session lifecycle | Audit entries for MFA setup/verify |
| CC6.2 | Access provisioning | `createUser()` with role assignment, audit logged | Audit log: `user.created` entries |
| CC6.3 | Access removal | `destroySession()`, user removal, session TTL expiry, MFA-pending session timeout (5 min) | Audit log: session/user events |
| CC6.6 | Encryption in transit | Tailscale WireGuard, optional HTTPS (cert path validated), HMAC-SHA256 request signing with nonce replay prevention | Server config, HSTS headers |
| CC6.8 | Input validation | Body size limits (1MB), event payload limits (64KB), path traversal prevention, ReDoS-safe regex (200 char limit), session ID validation | Middleware code, 400/413 responses |
| CC7.1 | Monitoring and detection | SSE live feed, health polling, drift scoring (5 factors, 0-100), activity heatmap, streak tracking | Event store JSONL, snapshots |
| CC7.2 | Activity logging | Append-only audit with SHA-256 hash chains, async writes with error handling | `data/audit/YYYY-MM-DD.jsonl` |
| CC7.3 | Incident response | Kill switch (session/node/global with step-up auth), tripwire auto-quarantine, evidence export (ZIP with Ed25519 signature) | Kill events, quarantine events, bundles |
| CC7.4 | Anomaly detection | Intent drift scoring (5 factors: toolDivergence, scopeCreep, loopiness, costSpike, forbiddenAccess), policy engine with ABAC | Drift scores in session snapshots |
| CC8.1 | Change management | 4-eyes approval (self-approve prevention, 1-hour expiry), step-up auth, audit trail with before/after state | Approval events, audit entries |
| CC3.1 | Risk assessment | Policy engine with enforcement ladder, sandbox enforcement, tripwires with auto-quarantine | Policy files, tripwire configs |

### ISO 27001 Annex A

| Control | Description | ClawCC Implementation | Evidence |
|---------|-------------|----------------------|----------|
| A.5.1 | Information security policies | Policy engine with versioned JSON rules, ABAC conditions | `policies/*.json` |
| A.6.1 | Organization of information security | RBAC roles (4 levels), separation of duties (4-eyes with self-approve prevention) | User roles, approval workflow |
| A.8.1 | Asset management | Node fleet registry, topology snapshots, heartbeat monitoring | `data/snapshots/topology.json` |
| A.9.1 | Access control policy | RBAC + ABAC conditions (env, time windows, risk scores, node tags, roles) | Auth module, policy conditions |
| A.9.2 | User access management | User creation/removal with role assignment, access review endpoint | Audit: user events |
| A.9.3 | User responsibilities | PBKDF2 password hashing (100K iterations), TOTP MFA with recovery codes | PBKDF2 config, MFA records |
| A.9.4 | System access control | Session management (24h TTL, rotation), rate limiting (100 req/min), lockout (5 attempts/15 min) | Session TTL, lockout config |
| A.10.1 | Cryptographic controls | PBKDF2-SHA512, HMAC-SHA256, Ed25519, SHA-256 hash chains, timing-safe comparisons | `lib/crypto.js` implementation |
| A.12.1 | Operational procedures | Typed safe actions via `execFileSync`, command allowlists with argument constraints | `allowlists/commands.json` |
| A.12.4 | Logging and monitoring | Append-only audit with hash chains, event store with async write queue, SSE streaming | JSONL files, SSE endpoint |
| A.12.6 | Technical vulnerability management | Path sandbox with symlink resolution, input validation, ReDoS protection, CSP nonces | Sandbox module, middleware |
| A.13.1 | Network security | Tailscale WireGuard, HMAC signing with nonce replay prevention, CORS restrictions | Agent config, middleware |
| A.14.2 | Security in development | Zero dependencies, stdlib-only crypto, 234 tests across 11 suites | No node_modules, test results |
| A.16.1 | Incident management | Kill switch (3 levels), tripwire auto-quarantine, evidence export (ZIP) | Kill events, evidence bundles |
| A.18.1 | Compliance | This document, evidence inventory, receipt chain verification tools | COMPLIANCE_PACK.md |

### NIST Cybersecurity Framework (CSF)

| Function | Category | Subcategory | ClawCC Implementation |
|----------|----------|-------------|----------------------|
| Identify | ID.AM | Asset management | Fleet registry, node heartbeats, topology snapshots |
| Identify | ID.RA | Risk assessment | Policy engine with ABAC, drift scoring (5 factors), tripwires |
| Protect | PR.AC | Access control | RBAC (4 roles), ABAC conditions, TOTP MFA, MFA-pending sessions, session management |
| Protect | PR.DS | Data security | SHA-256 hash chains, Ed25519 signing, secret redaction, atomic file writes |
| Protect | PR.IP | Protective processes | 4-eyes approval (self-approve prevention), step-up auth, policy gates |
| Protect | PR.PT | Protective technology | Sandbox (execFileSync, allowlists), CSP nonces, security headers, rate limiting |
| Detect | DE.AE | Anomaly detection | Intent drift scoring, policy evaluation with enforcement ladder |
| Detect | DE.CM | Continuous monitoring | SSE streaming, health polling, activity heatmap, usage alerts |
| Detect | DE.DP | Detection processes | Tripwires, honeytokens, auto-quarantine with evidence preservation |
| Respond | RS.AN | Analysis | Event query API, session timeline, session compare, causality explorer, blast radius |
| Respond | RS.MI | Mitigation | Kill switch (session/node/global), auto-quarantine, node quarantine |
| Respond | RS.RP | Response planning | Evidence bundle export (ZIP with Ed25519 signature), receipt verification |
| Recover | RC.RP | Recovery planning | Canary rollout with auto-rollback, skill rollback, snapshot rebuild from JSONL |

---

## 3. Evidence Inventory

### 3.1 Persistent Evidence Artifacts

| Artifact | Location | Format | Integrity |
|----------|----------|--------|-----------|
| Event logs | `data/events/YYYY-MM-DD.jsonl` | JSONL, one event per line | Append-only files, async serialized writes |
| Audit logs | `data/audit/YYYY-MM-DD.jsonl` | JSONL with hash chain | SHA-256 `prevHash` linking |
| Receipt ledger | `data/receipts/receipts-YYYY-MM-DD.jsonl` | JSONL with hash chain | SHA-256 chain, Ed25519 daily roots |
| Daily root signatures | `data/receipts/roots/YYYY-MM-DD.json` | JSON | Ed25519 signature over root hash |
| Session snapshots | `data/snapshots/sessions.json` | JSON | Rebuilt from events on boot, eviction at 50K |
| Usage snapshots | `data/snapshots/usage.json` | JSON | Rebuilt from events on boot |
| Health snapshots | `data/snapshots/health.json` | JSON | Rebuilt from events on boot |
| Topology snapshots | `data/snapshots/topology.json` | JSON | Rebuilt from events on boot |
| User records | `data/users/users.json` | JSON | PBKDF2-hashed passwords, atomic writes |
| Signing keys | `data/receipts/keys.json` | JSON | Ed25519 key pair |
| Policy definitions | `policies/*.json` | JSON | Audit logged changes, atomic writes |
| Tripwire configs | `tripwires/*.json` | JSON | Audit logged changes, atomic writes |
| Command allowlists | `allowlists/commands.json` | JSON | Static configuration |
| Path allowlists | `allowlists/paths.json` | JSON | Static configuration |

### 3.2 API Evidence Endpoints

| Endpoint | Method | Description | Permission |
|----------|--------|-------------|------------|
| `/api/governance/audit` | GET | Query audit log entries (capped at 10K per query) | `audit:read` |
| `/api/governance/receipts/verify` | GET | Verify receipt chain integrity | Authenticated |
| `/api/governance/evidence/export` | POST | Export signed evidence bundle (ZIP) | `export:evidence` |
| `/api/governance/evidence/verify` | POST | Verify evidence bundle signature | Authenticated |
| `/api/governance/access-review` | GET | List users with roles and MFA status | `audit:read` |
| `/api/governance/approvals` | GET | List pending approval requests | Authenticated |
| `/api/events/query` | GET | Query historical events | Authenticated |
| `/api/sessions/:id/timeline` | GET | Session event timeline | Authenticated |

---

## 4. Evidence Collection Guide

### 4.1 Access Control Evidence (CC6.1, A.9, PR.AC)

```bash
# List all users with roles and MFA status
curl -b "clawcc_session=$TOKEN" http://localhost:3400/api/governance/access-review

# Query user creation/modification audit entries
curl -b "clawcc_session=$TOKEN" "http://localhost:3400/api/governance/audit?action=user.created"

# Query session creation events
curl -b "clawcc_session=$TOKEN" "http://localhost:3400/api/governance/audit?action=session.created"
```

### 4.2 Audit Log Evidence (CC7.2, A.12.4, DE.AE)

```bash
# Query audit entries for a date range
curl -b "clawcc_session=$TOKEN" "http://localhost:3400/api/governance/audit?from=2026-01-01&to=2026-03-01&limit=500"

# Verify receipt chain integrity
curl -b "clawcc_session=$TOKEN" "http://localhost:3400/api/governance/receipts/verify?date=2026-03-01"

# Export signed evidence bundle
curl -X POST -b "clawcc_session=$TOKEN" -H "Content-Type: application/json" \
  -d '{"sessionId":"sess-123"}' \
  http://localhost:3400/api/governance/evidence/export
```

### 4.3 Change Management Evidence (CC8.1, A.14, PR.IP)

```bash
# Query policy change audit entries
curl -b "clawcc_session=$TOKEN" "http://localhost:3400/api/governance/audit?action=policy.updated"

# Query approval workflow events
curl -b "clawcc_session=$TOKEN" "http://localhost:3400/api/governance/approvals?all=true"

# Query skill deployment events
curl -b "clawcc_session=$TOKEN" "http://localhost:3400/api/governance/audit?action=skill.deployed"
```

### 4.4 Incident Response Evidence (CC7.3, A.16, RS.AN)

```bash
# Query kill switch activations
curl -b "clawcc_session=$TOKEN" "http://localhost:3400/api/governance/audit?action=kill.session"

# Query tripwire triggers
curl -b "clawcc_session=$TOKEN" "http://localhost:3400/api/governance/tripwires/triggers"

# Query auto-quarantine events
curl -b "clawcc_session=$TOKEN" "http://localhost:3400/api/governance/audit?action=tripwire.auto-quarantine"
```

---

## 5. Verification Procedures

### 5.1 Receipt Chain Verification

Using the CLI:

```bash
node cli/clawcc.js verify <evidence-bundle.json>
```

Using the API:

```bash
# Verify chain for a specific date
curl -b "clawcc_session=$TOKEN" "http://localhost:3400/api/governance/receipts/verify?date=2026-03-01"

# Verify an exported evidence bundle
curl -X POST -b "clawcc_session=$TOKEN" -H "Content-Type: application/json" \
  -d @evidence-bundle.json \
  http://localhost:3400/api/governance/evidence/verify
```

### 5.2 Audit Log Hash Chain Verification

Audit log entries contain `hash` and `prevHash` fields. To verify:

1. Read the JSONL file for the target date
2. For each entry, verify that `hash = SHA-256(prevHash + SHA-256(entry_data))`
3. Verify that each entry's `prevHash` matches the previous entry's `hash`
4. The first entry of the day chains from the last entry of the previous day

### 5.3 Daily Root Signature Verification

Daily root files in `data/receipts/roots/YYYY-MM-DD.json` contain:

```json
{
  "date": "2026-03-01",
  "rootHash": "<hex>",
  "signature": "<hex>",
  "receiptCount": 42
}
```

Verify by:
1. Recompute the root hash from receipts: `SHA-256(receipt1.hash + receipt2.hash + ...)`
2. Verify the Ed25519 signature against the public key in `data/receipts/keys.json`

---

## 6. Retention and Rotation

### 6.1 Default Retention

| Data Type | Retention | Rotation |
|-----------|-----------|----------|
| Event logs | Configurable (default: 90 days) | Daily files |
| Audit logs | Configurable (default: 365 days) | `audit.rotate(dataDir, retentionDays)` |
| Receipt ledger | Indefinite | Daily files, should not be deleted |
| Snapshots | Current state | Rebuilt on boot, updated periodically (default: 60s) |
| User records | Until deleted | Manual management |

### 6.2 Backup Recommendations

1. **Daily**: Back up `data/` directory to offsite storage
2. **Weekly**: Verify receipt chain integrity across all dates
3. **Monthly**: Export evidence bundles for the period and archive
4. **Quarterly**: Run access review and document findings

### 6.3 Data Integrity Checks

Schedule periodic integrity verification:

```bash
# Verify receipt chain for each date
for date in $(ls data/receipts/roots/ | sed 's/.json//'); do
  curl -b "clawcc_session=$TOKEN" "http://localhost:3400/api/governance/receipts/verify?date=$date"
done
```

Any `valid: false` result indicates potential tampering and should trigger an incident investigation.
