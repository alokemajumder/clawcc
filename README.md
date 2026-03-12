<div align="center">

# Fleet Control Center

### The control plane your AI agents are missing

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)](package.json)
[![Tests](https://img.shields.io/badge/tests-833%20passing-brightgreen?style=flat-square)](test/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

**Kill rogue agents. Enforce drift policies. Quarantine threats. Export compliance evidence.**
**Not a dashboard — a control plane that acts.**

[Quick Start](#quick-start) | [What It Does](#what-it-does) | [Security](#security-enforcement) | [Architecture](#architecture) | [Contributing](CONTRIBUTING.md)

</div>

---

## The Problem

You have 5 developers running Claude Code, Copilot, Cursor, and Codex across 12 machines. Last Tuesday, one agent modified production config files it shouldn't have touched. You found out two days later.

**FCC exists so that never happens again.**

It doesn't just show you what agents did — it **stops them**, **enforces policy**, **quarantines violations**, and **produces signed evidence** for your compliance team.

---

## What It Does

### Manage Any Agent, Any Fleet Size

FCC discovers and manages sessions from **any AI coding agent** — not just one vendor.

| | Agents |
|-|--------|
| **Major** | Claude Code, Codex CLI, GitHub Copilot, Cursor, Windsurf, Gemini Code Assist, Augment, Kiro, Amazon Q, Tabnine |
| **Open Source** | Continue, OpenHands, Tabby, Goose, OpenCode, Cline, Aider |
| **Custom** | Any agent via `discoveryPaths` — no vendor lock-in |

Each agent gets: heartbeat monitoring, stale detection, SOUL files (markdown personality definitions), event timeline, drift scoring, and fleet-wide scorecards.

### Enforce Policy — Not Just Observe

Most agent tools are dashboards. FCC is a **policy enforcement engine** with teeth:

| Trigger | FCC Action |
|---------|------------|
| Agent touches files outside allowed paths | **Blocked** by zero-trust sandbox |
| Drift score exceeds threshold | **Escalation ladder**: warn → require approval → throttle → quarantine → kill |
| Honeytoken file accessed | **Auto-quarantine** + evidence bundle generated |
| Agent tries disallowed command | **Rejected** — typed safe actions only, no remote shell |
| High-risk operation requested | **4-eyes approval** required, step-up MFA enforced |
| Security profile violated | **Blocked or alerted** per minimal/standard/strict profile |

### Kill Switch — Session, Node, or Global

```bash
# Kill a single session
node cli/clawcc.js kill session <sessionId>

# Kill all agents on a node
node cli/clawcc.js kill node <nodeId>

# Kill everything, everywhere, now
node cli/clawcc.js kill global
```

Every kill generates a signed evidence bundle. Requires admin + step-up MFA. Cannot be triggered by accident.

### Compliance That Auditors Accept

FCC doesn't just log — it produces **machine-verifiable, tamper-evident evidence**:

- **Append-only JSONL** — Events cannot be retroactively modified
- **SHA-256 hash chains** — Each event references the previous hash; tampering breaks the chain
- **Ed25519 signed receipts** — Daily root signatures prove chain integrity
- **Evidence export** — ZIP bundles with events, audit logs, receipts, and integrity hashes
- **Secret redaction** — Automatic removal of passwords, tokens, and keys from event payloads
- **Control mappings** — SOC 2, ISO 27001, NIST CSF ([COMPLIANCE_PACK.md](COMPLIANCE_PACK.md))

### Multi-Agent Coordination

| Feature | What It Does |
|---------|-------------|
| **Channels** | Broadcast, direct, and group messaging between agents with SSE |
| **Kanban Tasks** | Assign work to agents with enforced status transitions |
| **Skills Hub** | Browse, install, security-scan, and quarantine agent skills |
| **SOUL Files** | Define agent personality and behavior in markdown |
| **Evaluations** | 4-layer scoring (output, trace, component, drift) with quality gates |
| **Scheduler** | Natural language ("every weekday at 9am") → cron jobs that spawn tasks |
| **Projects** | Group agents and sessions by project with assignment tracking |

### Gateway Federation

Run FCC across multiple teams or environments. Gateway mode proxies and aggregates:

```
Team A (FCC) ──┐
Team B (FCC) ──┼── Gateway FCC ── Unified fleet view
Team C (FCC) ──┘
```

Health checks, circuit breakers, HMAC-signed upstream communication.

---

## Quick Start

```bash
git clone https://github.com/alokemajumder/FleetControlCenter.git
cd FleetControlCenter
node control-plane/server.js
```

Open [http://localhost:3400](http://localhost:3400). Login: `admin` / `changeme`.

No `npm install`. No build step. No Docker required. **Zero dependencies.**

```bash
# Or with Docker
docker compose up -d

# Or on Android
bash termux/setup.sh
```

### Enroll an Agent Node

```bash
# On each machine running AI agents:
cp config/node-agent.config.example.json node-agent.config.json
# Set controlPlaneUrl and sharedSecret
node node-agent/agent.js
```

The agent daemon discovers sessions, signs requests with HMAC, spools events offline, and auto-reconnects.

---

## Security Enforcement

FCC is not "security-aware" — it **enforces security by default**. See [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) for the full threat model.

| Layer | What FCC Does |
|-------|--------------|
| **Identity** | PBKDF2 (100K iterations, SHA-512), TOTP MFA, recovery codes, API keys (SHA-256 hashed) |
| **Authorization** | 4-role RBAC + ABAC conditions (environment, time window, risk score, node tags) |
| **Agent Sandbox** | Command + path allowlists, symlink resolution, traversal prevention, no remote shell |
| **Policy Engine** | Rule evaluation with drift scoring, enforcement ladders, and simulation lab |
| **Secrets** | 14+ scanner patterns (AWS, GitHub, Stripe, JWT, PEM), auto-redaction in events |
| **Transport** | HMAC-SHA256 request signing, nonce replay prevention, timing-safe comparison |
| **Audit** | Append-only, hash-chained, Ed25519-signed — every action, every actor, every reason |
| **Headers** | CSP nonces, HSTS, X-Frame-Options, rate limiting, 1MB body limit, ReDoS protection |

### Security Profiles

Three built-in enforcement levels:

| Profile | Auth failures | File access violations | Policy violations |
|---------|--------------|----------------------|-------------------|
| **Minimal** | Log | Log | Log |
| **Standard** | Alert | Alert + audit | Block |
| **Strict** | Block + lockout | Block + quarantine | Block + kill |

Custom profiles supported. Switch profiles per-environment without code changes.

---

## Architecture

```
┌──────────┐  ┌──────────┐  ┌──────────┐
│  Web UI  │  │   CLI    │  │  Mobile  │
│ 21 pages │  │ 18 cmds  │  │   PWA    │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     └──────┬──────┴──────────────┘
            │ HTTP / SSE
   ┌────────┴────────┐
   │  Control Plane  │──── 31 modules, 24 route files
   └────────┬────────┘
            │
  ┌─────────┼─────────┐
  │         │         │
┌─┴──┐  ┌──┴──┐  ┌──┴──────┐
│JSONL│  │SQLite│  │Node     │
│Store│  │Accel.│  │Agent    │
│    │  │(opt.)│  │Daemon(s)│
└────┘  └─────┘  └─────────┘
```

- **Data**: Append-only JSONL (source of truth) + optional SQLite acceleration (Node.js 22+)
- **Crypto**: PBKDF2 + TOTP + HMAC-SHA256 + Ed25519 + SHA-256 chains — all `node:crypto`
- **Dependencies**: Zero. The entire stack — server, agent, UI, CLI, PWA — is pure Node.js stdlib

---

## Zero Dependencies

```
$ ls node_modules
ls: node_modules: No such file or directory
```

No npm packages. No supply-chain risk. No CVEs from transitive deps. Air-gap deployable. **One person can audit the entire codebase.**

---

## Testing

833 tests. 31 suites. Zero external test frameworks.

```bash
node test/run-all.js          # Unit tests
node test/e2e-smoke.js        # Integration tests
```

Covers: auth, crypto, sandbox, policy, events, intent, gateway, agents, channels, webhooks, scheduler, evaluations, skills, security profiles, secret scanner, knowledge graph, tenants, projects, config, doctor, updater, tasks, and more.

---

## Configuration

```bash
cp config/clawcc.config.example.json clawcc.config.json
node control-plane/server.js
```

```jsonc
{
  "port": 3400,
  "mode": "local",                          // or "fleet"
  "auth": {
    "defaultAdminPassword": "changeme",     // CHANGE THIS
    "sessionSecret": "generate-32-bytes"
  },
  "gateway": { "enabled": false },          // Multi-fleet federation
  "multiTenant": { "enabled": false }       // Tenant isolation
}
```

---

## Production Checklist

- [ ] Change the default admin password
- [ ] Generate a strong session secret (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- [ ] Use HTTPS (directly or via reverse proxy)
- [ ] Restrict CORS origins
- [ ] Enable MFA for all admin accounts
- [ ] Set security profile to `standard` or `strict`
- [ ] Consider Tailscale for node-to-control-plane encryption

---

## CLI

```bash
node cli/clawcc.js status              # Fleet overview
node cli/clawcc.js sessions            # List sessions across fleet
node cli/clawcc.js drift <sessionId>   # Check intent drift score
node cli/clawcc.js kill <target>       # Emergency kill (session/node/global)
node cli/clawcc.js evidence <session>  # Export signed evidence ZIP
node cli/clawcc.js keygen              # Generate Ed25519 key pair
node cli/clawcc.js verify-receipts     # Verify receipt chain integrity
```

---

## Roadmap

- [ ] Egress URL allowlisting
- [ ] Exportable session replay packs
- [ ] Grafana/Prometheus metrics bridge
- [ ] Plugin system for custom enforcement actions

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run tests before submitting:

```bash
node test/run-all.js && node test/e2e-smoke.js
```

---

## License

[MIT](LICENSE)

---

<div align="center">

**Built for teams who run AI agents in production and refuse to fly blind.**

[Report Bug](https://github.com/alokemajumder/FleetControlCenter/issues) | [Request Feature](https://github.com/alokemajumder/FleetControlCenter/issues) | [Security Advisory](https://github.com/alokemajumder/FleetControlCenter/security/advisories)

</div>
