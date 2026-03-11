# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in ClawCC, **do not open a public issue.** Security vulnerabilities must be reported privately to allow time for a fix before public disclosure.

### How to Report

Use [GitHub Security Advisories](https://github.com/alokemajumder/clawcc/security/advisories) to submit a private report. Include the following:

1. **Description** -- A clear explanation of the vulnerability.
2. **Steps to reproduce** -- Detailed instructions to replicate the issue.
3. **Impact assessment** -- What an attacker could achieve by exploiting it.
4. **Affected versions** -- Specific versions, or "all" if unknown.
5. **Suggested fix** -- If you have a proposed remediation.

### Response Timeline

| Step                          | Timeframe                |
| ----------------------------- | ------------------------ |
| Acknowledgment of report      | Within 48 hours          |
| Initial assessment            | Within 5 business days   |
| Fix development and testing   | Depends on severity      |
| Security advisory published   | At time of fix release   |

### Severity Classification

| Severity | Description                                       | Examples                                |
| -------- | ------------------------------------------------- | --------------------------------------- |
| Critical | Remote code execution, authentication bypass, data exfiltration | Command injection, session fixation |
| High     | Privilege escalation, significant data exposure   | RBAC bypass, audit log tampering        |
| Medium   | Limited impact requiring specific conditions      | CSRF, information disclosure            |
| Low      | Minimal impact, defense-in-depth improvements     | Missing headers, verbose errors         |

## Supported Versions

| Version           | Supported |
| ----------------- | --------- |
| 0.1.x (current)   | Yes       |

## Security Architecture

For a comprehensive overview of ClawCC's security controls, threat model, and defense-in-depth design, see [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md).

Key security features include:

- PBKDF2 password hashing (100K iterations, SHA-512)
- TOTP multi-factor authentication with recovery codes
- HMAC-SHA256 request signing with nonce replay prevention
- Ed25519 digital signatures for receipt chains
- Append-only audit logging with SHA-256 hash chains
- Automatic secret redaction in event payloads
- CSP nonces, rate limiting, and input validation
- Zero external dependencies (no supply chain risk)

## Security-Related Configuration

When deploying ClawCC, ensure the following:

1. **Change the default admin password.** The server refuses to start in production mode with the default credentials.
2. **Generate a strong session secret:**
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. **Use HTTPS** -- either directly or via a reverse proxy (nginx, Caddy).
4. **Restrict CORS origins** -- set `security.corsOrigins` to your specific domain(s).
5. **Use Tailscale** -- for encrypted node-to-control-plane communication.
6. **Enable MFA** -- for all admin and operator accounts.

## Acknowledgments

We value the work of the security research community. Reporters will be acknowledged in security advisories unless they prefer to remain anonymous.
