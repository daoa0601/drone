# Drone quality gates

Drone pins pnpm and external JavaScript dependencies exactly. It consumes the private local
`@agentic-orch/ts-quality` module for formatting, lint configuration, secret scanning, package
inspection, and managed hooks. Drone still owns its coverage floors, Swift gates, package allowlist,
and sandbox-specific tests.

| Command                | Scope                                                                        |
| ---------------------- | ---------------------------------------------------------------------------- |
| `pnpm quality:quick`   | Formatting, warning-free lint, strict TypeScript, and secret scan.           |
| `pnpm check`           | Quick gates plus deterministic tests.                                        |
| `pnpm quality:offline` | Coverage, production build, and package-boundary inspection.                 |
| `pnpm native:check`    | Swift formatting, contract tests, and pinned Containerization build.         |
| `pnpm deps:check`      | Production advisory and registry-signature checks for external dependencies. |
| `pnpm preflight`       | Complete TypeScript and dependency gate.                                     |

Native validation requires macOS 26/Xcode 26 and may download Swift dependencies on its first run.
Tests must use fake providers and must never pull an OCI image, start an Apple container, execute a
submitted artifact, or require a provisioned sandbox.

The TypeScript suite includes signed-measurement substitution, trust-key, expiry, job-challenge, and
private-key-permission failures. Swift contract tests cover the attestation/challenge fields and the
fixed no-network request. A real VM boot remains an explicit operator smoke test because it requires
separately provisioned runtime assets and OCI images.

## Local sibling contract

`@agentic-orch/node-guardrails` and `@agentic-orch/ts-quality` are `workspace:*` dependencies. The
lock resolves them to `../node-guardrails` and `../ts-quality`; every frozen install requires those
siblings. This is the intended local topology, not a temporary publication stage.

The checked-in GitHub workflow cannot reproduce that topology by checking out Drone alone. Until the
repositories are consolidated or the sibling sources receive immutable remotes, use the local frozen
install and gates as the coordinated validation path.

The shared scanner bounds reads, never follows symlinks, and reports only escaped file/line
metadata. `pnpm hooks:install` installs managed hooks without replacing an unmanaged hook or
silently changing `core.hooksPath`.
