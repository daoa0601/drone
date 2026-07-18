import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { JobRecord, JobStatus } from "../src/domain.js";
import { assertJobId, createJobId, JobStore } from "../src/job-store.js";
import { temporaryDirectory } from "./helpers.js";

function record(jobId: string, status: JobStatus, submittedAt = "2026-01-01T00:00:00.000Z") {
  return {
    schema_version: "1",
    job_id: jobId,
    operation_id: "test.inspect",
    provider_id: "apple_native",
    provider_attestation_id: `attestation.sha256.${"a".repeat(64)}`,
    status,
    inputs: {},
    outputs: [],
    submitted_at: submittedAt,
  } satisfies JobRecord;
}

describe("JobStore", () => {
  it("marks unfinished jobs interrupted during restart recovery", async () => {
    const root = await temporaryDirectory("drone-jobs-recovery-");
    const store = new JobStore(root);
    await store.initialize();
    const queued = createJobId();
    const completed = createJobId();
    await store.create(record(queued, "queued"));
    await store.create(record(completed, "succeeded"));

    await new JobStore(root).initialize();

    await expect(store.get(queued)).resolves.toMatchObject({
      status: "interrupted",
      error_code: "SERVICE_RESTARTED",
    });
    await expect(store.get(completed)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("sorts valid records and isolates corrupt on-disk entries", async () => {
    const root = await temporaryDirectory("drone-jobs-list-");
    const store = new JobStore(root);
    await store.initialize();
    const older = createJobId();
    const newer = createJobId();
    await store.create(record(older, "failed", "2026-01-01T00:00:00.000Z"));
    await store.create(record(newer, "succeeded", "2026-02-01T00:00:00.000Z"));
    const corrupt = `job_${"f".repeat(32)}`;
    await mkdir(path.join(root, corrupt));
    await writeFile(path.join(root, corrupt, "job.json"), "not-json");
    await mkdir(path.join(root, "unrelated"));

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ job_id: newer }),
      expect.objectContaining({ job_id: older }),
    ]);
  });

  it("rejects invalid identifiers and unavailable records", async () => {
    const store = new JobStore(await temporaryDirectory("drone-jobs-errors-"));
    await store.initialize();
    expect(() => assertJobId("../escape")).toThrow(/Job ID is invalid/u);
    await expect(store.get(`job_${"0".repeat(32)}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.write(record(createJobId(), "queued"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses a symbolic-link storage root", async () => {
    const parent = await temporaryDirectory("drone-jobs-link-");
    const target = path.join(parent, "target");
    const link = path.join(parent, "jobs");
    await mkdir(target);
    await symlink(target, link);

    await expect(new JobStore(link).initialize()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("distinguishes active from terminal states", async () => {
    const store = new JobStore(await temporaryDirectory("drone-jobs-terminal-"));
    expect(store.isTerminal(record(createJobId(), "running"))).toBe(false);
    for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) {
      expect(store.isTerminal(record(createJobId(), status))).toBe(true);
    }
  });
});
