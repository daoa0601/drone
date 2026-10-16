# Drone

Drone is a reusable local sandbox deployment service. It gives local applications one small API for
staging artifacts and running operator-defined operations in disposable environments.

The first executable backend uses Apple Containerization directly. Every job receives a separate
Virtualization.framework Linux VM. The backend creates no network interface, exposes no host
directory, runs a non-root process without Linux capabilities, and destroys the VM after collecting
declared outputs.

## Boundary

Clients can supply only:

- an operation ID;
- the exact current provider-attestation ID they approve;
- content-addressed artifact IDs for the operation's declared input slots.

Clients cannot supply an image, command, environment variable, host path, mount, resource value,
architecture, user, or networking mode. Those live in the local operation registry managed by the
Drone operator.

```text
Local client
  -> Drone HTTP API
       -> artifact and job stores
       -> trusted operation registry
       -> provider router
            -> Apple native worker
                 -> one no-NIC lightweight VM
                 -> read-only OCI root + bounded writable layer
                 -> fixed-size ext4 input/output disks
```

Drone verifies and bounds artifact bytes through one content-store file handle before provider
admission. The path-only native worker receives a read-only copy in a unique private run directory,
not the reopenable content-store pathname; that copy exists only for the scoped provider run. The
input disk is mounted read-only. The output disk has a fixed capacity and only declared files are
extracted. Specimen code never receives a host directory, home directory, SSH socket, registry
credential, or inherited host environment.

## Setup

Requirements:

- Apple silicon and macOS 26 or later for the native backend;
- Swift 6.2/Xcode 26 for building the worker;
- Node.js and pnpm versions declared in `package.json`;
- `drone-client`, `node-guardrails`, and `ts-quality` checked out next to this repository (see the
  catalog README for the sibling layout).

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm native:build
```

The lock resolves the three `workspace:*` siblings as `link:` entries, so a missing sibling is an
installation error rather than a registry fallback. `pnpm install` builds `drone-client` and
`node-guardrails` through their `prepare` scripts.

The service starts safely with no enabled operation and with the native provider disabled:

```bash
cp .env.example .env
pnpm dev
```

`DRONE_HOME/operations.json` is created as an empty registry on first start. Runtime enablement is
fail-closed: the configured worker, arm64 Linux kernel, vminit ext4 image, and local
Containerization image store must all exist, and the first three files must match a current signed
attestation, before `mutations_available` becomes true. Drone's runtime path never pulls an image;
OCI images referenced by operations must already be present under `DRONE_APPLE_NATIVE_STATE`.

Do not use Apple's persistent `container machine` mode for specimen execution. Drone uses the
Containerization library directly so `networking: false` is an invariant rather than an API option.

### Provision the native runtime

`pnpm native:build` builds the release Swift tools, ad-hoc signs only `drone-sandboxd` with the
required `com.apple.security.virtualization` entitlement, verifies the signature, and rejects the
build if `com.apple.vm.networking` appears. The operator-only `drone-provisioner` is deliberately a
separate executable and is not part of the measured per-job driver.

Resolve the release binary directory with Swift, then provision into private absolute paths:

```bash
NATIVE_BIN="$(swift build \
  --package-path native/apple-containerization \
  -c release \
  --show-bin-path)"

"$NATIVE_BIN/drone-provisioner" load-oci \
  /private/drone/image-store \
  /private/images/analyzer.oci.tar

"$NATIVE_BIN/drone-provisioner" prepare-initfs \
  /private/drone/image-store \
  ghcr.io/apple/containerization/vminit@sha256:<64-hex-digest> \
  /private/drone/runtime/initfs.ext4

"$NATIVE_BIN/drone-provisioner" list /private/drone/image-store
```

Both commands reject relative paths; `prepare-initfs` requires an exact digest reference and refuses
to overwrite an existing output. `load-oci` rejects unsafe archive members and records a pinned
reference in the private Containerization image store. Supply a reviewed arm64 Linux kernel
separately, set the four `DRONE_APPLE_NATIVE_*` paths in `.env`, and hash/review the signed driver,
kernel, and initfs before issuing an attestation. Provisioning may use network or registry
credentials in the trusted operator context; the measured runtime path never does.

## Independent runtime attestation

The service never receives an attestation private key. An operator first provisions and reviews the
native worker, kernel, and init filesystem, then creates a measurement request. A separate signing
context reviews that request and signs it with an offline Ed25519 key. Statements are valid for at
most seven days.

```bash
# Build Drone before running these commands. Keep the private key outside DRONE_HOME and the repo.
openssl genpkey -algorithm ED25519 -out /private/offline/drone-attestor.pem
chmod 600 /private/offline/drone-attestor.pem
openssl pkey -in /private/offline/drone-attestor.pem -pubout \
  -out .drone/runtime/apple-native-attestor.pub.pem

node dist/cli.js attestation request independent-reviewer <expires-at-UTC> \
  > /private/offline/apple-native-request.json

# Run only after independently reviewing the exact three digests and fixed isolation claims.
node dist/cli.js attestation sign \
  /private/offline/apple-native-request.json \
  /private/offline/drone-attestor.pem \
  .drone/runtime/apple-native-attestor.pub.pem \
  > .drone/runtime/apple-native-attestation.json

