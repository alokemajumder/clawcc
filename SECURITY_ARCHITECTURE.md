# ClawCC Security Architecture

## 1. Overview

ClawCC employs a defense-in-depth design philosophy. Every layer -- from network transport to data storage -- implements independent security controls. The system assumes a hostile environment in which any single component may be compromised, and enforces least-privilege access at every boundary.

All cryptographic operations use the Node.js `node:crypto` module exclusively. No external dependencies are used anywhere in the codebase.

---

## 2. Threat Model

### 2.1 Trust Boundaries

```
+-------------------+     +-------------------+     +-------------------+
|   Human Operator  |     |   Control Plane   |     |    Node Agent     |
|   (Browser/CLI)   |---->|   (server.js)     |<----|   (agent.js)      |
|                   |     |                   |     |                   |
|  Trust: Verified  |     |  Trust: High      |     |  Trust: Partial   |
|  via session +    |     |  Owns data store  |     |  HMAC-verified    |
|  MFA              |     |  and policy       |     |  requests only    |
+-------------------+     +-------------------+     +-------------------+
```

| Boundary | Controls |
| --- | --- |
| Operator to Control Plane | Session cookie (`HttpOnly`, `SameSite=Lax`, `Secure`), RBAC, step-up MFA, MFA-pending session lifecycle |
| Node Agent to Control Plane | HMAC request signing, nonce replay prevention, per-node shared secrets, timestamp freshness |
| Control Plane to Data Store | Append-only JSONL, hash chains, Ed25519 signatures, atomic file writes |
| Control Plane to Node Agent | Typed safe actions only (no shell), allowlist enforcement |

### 2.2 Attack Surfaces

| Surface | Mitigations |
| --- | --- |
| HTTP API endpoints | Rate limiting, input validation, body size limits, auth middleware, CORS restrictions |
| Static file serving | Path traversal prevention, directory root checks, symlink resolution, no directory listing |
| SSE event stream | Authenticated sessions only, no write capability, maximum 1-hour lifetime |
| Agent registration | HMAC-signed requests with timestamp freshness check, nonce replay prevention, default-secret rejection |
| Configuration files | Local filesystem only, no remote config fetching, port range validation, HTTPS certificate path validation |

### 2.3 Threat Actors

| Actor | Capability | Mitigations |
| --- | --- | --- |
| Compromised Agent Node | Send malicious events, attempt command injection | HMAC verification, event validation, sandbox enforcement, tripwires, auto-quarantine |
| Malicious Insider (Operator) | Abuse privileges, tamper with logs | RBAC, 4-eyes approval with self-approve prevention, append-only audit, hash chains, step-up auth |
| Network Attacker | Man-in-the-middle, replay, eavesdropping | Tailscale encryption, HMAC nonces, HSTS, optional TLS, CORS |
| Unauthorized User | Brute-force login, session hijacking | Account lockout (5 attempts per 15 minutes), PBKDF2, secure cookies, MFA-pending lifecycle |

---

## 3. Identity and Access Management

### 3.1 Password Hashing

- **Algorithm**: PBKDF2
- **Hash function**: SHA-512
- **Iterations**: 100,000
- **Key length**: 64 bytes
- **Salt**: 32 bytes, cryptographically random per user
- **Comparison**: `crypto.timingSafeEqual()` to prevent timing attacks
- **Storage**: `salt:hash` format in `data/users/users.json`
- **Persistence**: Users are loaded from disk on startup and saved on every change using an atomic write-to-temp-then-rename pattern
- **Implementation**: `control-plane/lib/crypto.js` -- `hashPassword()`, `verifyPassword()`

### 3.2 TOTP Multi-Factor Authentication

- **Standard**: RFC 6238 (TOTP)
- **Algorithm**: HMAC-SHA1 (per RFC specification)
- **Digits**: 6
- **Period**: 30 seconds
- **Window tolerance**: +/- 1 step (90-second validity)
- **Secret encoding**: Custom Base32 implementation (no external library)
- **Recovery codes**: 10 random codes generated on MFA setup, stored as SHA-256 hashes, verified with `crypto.timingSafeEqual()`
- **Implementation**: `control-plane/lib/crypto.js` -- `generateTOTPSecret()`, `generateTOTPCode()`, `verifyTOTPCode()`

