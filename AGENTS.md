# Drone

## Quick start

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm doctor
```

## Architecture

Drone is a local, reusable sandbox deployment service. Its HTTP API accepts content-addressed
artifacts and trusted operation IDs only. Provider selection, OCI image digests, commands, mounts,
networking, users, resources, and output declarations are operator-controlled configuration.

The TypeScript/Effect control plane owns admission, persistence, cancellation, artifact custody,
provider routing, and the API. `native/apple-containerization` is a narrow Swift worker that creates
one Apple Virtualization-backed Linux VM per job.

## Conventions

- Use strict TypeScript and Effect for typed failures, cancellation, and resource scopes.
- Never execute through a shell or accept commands, images, URLs, mounts, or host paths from
  clients.
- Treat operation configuration as trusted administrative policy and job input as untrusted.
- Native jobs have no NIC, host-directory share, SSH socket, nested virtualization, or inherited
  host environment.
- Use read-only OCI roots, bounded writable layers, fixed-size ext4 exchange disks, non-root users,
  empty Linux capability sets, and `no_new_privileges`.
- Do not expose raw provider errors through the API.
- Tests use fake providers and never execute a real specimen or pull an image.
- Run `pnpm preflight` and `pnpm native:check` before release.

## Testing

```bash
pnpm check
pnpm quality:offline
pnpm native:check
```
