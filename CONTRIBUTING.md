# Contributing to ClawCC

Thank you for your interest in contributing to ClawCC. This document outlines the guidelines and procedures for contributing to the project.

## Ground Rules

1. **Zero external dependencies.** All code must use the Node.js standard library only. No npm packages. This requirement is non-negotiable.
2. **All new features require tests.** Use `node:test` and `node:assert/strict`.
3. **Security first.** Do not introduce vulnerabilities such as injection, XSS, or path traversal. If you discover a vulnerability, report it privately via [Security Advisories](https://github.com/alokemajumder/clawcc/security/advisories).

## Getting Started

```bash
# Clone and verify
git clone https://github.com/alokemajumder/clawcc.git
cd clawcc
node --version  # Must be >= 18.0.0

# Run tests
npm test                    # Unit tests (10 suites)
node test/e2e-smoke.js      # E2E smoke tests
npm run test:all            # Both

# Start the server
cp config/clawcc.config.example.json clawcc.config.json
npm start
```

No `npm install` is needed. There are no dependencies.

## Development Workflow

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally.
3. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
4. **Make your changes.** Keep commits focused and atomic.
5. **Add tests** for any new functionality.
6. **Run the full test suite** and confirm that all tests pass:
   ```bash
   npm run test:all
   ```
7. **Push** your branch and open a pull request against `main`.

## What to Contribute

| Type                    | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| Bug fixes               | Include a failing test and the corresponding fix              |
| Security improvements   | Harden existing controls or introduce new defensive measures  |
| Test coverage           | Add tests for untested code paths                             |
| Documentation           | Fix inaccuracies, improve clarity, or add examples            |
| Performance             | Optimize hot paths and include benchmarks showing improvement |
| New features            | Open an issue first to discuss the design                     |

## Code Style

- Begin every file with `'use strict';`.
- Use `const` by default, `let` when reassignment is necessary, and never `var`.
- Use the `node:` prefix for all standard library imports (e.g., `require('node:fs')`).
- Use factory functions (e.g., `createEventStore()`) instead of classes.
- Keep functions small and focused. Prefer pure functions where possible.
- Write descriptive, actionable error messages.
- Avoid `console.log` in library code except for startup messages and error logging.

## Testing Guidelines

- Place test files in `test/<module-name>/<module-name>.test.js`.
- Use `describe()` and `it()` from `node:test`.
- Use `assert` from `node:assert/strict`.
- Tests must be deterministic -- no reliance on timing, network, or external state.
- Use temporary directories (`os.tmpdir()`) for filesystem tests and clean up afterward.
- Test both success and failure paths.

## Commit Messages

- Use the imperative mood: "Add feature" not "Added feature."
- Keep the first line under 72 characters.
- Reference issue numbers where applicable: "Fix session leak (#42)."

## Pull Request Process

1. Ensure all tests pass (`npm run test:all`).
2. Update documentation if your change affects the API, configuration, or user-facing behavior.
3. Fill out the pull request template with a description of what changed and why.
4. A maintainer will review your pull request. Address any feedback promptly.
5. Once approved, a maintainer will merge your pull request.

## Reporting Bugs

Open an issue on GitHub with the following information:

- Steps to reproduce the bug
- Expected behavior
- Actual behavior
- Node.js version and operating system
- Relevant log output

## Reporting Security Vulnerabilities

**Do not** open a public issue for security vulnerabilities. Instead, use [GitHub Security Advisories](https://github.com/alokemajumder/clawcc/security/advisories) to report them privately. See [SECURITY.md](SECURITY.md) for the full policy.

## License

By contributing to ClawCC, you agree that your contributions will be licensed under the MIT License.