### 3.3 Session Management

- **Token generation**: `crypto.randomBytes(32).toString('hex')` (256-bit entropy)
- **Storage**: In-memory Map (no session data persisted to disk)
- **TTL**: Configurable; default is 24 hours
- **Rotation**: `rotateSession()` creates a new token and invalidates the previous one
- **Cookies**: `HttpOnly`, `SameSite=Lax`, `Secure` (when HTTPS is enabled), `Path=/`
- **Cleanup**: Expired sessions are removed on the next validation attempt
- **MFA-pending sessions**: When MFA is enabled, login creates a short-lived session (5-minute TTL) with `mfaPending: true`. This session is blocked from all endpoints except MFA verification. After successful verification, `upgradeSession()` clears the pending flag and extends the TTL to the standard duration.

### 3.4 Role-Based Access Control (RBAC)

| Role | Permissions | Use Case |
| --- | --- | --- |
| `viewer` | `read` | Read-only dashboard access |
| `operator` | `read`, `action` | Execute safe actions, manage sessions |
| `auditor` | `read`, `audit` | Read audit logs, export evidence |
| `admin` | `read`, `action`, `admin`, `audit` | Full access, including user management |

### 3.5 Attribute-Based Access Control (ABAC)

Policy rules support ABAC conditions that are evaluated before a rule fires:

| Condition | Description | Example |
| --- | --- | --- |
| `env` | Restrict to specific environments | `["production", "staging"]` |
| `timeWindow` | Time-of-day and day-of-week restrictions (UTC) | `{ "after": "09:00", "before": "17:00", "days": [1,2,3,4,5] }` |
| `minRiskScore` | Fire only when the drift/risk score exceeds a threshold | `30` |
| `nodeTags` | Require or forbid specific node tags | `{ "required": ["monitored"], "forbidden": ["exempt"] }` |
| `roles` | Restrict to specific user roles | `["admin", "operator"]` |

### 3.6 Step-Up Authentication

High-risk actions require MFA re-verification within a configurable time window (default: 5 minutes):

- Kill switch activation (session, node, or global)
- Policy modification
- Tripwire configuration changes
- Skill deployment

### 3.7 Four-Eyes Approval Workflow

Critical operations can require approval from two independent administrators:

- The requester creates an approval request containing action details.
- A different user (not the requester) must approve -- self-approval is explicitly prevented.
- Approval requests expire after a configurable window (default: 1 hour).
- The in-memory store is capped at 1,000 pending requests; expired entries are evicted on insert.
- All approval actions are recorded in the audit trail.

---

## 4. Network Security

### 4.1 Tailscale-First Architecture

- Nodes connect over the Tailscale mesh VPN by default.
- WireGuard encryption secures all node-to-control-plane traffic.
- Tailscale ACLs can restrict which nodes are permitted to access the control plane.
- Agent discovery includes Tailscale IP and peer information.

### 4.2 HMAC Request Signing

Node agents sign every request to the control plane:

```
Signature = HMAC-SHA256(
  sharedSecret,
  method + "\n" + path + "\n" + timestamp + "\n" + body
)
```

Headers sent with each signed request:

- `x-clawcc-nodeid` -- Node identifier
- `x-clawcc-timestamp` -- Unix timestamp (milliseconds)
- `x-clawcc-nonce` -- Random nonce (UUID)
- `x-clawcc-signature` -- HMAC-SHA256 hex digest

Security controls:

- **Freshness**: Requests older than 5 minutes are rejected (`maxAgeMs: 300000`).
- **Replay prevention**: The nonce tracker rejects duplicate nonces within the freshness window (5-minute TTL).
- **Default-secret rejection**: Requests signed with the default placeholder secret are rejected.
- **Timing-safe comparison**: Signatures are verified using `crypto.timingSafeEqual()`.
- **Per-node secrets**: Optional per-node secrets via `fleet.nodeSecrets` in the configuration (falls back to `sessionSecret`).
- **Implementation**: `control-plane/middleware/auth-middleware.js` -- `verifyNodeSignature()`

### 4.3 TLS Support

