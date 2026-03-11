# Changelog

All notable changes to ClawCC are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-09

### Added

#### Core Platform

- Control plane server with custom HTTP router, middleware pipeline, and static file serving.
- Append-only JSONL event store with daily rotation and async serialized write queue.
- Hybrid in-memory index layer rebuilt from JSONL on boot with O(1) lookups.
- SSE real-time event streaming with filters, keepalive, and max 1-hour lifetime.
- Session management with timeline, replay, blast radius, and side-by-side comparison.
- Interactive SVG topology graph with hover tooltips and click-to-detail.
- Activity heatmap (30-day) and streak tracking.
- Causality explorer for tracing file and tool references across sessions.
- Usage tracking with rolling windows (1h/24h/7d) and configurable alerts.
- Graceful shutdown with connection draining, snapshot flushing, and write queue completion.

#### Security

- PBKDF2 password hashing (100K iterations, SHA-512, 64-byte key).
- TOTP MFA (RFC 6238) with recovery codes and MFA-pending session lifecycle.
- HMAC-SHA256 request signing with nonce replay prevention and timestamp freshness.
- Ed25519 digital signatures for receipt chains and evidence bundles.
- RBAC (viewer/operator/auditor/admin) with ABAC conditions.
- Step-up authentication for high-risk operations.
- 4-eyes approval workflow with self-approve prevention.
- CSP nonces (per-request), security headers, rate limiting, and request timeouts.
- Automatic secret redaction in event payloads (key-name and Bearer token detection).
- Zero-trust action sandbox with command and path allowlists and symlink resolution.
- ReDoS protection with pattern length limits and dangerous construct detection.

#### Governance and Compliance

- Policy engine with rule evaluation, drift scoring (5 factors), and enforcement ladders.
- Intent contracts with session-level drift computation.
- Tripwires and honeytokens with auto-quarantine on trigger.
- Signed skills registry with Ed25519 verification and canary rollout.
- Tamper-evident receipt ledger with SHA-256 hash chains and daily Ed25519 root signing.
- Append-only audit logging with SHA-256 hash chains.
- Evidence export as ZIP bundles with Ed25519 signatures.
- Access review endpoint for compliance auditing.
- SOC 2, ISO 27001, and NIST CSF control mappings documented.

#### Clients

- Web UI: single-page application with glassmorphic dark theme and keyboard shortcuts.
- CLI: 18 commands for fleet management, policy simulation, and evidence export.
- Pocket PWA: mobile-optimized interface with push notifications and offline caching.
- Termux: Android deployment script and documentation.

#### Node Agent

- Daemon with HMAC-signed registration and heartbeats.
- Session and workspace discovery with secret redaction.
- Health telemetry (CPU, RAM, disk).
- Offline event spooling with replay on reconnect.
- Sandbox enforcement with command and path allowlists.

#### Infrastructure

- Zero external dependencies -- Node.js stdlib only.
- Tailscale mesh VPN integration for node discovery.
- 234 tests across 11 suites (10 unit + 1 E2E), all passing.
- Example configurations for control plane and node agent.
- Demo data generator (30 days, 3 nodes, 14 providers, ~225 sessions).

[0.1.0]: https://github.com/alokemajumder/clawcc/releases/tag/v0.1.0
