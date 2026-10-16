# Drone quality gates

Drone pins pnpm and external JavaScript dependencies exactly. It uses the sibling
`@agentic-orch/ts-quality` module for formatting, lint configuration, secret scanning, and managed
hooks. Drone still owns its coverage floors, Swift gates, and sandbox-specific tests. The pnpm
version is enforced natively by `packageManager`, `engines.pnpm`, and `pmOnFail: error` with
`engineStrict` in `pnpm-workspace.yaml`.

| Command                | Scope                                                                        |
| ---------------------- | ---------------------------------------------------------------------------- |
| `pnpm quality:quick`   | Formatting, warning-free lint, strict TypeScript, and secret scan.           |
| `pnpm check`           | Quick gates plus deterministic tests.                                        |
| `pnpm quality:offline` | Quick gates, coverage, and production build.                                 |
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

## Siblings

`drone-client`, `node-guardrails`, and `ts-quality` must be checked out next to this repository; see
the catalog README for the layout. The lock resolves them as `link:` entries, so a missing sibling
fails the frozen install instead of falling back to a registry. The GitHub workflow checks them out
at their default branch, and `pnpm install` builds `drone-client` and `node-guardrails` through
their `prepare` scripts.

The shared scanner bounds reads, never follows symlinks, and reports only escaped file/line
metadata. `pnpm hooks:install` installs managed hooks without replacing an unmanaged hook or
silently changing `core.hooksPath`.