- Optional HTTPS mode with user-provided certificate and key (paths are validated on startup).
- HSTS header (`max-age=31536000; includeSubDomains`) is applied when HTTPS is enabled.
- Recommended: use Tailscale for encryption, or place the control plane behind a reverse proxy with TLS termination.

### 4.4 CORS

- Configurable allowed origins via `security.corsOrigins` in the configuration.
- Default: empty array (same-origin only).
- OPTIONS preflight requests are handled automatically.
- `Access-Control-Allow-Credentials: true` is set for cookie-based authentication.

---

## 5. Data Security

### 5.1 Append-Only Audit Logs

- **Storage**: `data/audit/YYYY-MM-DD.jsonl`
- **Write mode**: Asynchronous append with error callback; directory creation is cached to avoid repeated `mkdirSync` calls.
- **Hash chain**: Each entry includes a `prevHash` field linking to the previous entry.
- **Fields**: `actor`, `action`, `target`, `detail`, `reason`, `before`, `after`, `timestamp`, `hash`, `prevHash`
- **Query cap**: Maximum of 10,000 entries per query to prevent excessive memory consumption.
- **Rotation**: Configurable retention period via `audit.rotate(dataDir, retentionDays)`.

### 5.2 Receipt Ledger

- **Storage**: `data/receipts/receipts-YYYY-MM-DD.jsonl` (hash-chained)
- **Chain**: SHA-256 hash chain -- each receipt hashes `prevHash + dataHash`.
- **Daily root**: A root hash of all daily receipts, signed with Ed25519.
- **Root storage**: `data/receipts/roots/YYYY-MM-DD.json`
- **Key persistence**: Ed25519 key pair stored in `data/receipts/keys.json`.
- **Verification**: Available via CLI (`clawcc verify`) and API (`/api/governance/receipts/verify`).
- **Export**: Evidence bundles include receipts, a bundle hash, and an Ed25519 signature.

### 5.3 Event Write Queue

- **Serialized writes**: An asynchronous write queue prevents data corruption under concurrent event ingestion.
- **Backpressure logging**: When the write queue is busy, a drop counter logs the number of delayed events.
- **Stats export**: `getWriteQueueStats()` returns `{ queued, dropped, writing }` for monitoring.
- **Graceful shutdown**: Write queue statistics are logged on process exit.

### 5.4 Secret Redaction

Events are automatically scrubbed before storage. The following patterns are matched:

- `password`, `token`, `secret`, `key`, `apiKey`, `api_key`
- `Bearer` tokens in string values
- Custom patterns (configurable)

Agent discovery also redacts secrets from discovered data and strips credentials from Git URLs.

### 5.5 Input Validation

- **Body size**: Configurable maximum (default: 1 MB), enforced in `parseBody()`.
- **Content-Type**: JSON only for API endpoints.
- **Event payloads**: 64 KB maximum; required fields are validated (`type`, `severity`, `nodeId`, `timestamp`).
- **Severity levels**: Restricted to `info`, `warning`, `error`, `critical`.
- **Session IDs**: Validated to reject path traversal patterns (`../`) and non-alphanumeric characters.
- **Config validation**: Port range (1--65535) and HTTPS certificate/key file existence are checked on startup.

---

## 6. Action Sandbox

### 6.1 Command Allowlist

Only explicitly allowed commands can be executed on agent nodes:

- Commands are defined in `allowlists/commands.json` with permitted arguments.
- Argument constraints: `allowed` (whitelist) and `disallowed` (blocklist) patterns.
- No shell interpretation -- commands are executed via `execFileSync` (not `exec` or `execSync`).
- Arguments are passed as an array via `action.args` (not through string concatenation).
- Output is truncated to 64 KB.
- Error messages are sanitized to prevent information leakage.

### 6.2 Path Security

- **Allowlist**: Only files within declared paths are accessible.
- **Canonicalization**: `path.resolve()` normalizes all paths before checking.
- **Traversal prevention**: Raw input is checked for `..` sequences before resolution.
- **Symlink resolution**: `fs.realpathSync()` follows symlinks and verifies that the resolved target falls within allowed paths.
- **macOS handling**: The `/tmp` symlink to `/private/tmp` is resolved before allowlist checks.
- **Protected paths**: Require an explicit approval flag for access.
- **Forbidden paths**: Hard-blocked with no override.

