<div align="center">

# ClawCC

### Fleet Control Center for AI Agents

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)](package.json)
[![Tests](https://img.shields.io/badge/tests-234%20passing-brightgreen?style=flat-square)](test/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

**Self-hosted mission control for managing, monitoring, governing, and replaying AI agent fleets.**
**Zero external dependencies. Pure Node.js. Air-gappable.**

[Quick Start](#quick-start) | [Documentation](#api-reference) | [Security](#security) | [Contributing](#contributing)

</div>

---

## Why ClawCC?

AI agents are powerful but opaque. When you run a fleet of them -- across machines, teams, or environments -- you need visibility, control, and accountability. ClawCC gives you all three without vendor lock-in or dependency bloat.

| Problem | ClawCC Solution |
|---------|----------------|
| "What did my agents do?" | Append-only event ledger with session replay, timeline, and causality tracing |
| "Are my agents drifting from intent?" | Intent contracts with 5-factor drift scoring and enforcement ladders |
| "How do I stop a rogue agent?" | Emergency kill switch (session/node/global) with step-up MFA |
| "Can I prove compliance?" | Hash-chained audit trails, Ed25519 signed receipts, ZIP evidence export |
| "Do I need to install 500 npm packages?" | Zero. Not one. Pure Node.js stdlib. |

---

## Key Highlights

**Zero Dependencies** -- No `npm install`. No `node_modules`. No supply chain risk. The entire project runs on Node.js stdlib (`node:crypto`, `node:fs`, `node:http`).

**Real-Time Observability** -- SSE live feed, activity heatmaps, streak tracking, interactive topology graph, blast radius analysis, and causality explorer.

**Security-First** -- PBKDF2 (100K iterations), TOTP MFA, HMAC-signed requests, Ed25519 signatures, CSP nonces, ReDoS protection, rate limiting, auto-secret-redaction.

**Compliance-Ready** -- SOC 2, ISO 27001, and NIST CSF control mappings with machine-verifiable evidence artifacts.

**Portable** -- Runs anywhere Node.js does: bare metal, Docker, Termux on Android, behind Tailscale mesh VPN.

---

## Features

<details>
<summary><strong>Core Platform</strong></summary>

- **Append-Only JSONL Events** -- Tamper-evident event storage with daily rotation and async serialized writes
- **Hybrid Index Layer** -- In-memory indexes rebuilt from JSONL on boot; O(1) lookups instead of file scans
- **SSE Real-Time Streaming** -- Server-Sent Events with filters, keepalive, and auto-cleanup
- **Tailscale Networking** -- Tailnet-first node discovery and peer visibility
- **Digital Twin Replay** -- Session comparison and step-by-step replay with scrubber
- **Topology Graph** -- Interactive SVG cognitive graph of agents, tools, files, and services
- **Activity Heatmap & Streaks** -- 30-day event visualization with streak tracking
- **Blast Radius Analysis** -- Per-session and per-node impact assessment
- **Causality Explorer** -- Trace file/tool references across sessions
- **Usage Alerts** -- Configurable cost, token, and error rate thresholds with rolling windows
</details>

<details>
<summary><strong>Security & Governance</strong></summary>

- **Zero-Trust Sandbox** -- Path canonicalization, symlink resolution, traversal prevention
- **Typed Safe Actions** -- Command and path allowlists; no remote shell access
- **Intent Contracts** -- Drift scoring across 5 factors with enforcement ladder
- **Policy Engine** -- Rule evaluation with ABAC conditions (environment, time windows, risk scores, node tags, roles)
- **Tripwires / Honeytokens** -- Configurable decoy secrets, paths, and URLs with auto-quarantine
- **Signed Skills Registry** -- Ed25519 skill signing with canary rollout and auto-rollback
- **Tamper-Evident Receipt Ledger** -- SHA-256 hash chains with daily Ed25519 root signing
- **4-Eyes Approval Workflow** -- Dual-approver mechanism for high-risk actions with self-approve prevention
- **Evidence Export** -- ZIP bundles with events, audit logs, receipts, and integrity hashes
</details>

<details>
<summary><strong>Operations</strong></summary>

- **Mobile Ops (Pocket PWA)** -- Live feed, alerts, push notifications, and emergency kill with step-up auth
- **CLI Tool** -- 18 commands for fleet management, policy simulation, evidence export
- **Graceful Shutdown** -- Connection draining, snapshot flushing, write queue completion, signal handling
- **Health Probes** -- Unauthenticated `/healthz` for load balancers and Kubernetes
</details>

---

## Architecture

```
                         +---------------------+
                         |     Clients          |
                  +------+------+------+--------+
                  |      |      |      |
               UI (SPA)  CLI  Pocket  Termux
               :3400/   shell  PWA    Android
                  |      |      |      |
                  +------+------+------+
                         |
                    HTTP / SSE
                         |
              +----------+----------+
              |   Control Plane     |
              |   (server.js)       |
              |                     |
              |  +-- Router         |
              |  +-- Auth / RBAC    |
              |  +-- Security MW    |
              |  +-- Hybrid Index   |
              |  +-- Events Store   |
              |  +-- Snapshots      |
              |  +-- Policy Engine  |
              |  +-- Intent / Drift |
              |  +-- Receipts       |
              |  +-- Audit Logger   |
              +----------+----------+
                         |
            Tailscale / HTTP signed requests
                         |
         +---------------+---------------+
         |               |               |
   +-----------+   +-----------+   +-----------+
   | Node      |   | Node      |   | Node      |
   | Agent     |   | Agent     |   | Agent     |
   |           |   |           |   |           |
   | discovery |   | discovery |   | discovery |
   | telemetry |   | telemetry |   | telemetry |
   | sandbox   |   | sandbox   |   | sandbox   |
   | spool     |   | spool     |   | spool     |
   +-----------+   +-----------+   +-----------+

              Data Layer (filesystem)
   +------------------------------------------+
   | data/events/YYYY-MM-DD.jsonl             |
   | data/snapshots/{sessions,usage,health,   |
   |                 topology}.json           |
   | data/audit/YYYY-MM-DD.jsonl              |
   | data/receipts/receipts-*.jsonl           |
   | data/receipts/roots/*.json               |
   | data/users/users.json                    |
   +------------------------------------------+
```

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | >= 18.0.0 | The only hard requirement. No npm packages needed. |
| **Operating System** | Linux, macOS, Windows | Tested on Ubuntu 22.04+, macOS 13+, Windows 10+ |
| **Disk Space** | ~50MB + data | Base install is tiny; data grows with event volume |
| **Memory** | 128MB minimum | ~200MB for 500K events in-memory index |

**Optional:**

| Tool | Purpose |
|------|---------|
| Tailscale | Secure mesh networking between nodes (recommended for production) |
| Git | Version tracking on ops workspace page |
| systemd / pm2 | Process management for production deployment |
| nginx / Caddy | Reverse proxy with TLS termination |

---

## Quick Start

### 1. Clone

```bash
git clone https://github.com/alokemajumder/clawcc.git
cd clawcc
```

No `npm install` needed. The entire project runs on the Node.js standard library.

### 2. Configure

```bash
cp config/clawcc.config.example.json clawcc.config.json
```

At minimum, change the `sessionSecret`:

```bash
# Generate a secure session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Edit `clawcc.config.json` and replace the `sessionSecret` value.

### 3. Start the Control Plane

```bash
node control-plane/server.js
```

Or using npm:

```bash
npm start
```

### 4. Open the UI

Navigate to [http://localhost:3400](http://localhost:3400)

Default credentials: **admin** / **changeme**

> **Important:** Change the default password immediately after first login. In production mode (`"mode": "production"`), the server refuses to start with the default password.

### 5. Generate Demo Data (Optional)

```bash
node scripts/generate-demo-data.js
```

Generates 30 days of sample data across 3 nodes and 210 sessions. Restart the server after generating to rebuild indexes.

### 6. Enroll a Node Agent

On each agent machine:

```bash
cp config/node-agent.config.example.json node-agent.config.json
```

Edit `node-agent.config.json`:

```json
{
  "nodeId": "my-agent-01",
  "controlPlaneUrl": "http://YOUR_CONTROL_PLANE_IP:3400",
  "nodeSecret": "SAME_SECRET_AS_CONTROL_PLANE"
}
```

Start the agent:

```bash
node node-agent/agent.js
```

Or using npm:

```bash
npm run agent
```

The agent will register with the control plane, begin sending heartbeats, and stream telemetry.

---

## Configuration Reference

### Control Plane (`clawcc.config.json`)

Copy from `config/clawcc.config.example.json` and customize:

```jsonc
{
  // --- Server ---
  "mode": "local",                    // "local" or "fleet"
  "host": "0.0.0.0",                  // Bind address
  "port": 3400,                       // HTTP port (validated: 1-65535)
  "dataDir": "./data",                // Data storage directory

  // --- HTTPS (optional) ---
  "httpsEnabled": false,              // Enable HTTPS
  "httpsKeyPath": "/path/to/key.pem", // TLS private key (validated: file must exist)
  "httpsCertPath": "/path/to/cert.pem", // TLS certificate (validated: file must exist)

  // --- Secrets ---
  "sessionSecret": "CHANGE_ME_...",   // Used for HMAC verification (generate with openssl rand -hex 32)
  "adminKeyPublic": "",               // Ed25519 public key for admin operations
  "adminKeyPrivate": "",              // Ed25519 private key (keep secure)

  // --- Authentication ---
  "auth": {
    "sessionTtlMs": 86400000,         // Session lifetime: 24 hours
    "lockoutAttempts": 5,             // Failed login attempts before lockout
    "lockoutDurationMs": 900000,      // Lockout duration: 15 minutes
    "stepUpWindowMs": 300000,         // Step-up auth validity: 5 minutes
    "defaultAdminPassword": "changeme" // Initial admin password (must change in production)
  },

  // --- Fleet ---
  "fleet": {
    "heartbeatTimeoutMs": 60000,      // Mark node offline after this duration
    "maxNodes": 100,                  // Maximum registered nodes
    "nodeSecrets": {},                // Per-node HMAC secrets (optional, falls back to sessionSecret)
    "signatureMaxAge": 300000         // Max age for signed requests: 5 minutes
  },

  // --- Events ---
  "events": {
    "maxPayloadBytes": 65536,         // Max event payload: 64KB
    "snapshotIntervalMs": 60000,      // Snapshot rebuild interval: 1 minute
    "retentionDays": 90               // Event retention: 90 days
  },

  // --- Audit ---
  "audit": {
    "retentionDays": 365,             // Audit log retention: 1 year
    "rotationEnabled": true           // Enable log rotation
  },

  // --- Security ---
  "security": {
    "rateLimitWindowMs": 60000,       // Rate limit window: 1 minute
    "rateLimitMaxRequests": 100,      // Max requests per window per IP
    "authRateLimitMaxRequests": 10,   // Auth endpoint limit per minute per IP
    "requestTimeoutMs": 30000,        // Request timeout: 30 seconds
    "csrfEnabled": true,              // CSRF protection
    "corsOrigins": []                 // CORS allowed origins (empty = same-origin only)
  },

  // --- Tailscale (optional) ---
  "tailscale": {
    "enabled": true,                  // Enable Tailscale integration
    "statusCommand": "tailscale status --json"
  },

  // --- Workspace Discovery ---
  "discovery": {
    "paths": ["~/.claude"],           // Paths the ops workspace page can browse
    "intervalMs": 30000               // Discovery refresh interval
  },

  // --- Skills ---
  "skills": {
    "registryPath": "./skills/registry.json",
    "requireSigned": true,            // Require Ed25519 signature for skill deployment
    "canaryPercentage": 10            // Default canary rollout percentage
  },

  // --- Usage Alerts ---
  "alerts": {
    "costPerHour": 5.00,              // Alert when hourly cost exceeds $5
    "tokensPerHour": 100000,          // Alert when hourly tokens exceed 100K
    "errorRateThreshold": 0.10,       // Alert when error rate exceeds 10%
    "enabled": true
  }
}
```

### Node Agent (`node-agent.config.json`)

Copy from `config/node-agent.config.example.json` and customize:

```jsonc
{
  "nodeId": "",                       // Unique node identifier (auto-generated if empty)
  "controlPlaneUrl": "http://localhost:3400",  // Control plane URL
  "nodeSecret": "CHANGE_ME_TO_A_STRONG_SECRET", // HMAC shared secret (must match control plane)
  "tags": ["dev"],                    // Tags for policy targeting
  "discoveryPaths": ["~/.claude"],    // Paths to discover sessions and memory files
  "telemetryIntervalMs": 5000,        // Telemetry reporting interval: 5 seconds
  "heartbeatIntervalMs": 15000,       // Heartbeat interval: 15 seconds
  "dataDir": "./node-data",           // Local data directory
  "allowlistsDir": "../allowlists",   // Path to command/path allowlists
  "spoolDir": "./node-data/spool",    // Offline event spool directory
  "logLevel": "info"                  // Log level: debug, info, warn, error
}
```

### Allowlists

**Command Allowlist** (`allowlists/commands.json`):

Defines which commands agents can execute. Each entry specifies allowed and disallowed argument patterns:

```json
{
  "commands": {
    "ls": { "allowed": ["-la", "-lh"], "disallowed": ["-R"] },
    "cat": { "allowed": [], "disallowed": ["../"] },
    "grep": { "allowed": ["-r", "-n", "-i"], "disallowed": [] }
  }
}
```

**Path Allowlist** (`allowlists/paths.json`):

Controls filesystem access for agents:

```json
{
  "allowed": ["/tmp", "/home/user/workspace"],
  "protected": ["/etc"],
  "forbidden": ["/root", "/proc", "/sys"]
}
```

- **allowed**: Freely accessible paths
- **protected**: Accessible only with explicit approval flag
- **forbidden**: Hard-blocked, no override possible

### Policies

Governance rules in `policies/default.policy.json`:

```json
{
  "id": "default",
  "name": "Default Policy",
  "enabled": true,
  "priority": 10,
  "rules": [
    {
      "field": "type",
      "operator": "eq",
      "value": "tool.call",
      "score": 5,
      "conditions": {
        "env": ["production"],
        "timeWindow": { "after": "09:00", "before": "17:00" }
      }
    }
  ],
  "enforcement": {
    "ladder": [
      { "threshold": 10, "action": "log" },
      { "threshold": 30, "action": "warn" },
      { "threshold": 50, "action": "pause" },
      { "threshold": 100, "action": "kill" }
    ]
  }
}
```

### Tripwires

Honeytoken definitions in `tripwires/default.tripwires.json`:

```json
{
  "tripwires": [
    { "id": "tw-1", "type": "file", "target": "/etc/shadow", "severity": "critical" },
    { "id": "tw-2", "type": "secret", "target": "FAKE_API_KEY_12345", "severity": "critical" },
    { "id": "tw-3", "type": "url", "target": "https://canary.internal/token", "severity": "warning" }
  ]
}
```

When triggered, the system automatically quarantines the session and node, creates evidence, and logs to audit.

---

## Deployment Guide

### Development (Local)

```bash
git clone https://github.com/alokemajumder/clawcc.git
cd clawcc
cp config/clawcc.config.example.json clawcc.config.json
node control-plane/server.js
```

### Production (Single Server)

#### 1. Prepare the server

```bash
# Create a dedicated user
sudo useradd -m -s /bin/bash clawcc
sudo su - clawcc

# Clone the repository
git clone https://github.com/alokemajumder/clawcc.git
cd clawcc

# Create and edit config
cp config/clawcc.config.example.json clawcc.config.json
```

#### 2. Generate secrets

```bash
# Generate session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate Ed25519 key pair for receipt signing
node cli/clawcc.js keygen
```

#### 3. Configure for production

Edit `clawcc.config.json`:

```json
{
  "mode": "fleet",
  "host": "0.0.0.0",
  "port": 3400,
  "dataDir": "/var/lib/clawcc/data",
  "sessionSecret": "YOUR_GENERATED_SECRET_HERE",
  "auth": {
    "sessionTtlMs": 28800000,
    "lockoutAttempts": 3,
    "lockoutDurationMs": 1800000,
    "stepUpWindowMs": 180000,
    "defaultAdminPassword": "YOUR_STRONG_PASSWORD_HERE"
  },
  "security": {
    "rateLimitWindowMs": 60000,
    "rateLimitMaxRequests": 200,
    "requestTimeoutMs": 30000,
    "corsOrigins": []
  },
  "events": {
    "retentionDays": 365
  }
}
```

#### 4. Create systemd service

```ini
# /etc/systemd/system/clawcc.service
[Unit]
Description=ClawCC Fleet Control Center
After=network.target

[Service]
Type=simple
User=clawcc
Group=clawcc
WorkingDirectory=/home/clawcc/clawcc
ExecStart=/usr/bin/node control-plane/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/clawcc/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable clawcc
sudo systemctl start clawcc
sudo systemctl status clawcc
```

#### 5. Set up a reverse proxy (nginx)

```nginx
# /etc/nginx/sites-available/clawcc
server {
    listen 443 ssl http2;
    server_name clawcc.example.com;

    ssl_certificate /etc/letsencrypt/live/clawcc.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/clawcc.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3400;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }

    # Health check (unauthenticated)
    location /healthz {
        proxy_pass http://127.0.0.1:3400/healthz;
    }
}
```

### Production (Docker)

```dockerfile
# Dockerfile
FROM node:20-slim
WORKDIR /app
COPY . .
RUN mkdir -p /data
EXPOSE 3400
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "require('http').get('http://localhost:3400/healthz', r => { process.exit(r.statusCode === 200 ? 0 : 1) })"
CMD ["node", "control-plane/server.js"]
```

```yaml
# docker-compose.yml
services:
  clawcc:
    build: .
    ports:
      - "3400:3400"
    volumes:
      - clawcc-data:/data
      - ./clawcc.config.json:/app/clawcc.config.json:ro
    restart: always
    environment:
      - NODE_ENV=production

volumes:
  clawcc-data:
```

```bash
docker compose up -d
```

### Production (Tailscale Mesh)

For multi-node deployments, Tailscale provides encrypted mesh networking without opening ports:

```bash
# On the control plane server
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# On each agent node
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Configure agents to connect via Tailscale IP:

```json
{
  "controlPlaneUrl": "http://100.x.y.z:3400"
}
```

### Health Check

The `/healthz` endpoint is unauthenticated for use with load balancers, Kubernetes probes, and monitoring:

```bash
curl http://localhost:3400/healthz
# {"status":"ok","uptime":123.456}
```

---

## API Reference

All API endpoints require authentication via session cookie (`clawcc_session`) unless noted otherwise. Request and response bodies are JSON.

### Authentication

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|:---:|
| POST | `/api/auth/login` | Login with username/password (rate-limited: 10/min/IP) | No |
| POST | `/api/auth/logout` | End session | Yes |
| GET | `/api/auth/me` | Get current user info | Yes |
| POST | `/api/auth/change-password` | Change password | Yes |
| POST | `/api/auth/mfa/setup` | Generate MFA secret and QR URI | Yes |
| POST | `/api/auth/mfa/verify` | Verify MFA code during login (upgrades pending session) | Yes |
| POST | `/api/auth/mfa/enable` | Enable MFA with verification code | Yes |
| POST | `/api/auth/step-up` | Re-verify MFA for high-risk operations | Yes |

**Login flow:** When MFA is enabled, login creates a short-lived (5 min) pending session that only has access to the MFA verify endpoint. After successful MFA verification, the session is upgraded to a full session with the user's normal TTL.

**Login example:**

```bash
# Login
curl -c cookies.txt -X POST http://localhost:3400/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"changeme"}'

# Use session cookie for subsequent requests
curl -b cookies.txt http://localhost:3400/api/auth/me
```

### Fleet Management

| Method | Endpoint | Description | Permission |
|--------|----------|-------------|------------|
| POST | `/api/fleet/register` | Register a node | HMAC-signed |
| POST | `/api/fleet/heartbeat` | Node heartbeat | HMAC-signed |
| GET | `/api/fleet/nodes` | List all nodes | read |
| GET | `/api/fleet/nodes/:nodeId` | Get node details | read |
| GET | `/api/fleet/nodes/:nodeId/sessions` | Get node's sessions | read |
| GET | `/api/fleet/nodes/:nodeId/blast-radius` | Get node blast radius | read |
| POST | `/api/fleet/nodes/:nodeId/action` | Queue action for node | action |
| DELETE | `/api/fleet/nodes/:nodeId` | Remove a node | admin |
| GET | `/api/fleet/topology` | Get fleet topology graph | read |

### Events & Sessions

| Method | Endpoint | Description | Permission |
|--------|----------|-------------|------------|
| POST | `/api/events/ingest` | Ingest a new event | HMAC-signed or session |
| GET | `/api/events/stream` | SSE real-time event stream | read |
| GET | `/api/events/query` | Query events with filters | read |
| GET | `/api/events/heatmap` | 30-day activity heatmap | read |
| GET | `/api/events/causality` | Trace file/tool references | read |
| GET | `/api/events/streak` | Activity streak stats | read |
| GET | `/api/sessions` | List all sessions | read |
| GET | `/api/sessions/:id` | Get session events | read |
| GET | `/api/sessions/:id/timeline` | Get session timeline | read |
| GET | `/api/sessions/:id/receipt` | Get session receipt | read |
| GET | `/api/sessions/:id/blast-radius` | Get session blast radius | read |
| GET | `/api/sessions/:id/replay` | Get session replay data | read |
| POST | `/api/sessions/:id/compare` | Compare two sessions | read |

**Event query parameters:** `from`, `to`, `nodeId`, `sessionId`, `type`, `severity`, `limit`, `offset`

**SSE stream parameters:** `nodeId`, `sessionId`, `type`, `severity`

### Operations

| Method | Endpoint | Description | Permission |
|--------|----------|-------------|------------|
| GET | `/api/ops/health` | System health (CPU, RAM, uptime) | read |
| GET | `/api/ops/health/history` | Health history (1 hour at 5s intervals) | read |
| GET | `/api/ops/usage` | Usage statistics | read |
| GET | `/api/ops/usage/breakdown` | Usage breakdown by provider | read |
| GET | `/api/ops/usage/alerts` | Current usage alerts | read |
| GET | `/api/ops/usage/rolling` | Rolling usage window (`?window=1h\|24h\|7d`) | read |
| GET | `/api/ops/memory` | Agent memory files | read |
| GET | `/api/ops/workspace/files` | List workspace files | read |
| GET | `/api/ops/workspace/file` | Read a workspace file | read |
| PUT | `/api/ops/workspace/file` | Write a workspace file | action |
| GET | `/api/ops/git` | Git status and recent commits | read |
| GET | `/api/ops/cron` | List cron jobs | read |
| GET | `/api/ops/cron/history` | Cron run history | read |
| POST | `/api/ops/cron/:jobId/run` | Trigger a cron job | action |
| POST | `/api/ops/cron/:jobId/toggle` | Toggle a cron job | action |
| GET | `/api/ops/logs` | Read log files | read |
| GET | `/api/ops/tailscale` | Tailscale network status | read |
| POST | `/api/ops/notifications/subscribe` | Subscribe to push notifications | read |
| POST | `/api/ops/notifications/test` | Send test notification | read |

### Governance

| Method | Endpoint | Description | Permission |
|--------|----------|-------------|------------|
| GET | `/api/governance/policies` | List all policies | read |
| GET | `/api/governance/policies/:id` | Get a policy | read |
| PUT | `/api/governance/policies/:id` | Update a policy | admin + step-up |
| POST | `/api/governance/policies/simulate` | Simulate policy on session | read |
| POST | `/api/governance/approvals` | Create approval request | read |
| GET | `/api/governance/approvals` | List pending approvals | read |
| GET | `/api/governance/approvals/:id` | Get approval details | read |
| POST | `/api/governance/approvals/:id/grant` | Grant approval (self-approve prevented) | action |
| POST | `/api/governance/approvals/:id/deny` | Deny approval | read |
| GET | `/api/governance/tripwires` | List tripwire definitions | read |
| PUT | `/api/governance/tripwires` | Update tripwires | admin + step-up |
| GET | `/api/governance/tripwires/triggers` | List tripwire triggers | read |
| GET | `/api/governance/audit` | Query audit log | audit |
| POST | `/api/governance/evidence/export` | Export evidence bundle (ZIP) | audit |
| POST | `/api/governance/evidence/verify` | Verify evidence bundle | read |
| GET | `/api/governance/skills` | List skills registry | read |
| POST | `/api/governance/skills/:id/deploy` | Deploy a skill (Ed25519 verified) | admin + step-up |
| POST | `/api/governance/skills/:id/rollback` | Rollback a skill | admin |
| GET | `/api/governance/access-review` | List users for access review | audit |
| GET | `/api/governance/receipts/verify` | Verify receipt chain | read |

### Kill Switch

| Method | Endpoint | Description | Permission |
|--------|----------|-------------|------------|
| POST | `/api/kill/session/:sessionId` | Kill a session | admin + step-up |
| POST | `/api/kill/node/:nodeId` | Kill a node | admin + step-up |
| POST | `/api/kill/global` | Global kill switch | admin + step-up |

### Health Check (Unauthenticated)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/healthz` | Health probe for load balancers |
| GET | `/api/healthz` | Health probe (alternate path) |

---

## CLI Reference

The CLI provides 18 commands for interacting with the control plane from the terminal.

### Setup

```bash
# Initialize CLI configuration and generate keys
node cli/clawcc.js init

# Generate Ed25519 key pair
node cli/clawcc.js keygen
```

### Commands

```bash
# Fleet overview
node cli/clawcc.js status [--host URL]

# List registered nodes
node cli/clawcc.js nodes [--host URL] [--format table|json]

# List sessions
node cli/clawcc.js sessions [--host URL] [--format table|json]

# Live event feed (SSE stream)
node cli/clawcc.js feed [--host URL]

# List governance policies
node cli/clawcc.js policies [--host URL] [--format table|json]

# Apply a policy from file
node cli/clawcc.js policy-apply --file policy.json [--host URL]

# Simulate policy on a session
node cli/clawcc.js policy-simulate --session SESSION_ID [--host URL]

# Kill a session (requires admin + step-up MFA)
node cli/clawcc.js kill-session --id SESSION_ID [--host URL]

# Kill a node
node cli/clawcc.js kill-node --id NODE_ID [--host URL]

# Global kill switch
node cli/clawcc.js kill-global [--host URL]

# Verify receipt chain / evidence bundle integrity
node cli/clawcc.js verify <evidence-bundle.json>

# Export evidence bundle
node cli/clawcc.js export [--session SESSION_ID] [--host URL]

# List users
node cli/clawcc.js users [--host URL] [--format table|json]

# Create a user
node cli/clawcc.js user-create [--host URL]

# Access review
node cli/clawcc.js access-review [--host URL]

# Verify receipts for a date
node cli/clawcc.js receipts-verify [--date YYYY-MM-DD] [--host URL]

# Enroll this machine as a node
node cli/clawcc.js enroll [--host URL]
```

### CLI Configuration

The CLI reads configuration from `~/.clawcc/config.json`:

```json
{
  "host": "http://localhost:3400",
  "format": "table"
}
```

Override with `--host` and `--format` flags on any command.

---

## UI Dashboard

The web UI is a single-page application (SPA) served at the root URL with a glassmorphic dark theme. No build step required -- it's plain HTML/CSS/JS.

### Pages

| Key | Page | Description |
|-----|------|-------------|
| 1 | **Fleet** | Node management, topology graph, blast radius, node actions |
| 2 | **Sessions** | Session list with drill-down, timeline, blast radius, drift analysis, compare, replay |
| 3 | **Live Feed** | Real-time event stream with filters, activity heatmap, streak badge |
| 4 | **Usage** | Provider/model cost tracking, rolling windows, usage alerts |
| 5 | **Memory & Files** | Agent memory viewer, workspace file browser with diff-before-save |
| 6 | **Ops** | System health, cron, logs, git status, Tailscale |
| 7 | **Governance** | Policies, tripwires, approvals, skills, audit log, evidence export |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1`-`7` | Navigate to page |
| `/` | Focus search |
| `Space` | Pause/resume live feed |
| `Esc` | Close modal/panel |
| `?` | Toggle keyboard help |
| `k` | Kill switch modal (admin only) |

---

## Mobile Ops (Pocket PWA)

The Pocket PWA is a mobile-optimized interface at `/pocket/`:

- Live event feed with severity filtering
- Alert notifications (push notification support via service worker)
- Emergency kill switch with step-up MFA
- Offline caching via service worker
- Installable as a home screen app

### Android (Termux) Deployment

For running ClawCC directly on an Android device:

```bash
# In Termux
pkg install nodejs git
git clone https://github.com/alokemajumder/clawcc.git
cd clawcc/termux
bash setup.sh
```

See `termux/README.md` for details.

---

## Node Agent

The node agent runs on each machine you want to monitor and manages:

- **Registration**: Enrolls with the control plane on startup via HMAC-signed request
- **Heartbeat**: Sends periodic health data (CPU, RAM, disk)
- **Telemetry**: Discovers and reports sessions, memory files, git activity
- **Sandbox**: Executes typed safe actions within allowlist constraints (uses `execFileSync`, not shell)
- **Offline Spool**: Queues events locally when the control plane is unreachable (100MB size limit, atomic writes)

### Agent Security

- All requests to the control plane are HMAC-signed with nonce replay prevention
- No shell commands are exposed -- only typed safe actions via allowlists
- Path access is sandboxed with symlink resolution and traversal prevention
- Discovery redacts secrets and strips credentials from git URLs
- Offline events are spooled to disk with atomic writes and replayed when connectivity returns

---

## Security

ClawCC is designed to be secure by default. See [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) for the full threat model and control details.

### Security Summary

| Layer | Controls |
|-------|----------|
| **Authentication** | PBKDF2 (100K iterations, SHA-512), TOTP MFA with recovery codes, MFA-pending session lifecycle, session cookies (HttpOnly, SameSite=Lax, Secure) |
| **Authorization** | RBAC (viewer/operator/auditor/admin), ABAC conditions, step-up auth, 4-eyes approval with self-approve prevention |
| **Network** | Tailscale WireGuard, HMAC request signing, nonce replay prevention, CORS (configurable origins), optional TLS |
| **Input** | Body size limits (1MB), event payload limits (64KB), type validation, ReDoS-safe regex (200 char limit, dangerous pattern detection) |
| **Output** | Secret redaction, CSP nonces (per-request), security headers (HSTS, X-Frame-Options, X-Content-Type-Options, Permissions-Policy) |
| **Data** | Append-only JSONL, SHA-256 hash chains, Ed25519 signatures, serialized async write queue with backpressure logging |
| **Runtime** | Rate limiting (100 req/min general, 10/min auth), request timeouts (30s), graceful shutdown, uncaught exception handlers |
| **Sandbox** | Command allowlists with argument constraints, path allowlists, symlink resolution, `execFileSync` (no shell), traversal prevention |
| **Memory** | In-memory event cap (500K), session eviction (50K cap, 30-day expiry), rate limit map eviction (10K IPs), regex cache cap (1K) |

### Changing the Admin Password

```bash
# Via API
curl -b cookies.txt -X POST http://localhost:3400/api/auth/change-password \
  -H "Content-Type: application/json" \
  -d '{"oldPassword":"changeme","newPassword":"your-secure-password-here"}'
```

### Setting Up MFA

```bash
# Get MFA secret and QR URI
curl -b cookies.txt -X POST http://localhost:3400/api/auth/mfa/setup

# Enable MFA with code from authenticator app
curl -b cookies.txt -X POST http://localhost:3400/api/auth/mfa/enable \
  -H "Content-Type: application/json" \
  -d '{"code":"123456"}'
```

### RBAC Roles

| Role | Permissions | Use Case |
|------|------------|----------|
| `viewer` | `read` | Dashboard monitoring |
| `operator` | `read`, `action` | Day-to-day operations |
| `auditor` | `read`, `audit` | Compliance auditing, evidence export |
| `admin` | `read`, `action`, `admin`, `audit` | Full system administration |

---

## Governance & Compliance

ClawCC provides built-in compliance controls mapped to SOC 2, ISO 27001, and NIST CSF. See [COMPLIANCE_PACK.md](COMPLIANCE_PACK.md) for detailed control mappings.

### Evidence Export

Export signed evidence bundles for audit purposes:

```bash
# Export all evidence as ZIP
curl -b cookies.txt -X POST http://localhost:3400/api/governance/evidence/export \
  -H "Content-Type: application/json" \
  -d '{"from":"2026-01-01","to":"2026-03-01"}' \
  -o evidence-bundle.zip

# Export for a specific session
curl -b cookies.txt -X POST http://localhost:3400/api/governance/evidence/export \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"sess-123","format":"json"}'
```

### Verify Receipt Chain

```bash
# Via API
curl -b cookies.txt "http://localhost:3400/api/governance/receipts/verify?date=2026-03-01"

# Via CLI
node cli/clawcc.js verify evidence-bundle.json
```

---

## Dependencies

ClawCC has **zero runtime dependencies**. No npm packages are used. Everything runs on the Node.js standard library.

### Required

| Dependency | Version | Notes |
|------------|---------|-------|
| **Node.js** | >= 18.0.0 | Uses `node:crypto`, `node:fs`, `node:http`, `node:os`, `node:path`, `node:url`, `node:child_process`, `node:test`, `node:assert` |

### Optional (Infrastructure)

| Tool | Purpose | When Needed |
|------|---------|-------------|
| **Tailscale** | Encrypted mesh networking between control plane and agents | Multi-node fleet deployments |
| **nginx / Caddy** | Reverse proxy with TLS termination | Production deployments requiring HTTPS |
| **Let's Encrypt / certbot** | Free TLS certificates | When using HTTPS directly or via reverse proxy |
| **systemd** | Process management, auto-restart | Linux production servers |
| **Docker** | Container deployment | Containerized environments |
| **pm2** | Node.js process manager | Alternative to systemd |
| **Git** | Reads `git log` / `git status` on the ops workspace page | Ops workspace features |

### No External APIs Required

ClawCC does not call any external APIs, cloud services, or SaaS platforms. It is fully self-contained and air-gappable:

- No analytics or telemetry sent anywhere
- No license server or activation check
- No package registry calls at runtime
- No external authentication providers (built-in auth only)
- All cryptography uses Node.js `node:crypto` (OpenSSL under the hood)

---

## Testing

Run the full test suite:

```bash
# Run all unit tests (10 suites)
npm test

# Run E2E smoke tests (starts a real server)
node test/e2e-smoke.js

# Run a specific suite
node --test test/auth/auth.test.js
```

234 tests across 11 suites, all passing:

| Suite | Tests | Covers |
|-------|-------|--------|
| Crypto | 27 | PBKDF2, TOTP, HMAC, Ed25519, hash chains, nonces, recovery codes |
| Auth | 34 | User CRUD, login, lockout, sessions, RBAC, MFA, MFA-pending, password change |
| Sandbox | 18 | Allowlists, path traversal, symlink resolution, argument validation |
| Policy | 41 | Rule evaluation, drift scoring, enforcement, simulation, ABAC conditions, ReDoS protection |
| Receipts | 12 | Hash chains, Ed25519 signing, bundle verification |
| Events | 23 | Ingestion, redaction, size limits, subscriptions, queries, async writes |
| Intent | 24 | Intent contracts, drift scoring (5 factors), session ID validation, path traversal prevention |
| Middleware | 11 | Session authentication, MFA-pending blocking, node signature verification, nonce replay |
| Router | 21 | Route matching, params, query parsing, cookie parsing, setCookie |
| ZIP | 11 | ZIP format, CRC-32, file entries, validation |
| E2E Smoke | 12 | Server startup, auth flow, security headers, static files, health endpoint, 404 handling |

Tests use `node:test` and `node:assert/strict` -- no external test frameworks.

---

## Troubleshooting

### Server won't start

```bash
# Check Node.js version (must be >= 18)
node --version

# Check if port is in use
lsof -i :3400

# Run with debug output
node control-plane/server.js 2>&1 | head -50

# Check config is valid JSON
node -e "JSON.parse(require('fs').readFileSync('clawcc.config.json','utf8'))"
```

### Agent can't connect to control plane

```bash
# Test connectivity
curl http://CONTROL_PLANE_IP:3400/healthz

# Verify shared secret matches
# The nodeSecret in agent config must match the sessionSecret in control plane config
# (or match the per-node secret in fleet.nodeSecrets)
```

### MFA not working

- Ensure your device clock is synchronized (TOTP is time-based, 30-second window with +/-1 step tolerance)
- Recovery codes from MFA setup can be used as one-time codes (timing-safe verified)
- Admin can reset MFA for a user via the API

### High memory usage

- The in-memory index caps at 500K events (oldest evicted, persisted on disk)
- Sessions capped at 50K in-memory (ended sessions older than 30 days evicted)
- Rate limit maps evict expired entries above 10K IPs
- Restart the server to rebuild indexes from disk

### Events not appearing in UI

```bash
# Check if events are being ingested
curl -b cookies.txt "http://localhost:3400/api/events/query?limit=5"

# Check SSE stream is working
curl -N -b cookies.txt http://localhost:3400/api/events/stream
```

### Default password rejected in production

When `mode` is set to `"production"`, the server refuses to start if the admin password is still `"changeme"`. Set `auth.defaultAdminPassword` to a strong password in your config.

---

## Project Structure

```
clawcc/
  control-plane/
    server.js                 HTTP server, module initialization, CORS, config validation
    lib/
      auth.js                 User management, sessions, RBAC, MFA, MFA-pending lifecycle
      audit.js                Append-only audit logging with hash chains
      crypto.js               PBKDF2, TOTP, HMAC, Ed25519, hash chains, recovery codes
      events.js               Event store with async write queue and backpressure logging
      index.js                Hybrid in-memory index layer (500K event cap)
      intent.js               Intent contracts and drift scoring (5 factors)
      policy.js               Policy engine with ABAC conditions, ReDoS-safe regex
      receipts.js             Receipt ledger with Ed25519 signing and JSONL persistence
      router.js               HTTP router with :param support, safe URI decoding
      snapshots.js            Session/usage/health/topology snapshots with eviction
      zip.js                  ZIP file builder (deflateRaw + CRC-32)
    middleware/
      auth-middleware.js       Session auth, MFA-pending blocking, step-up, node HMAC verification
      security.js              Security headers, CSP nonces, rate limiting, body parsing
    routes/
      auth-routes.js           Login, logout, MFA, password, step-up
      event-routes.js          Ingest, SSE stream, query, sessions, heatmap, replay
      fleet-routes.js          Node register, heartbeat, actions, topology
      governance-routes.js     Policies, approvals, tripwires, skills, audit, evidence
      kill-switch.js           Emergency kill switch (session/node/global)
      ops-routes.js            Health, usage, workspace, cron, logs, notifications
  node-agent/
    agent.js                  Node agent daemon
    lib/
      discovery.js             Session and workspace discovery with secret redaction
      sandbox.js               Command/path sandbox with allowlists, execFileSync
      spool.js                 Offline event spooling (100MB limit, atomic writes)
      telemetry.js             Health telemetry with execFileSync, bounded history
  ui/
    index.html                SPA entry point
    css/main.css              Glassmorphic dark theme
    js/
      api.js                   API client
      app.js                   SPA router, keyboard shortcuts, login, modals
      sse.js                   SSE client (connect, pause, resume, reconnect)
      pages.js                 Page renderers (7 pages)
  cli/
    clawcc.js                 CLI tool (18 commands)
  pocket/
    index.html                Mobile PWA
    sw.js                     Service worker (offline caching, push notifications)
    manifest.json             PWA manifest
  termux/
    setup.sh                  Android Termux setup script
    README.md                 Termux deployment guide
  config/
    clawcc.config.example.json     Control plane config template
    node-agent.config.example.json Node agent config template
  allowlists/
    commands.json             Allowed commands with argument constraints
    paths.json                Allowed/protected/forbidden paths
  policies/
    default.policy.json       Default governance policy rules
  tripwires/
    default.tripwires.json    Honeytoken definitions
  skills/
    registry.json             Skills registry with canary config
  scripts/
    generate-demo-data.js     Demo data generator (30 days, 3 nodes)
  test/
    run-all.js                Test runner (10 unit suites)
    auth/crypto.test.js       27 tests: PBKDF2, TOTP, HMAC, Ed25519, chains, nonces
    auth/auth.test.js         34 tests: users, sessions, RBAC, MFA, MFA-pending
    sandbox/sandbox.test.js   18 tests: allowlists, traversal, symlinks
    policy/policy.test.js     41 tests: rules, drift, enforcement, ABAC, ReDoS
    receipts/receipts.test.js 12 tests: chains, signing, bundles
    events/events.test.js     23 tests: ingest, redact, size, subscribe, query
    intent/intent.test.js     24 tests: contracts, drift, path traversal
    middleware/auth-middleware.test.js  11 tests: auth, MFA-pending, HMAC, nonce replay
    router/router.test.js     21 tests: routing, params, cookies, query
    zip/zip.test.js           11 tests: ZIP format, CRC-32, validation
    e2e-smoke.js              12 tests: server startup, auth, headers, static files
  SECURITY_ARCHITECTURE.md    Threat model and security controls
  COMPLIANCE_PACK.md          SOC 2 / ISO 27001 / NIST CSF mappings
  PROGRESS.md                 Development progress tracker
```

---

## Contributing

Contributions are welcome! ClawCC is built for the community and we appreciate every PR, issue, and suggestion.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes (no external dependencies allowed -- stdlib only)
4. Run tests: `npm test && node test/e2e-smoke.js`
5. Submit a pull request

**Ground rules:**
- Zero external dependencies. All code must use Node.js stdlib only.
- All new features need tests.
- Security issues: please report privately via GitHub Security Advisories rather than public issues.

---

## Star History

If ClawCC helps you manage your AI agent fleet, consider giving it a star. It helps others discover the project.

---

## License

MIT -- use it freely in personal and commercial projects.

---

<div align="center">

**Built with zero dependencies, maximum paranoia.**

[Report a Bug](https://github.com/alokemajumder/clawcc/issues) | [Request a Feature](https://github.com/alokemajumder/clawcc/issues) | [Security Policy](SECURITY_ARCHITECTURE.md)

</div>