node dist/cli.js attestation verify
```

The signed payload binds SHA-256 identities for the exact native driver, Linux kernel, and initfs,
plus the fixed no-network lightweight-VM policy. Provider readiness remeasures all three files and
probes the measured driver. Every admitted job then receives a random challenge. The measured native
driver returns a challenge-, provider-, image-, and VM-ID-bound execution statement, which Drone
validates and stores in its content-addressed artifact store. Each durable job records both
`provider_attestation_id` and, after a process result exists, `execution_attestation_artifact_id`.

This is signed software-measurement attestation, not Apple hardware-backed remote guest attestation.
It detects stale, substituted, expired, or untrusted runtime material and creates an auditable local
chain. It does not defend against a compromised host kernel, root, or the same service account
modifying process memory. Independence therefore depends on keeping the signing key and review
outside the Drone service account and reviewing build provenance before signing.

## Operation registry

An operation pins an OCI digest and fixes every part of execution policy:

```json
{
  "schema_version": "1",
  "operations": [
    {
      "operation_id": "pe.static_snapshot",
      "enabled": true,
      "provider": "apple_native",
      "image": "registry.example/drone/pe-tools@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "command": ["/usr/local/bin/capture-pe", "/drone/input/sample", "/drone/output/report"],
      "environment": {},
      "architecture": "arm64",
      "network": "none",
      "uid": 65532,
      "gid": 65532,
      "inputs": [
        {
          "name": "sample",
          "required": true,
          "max_bytes": 33554432,
          "media_types": ["application/vnd.microsoft.portable-executable"]
        }
      ],
      "outputs": [
        {
          "name": "report",
          "required": true,
          "max_bytes": 1048576,
          "media_type": "application/json"
        }
      ],
      "resources": {
        "cpus": 2,
        "memory_mb": 2048,
        "rootfs_mb": 4096,
        "writable_mb": 256,
        "output_disk_mb": 32,
        "timeout_seconds": 120,
        "max_log_bytes": 262144,
        "max_processes": 64,
        "max_open_files": 256
      }
    }
  ]
}
```

Restart Drone after changing the registry. Invalid or mutable image references prevent readiness.

## HTTP API

| Method and path                 | Purpose                                      |
| ------------------------------- | -------------------------------------------- |
| `GET /health/live`              | Process liveness.                            |
| `GET /health/ready`             | Store and registry readiness.                |
| `GET /v1/providers`             | Provider availability and capabilities.      |
| `GET /v1/operations`            | Public operation declarations.               |
| `POST /v1/artifacts`            | Stage a bounded binary artifact.             |
| `GET /v1/artifacts/:id`         | Read artifact metadata.                      |
| `GET /v1/artifacts/:id/content` | Download artifact content.                   |
| `POST /v1/jobs`                 | Submit an operation with artifact IDs.       |
| `GET /v1/jobs`                  | List recent durable jobs.                    |
| `GET /v1/jobs/:id`              | Read one durable job.                        |
| `POST /v1/jobs/:id/cancel`      | Interrupt a job owned by this Drone process. |

A bearer token is required for non-loopback binding. Tokenless loopback mode rejects requests with a
browser `Origin` header. Jobs left active by a process restart are marked `interrupted`; they are
never reconstructed from untrusted output.

Provider responses expose the current attestation ID, key ID, issuer, and validity window. Job
responses expose the provider attestation admitted at submission and the content-addressed execution
statement after the native worker returns a process result. Consumers should reject a mutation when
any of those correlations changes. Every job submission must repeat the approved
`provider_attestation_id`; Drone compares it with the current remeasured provider before creating a
job, closing the discovery-to-admission rotation race.

The HTTP server applies a 10-second header watchdog, a 65-second request watchdog, and bounded body
reads. Unsupported encodings, invalid framing, and oversized or invalid bodies are rejected; a
rejected body read disables keep-alive, drains only for a bounded one-second cleanup interval, and
destroys an incomplete request rather than leaving its socket open. Artifact downloads buffer and
send the bounded byte snapshot already verified through the content-store file handle; the response
path does not reopen or stream from a content-store pathname.

### Wire contract

The public v1 request and response types, protocol and profile constants, limits, and identifier
syntax are defined once in `@agentic-orch/drone-client`, which Drone imports. Drone's server-side
admission decoders build on those definitions but stay stricter than the tolerant client decoders:
they reject unknown fields and map failures to Drone's own error codes. Node.js consumers should use
`@agentic-orch/drone-client` as the HTTP client; see its README for the client behavior.

Provider implementations, trusted operation definitions, stores, service lifecycle, and the HTTP
server remain Drone internals. Drone also uses `@agentic-orch/node-guardrails/process`, `/http`, and
`/cas` for no-shell execution, bounded request handling, hardened JSON responses, and verified
content-addressed file storage. Operation metadata, media validation, job/artifact semantics,
provider policy, and authorization remain server-owned.

## Quality

```bash
pnpm check
pnpm quality:offline
pnpm native:check
pnpm preflight
```

Unit and HTTP tests use a fake provider. They do not boot a VM, pull an image, execute a specimen,
or consume model/API usage.