### 6.3 Implementation

- `node-agent/lib/sandbox.js` -- `createSandbox()` factory with `validateCommand()`, `isPathAllowed()`, `checkSymlink()`, `validateFileOperation()`
- `allowlists/commands.json` -- Default allowed commands (`restart-agent`, `restart-clawcc-agent`, `tailscale-status`, `disk-usage`, `process-list`, `rotate-logs`, `git-log`, `list-cron`)
- `allowlists/paths.json` -- Allowed paths (20+ AI agent configuration paths), protected paths (credential files), forbidden paths (`~/.ssh`, `~/.gnupg`, `~/.aws`, `/etc/shadow`, `/etc/passwd`)

---

## 7. Security Headers

All HTTP responses include the following headers, applied via `control-plane/middleware/security.js`:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'nonce-<random>'; style-src 'self' 'nonce-<random>'; img-src 'self' data:; connect-src 'self'; font-src 'self'` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (HTTPS only) |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `X-XSS-Protection` | `0` (modern CSP is preferred) |

CSP nonces are generated per request (16 random bytes, Base64-encoded) and injected into both the CSP header and HTML `<script>`/`<style>` tags via `serveStatic()` in `server.js`.

### 7.1 Rate Limiting

- **Algorithm**: Sliding window per IP address
- **Default**: 100 requests per 60 seconds (configurable)
- **Auth endpoint**: Additional rate limit of 10 login attempts per minute per IP
- **Response**: HTTP 429 with a JSON error body
- **Memory protection**: Rate limit maps auto-evict expired entries above 10,000 IPs
- **Configuration**: `security.rateLimitWindowMs` and `security.rateLimitMaxRequests`

### 7.2 Request Timeouts

- **Default**: 30 seconds per request (configurable via `security.requestTimeoutMs`)
- **Response**: HTTP 408 with a JSON error body
- **SSE streams**: Maximum 1-hour connection lifetime with automatic cleanup
- **Server-level**: `keepAliveTimeout` set to 65 seconds; `headersTimeout` set to 66 seconds

---

## 8. Tripwires and Honeytokens

### 8.1 Configuration

Tripwires are defined in `tripwires/default.tripwires.json`:

- **File honeytokens**: Decoy paths that trigger on access (e.g., `/etc/shadow`, `.env.production`)
- **URL honeytokens**: Decoy URLs that trigger on request
- **Secret honeytokens**: Decoy credentials that trigger on use
- **Path honeytokens**: Decoy filesystem paths that trigger on traversal

### 8.2 Auto-Quarantine

When a `tripwire.triggered` event is ingested, the following sequence executes:

1. The associated session is immediately ended (severity: critical).
2. The associated node is quarantined.
3. A receipt is created for the quarantine action to preserve evidence.
4. An audit log entry records the auto-quarantine, attributed to the `system` actor.

### 8.3 Evidence Preservation

Tripwire triggers automatically produce:

- Event records (`session.ended`, `node.quarantined`)
- Receipt ledger entries
- Audit trail entries
- Evidence available for export via `/api/governance/evidence/export`

---

## 9. Signed Skills

### 9.1 Verification

Before a skill is deployed to the fleet:

1. The deployment request must include `signature`, `publicKey`, and `bundle` fields.
2. The Ed25519 signature is verified against the bundle content.
3. If `skills.requireSigned` is `true` (the default), unsigned bundles are rejected.
4. Only admin users with step-up authentication may deploy skills.

### 9.2 Canary Rollout

Skills can be deployed to a subset of nodes before a full fleet rollout:

- Default canary percentage: 10% (configurable via `skills.canaryPercentage`).
- Events are emitted per canary node with `phase: "canary"`.
- Phase tracking follows a canary-to-full-deployment progression.
- Auto-rollback is triggered when the drift score exceeds its threshold (default: 80).
- Auto-rollback is also triggered when the error rate exceeds its threshold (default: 10%).
- Manual rollback is available via `/api/governance/skills/:id/rollback`.

---

## 10. Compliance Controls

### 10.1 Audit Trail Completeness

Every state-changing operation produces an audit entry containing:

- **Who**: Actor username
- **What**: Action type
- **Where**: Target resource
- **When**: ISO 8601 timestamp
- **Before/after state**: Captured for all modifications
- **Reason**: Required for destructive actions
- **Hash chain link**: Provides tamper evidence

### 10.2 Evidence Export

- ZIP evidence bundles containing `events.jsonl`, `receipts.json`, `audit.jsonl`, and `manifest.json`.
- Each bundle includes a hash and an Ed25519 signature for integrity verification.
- CLI verifier (`clawcc verify`) supports offline integrity checking.
- API endpoint (`/api/governance/evidence/verify`) enables programmatic verification.

### 10.3 Access Review

- `GET /api/governance/access-review` lists all users with their roles, MFA status, and creation dates.
- Requires the `audit:read` permission (auditor or admin role).

For detailed control mappings to SOC 2, ISO 27001, and NIST CSF, see [COMPLIANCE_PACK.md](COMPLIANCE_PACK.md).

---

## 11. Production Hardening

### 11.1 Process Resilience

- **Uncaught exceptions**: Logged to the console and audit trail; non-fatal errors do not crash the process.
- **Unhandled rejections**: Logged to the console and audit trail.
- **Graceful shutdown**: SIGTERM and SIGINT trigger a snapshot flush, connection draining (3-second grace period), write queue completion, and a clean exit.
- **Double-shutdown prevention**: A guard flag prevents concurrent shutdown sequences.
- **Default password protection**: The server refuses to start in production mode if the admin password remains at its default value.

### 11.2 Memory Bounds

All in-memory collections are bounded to prevent out-of-memory conditions:

| Collection | Location | Cap | Eviction Strategy |
| --- | --- | --- | --- |
| In-memory events | `index.js` | 500K events | Oldest 10% evicted (FIFO); persisted on disk |
| Sessions (snapshots) | `snapshots.js` | 50K sessions | Ended sessions older than 30 days evicted |
| Usage ring buffer | `index.js` | 100K entries | Oldest evicted (FIFO) |
| Regex cache | `policy.js` | 1K patterns | Oldest evicted (FIFO) |
| Canary deployments | `server.js` | 100 entries | Expired entries evicted on insert |
| Approval requests | `governance-routes.js` | 1K entries | Expired/completed entries evicted on insert |
| Pending commands | `fleet-routes.js` | 50 per node | Rejected at capacity; empty nodes evicted |
| Auth rate limits | `security.js` | 10K IPs | Expired entries evicted on insert |
| Push subscriptions | `ops-routes.js` | 1K entries | Rejected at capacity |
| Health history | `ops-routes.js` | 17,280 entries | Oldest evicted (24 hours at 5-second intervals) |
| Cron history | `ops-routes.js` | 200 entries | Oldest spliced |
| Nonce tracker | `auth-middleware.js` | 5-minute window | Expired nonces removed automatically |

### 11.3 Data Integrity

- **Serialized JSONL writes**: An asynchronous write queue prevents data corruption under concurrent event ingestion.
- **Atomic file writes**: User data, policies, and tripwires use a write-to-temp-then-rename pattern.
- **Symlink-aware path checks**: Both `sanitizePath()` and `serveStatic()` resolve symlinks via `fs.realpathSync()` before performing allowlist comparison.
- **ReDoS protection**: Policy regex patterns are length-limited (200 characters), checked for dangerous constructs (nested quantifiers), and cached after compilation (1K cache cap).
- **Safe URI decoding**: `decodeURIComponent()` is wrapped in a try/catch block to handle malformed URLs in cookie parsing and route parameters.

### 11.4 Connection Management

- **Connection tracking**: All TCP connections are tracked in a Set for graceful shutdown.
- **SSE cleanup**: Streams have a maximum 1-hour lifetime, are cleaned up on error, and include keepalive failure detection.
- **Keep-alive timeout**: Server-level `keepAliveTimeout` (65 seconds) and `headersTimeout` (66 seconds) prevent connection leaks.

### 11.5 Health Probes

- **Unauthenticated**: `/healthz` and `/api/healthz` respond without requiring session cookies.
- **Response**: `{"status":"ok","uptime":<seconds>}`
- **Use case**: Load balancer health checks, Kubernetes liveness and readiness probes, and external monitoring systems.
