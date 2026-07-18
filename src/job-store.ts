import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { JobRecord, JobStatus, ProviderId } from "./domain.js";
import { DroneError, invalidInput } from "./errors.js";

const JOB_ID = /^job_[a-f0-9]{32}$/u;
const TERMINAL = new Set<JobStatus>(["succeeded", "failed", "cancelled", "interrupted"]);
const PROVIDERS = new Set<ProviderId>(["apple_native"]);

function persistedJob(value: unknown): JobRecord {
  if (typeof value !== "object" || value === null) throw new Error("job must be an object");
  const job = value as Partial<JobRecord>;
  if (
    job.schema_version !== "1" ||
    typeof job.job_id !== "string" ||
    !JOB_ID.test(job.job_id) ||
    typeof job.operation_id !== "string" ||
    typeof job.provider_id !== "string" ||
    !PROVIDERS.has(job.provider_id as ProviderId) ||
    typeof job.status !== "string" ||
    !["queued", "running", "succeeded", "failed", "cancelled", "interrupted"].includes(
      job.status,
    ) ||
    typeof job.inputs !== "object" ||
    job.inputs === null ||
    !Array.isArray(job.outputs) ||
    typeof job.submitted_at !== "string"
  ) {
    throw new Error("job record is invalid");
  }
  return job as JobRecord;
}

export function createJobId(): string {
  return `job_${randomUUID().replaceAll("-", "")}`;
}

export function assertJobId(value: string): string {
  if (!JOB_ID.test(value)) throw invalidInput("Job ID is invalid.");
  return value;
}

export class JobStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new DroneError({
        code: "SERVICE_UNAVAILABLE",
        message: "Job store root is invalid.",
        status: 503,
        expose: false,
      });
    }
    const jobs = await this.list();
    const now = new Date().toISOString();
    await Promise.all(
      jobs
        .filter((job) => job.status === "queued" || job.status === "running")
        .map((job) =>
          this.write({
            ...job,
            status: "interrupted",
            finished_at: now,
            error_code: "SERVICE_RESTARTED",
          }),
        ),
    );
  }

  async create(job: JobRecord): Promise<void> {
    assertJobId(job.job_id);
    await mkdir(this.#directory(job.job_id), { mode: 0o700 });
    await this.write(job);
  }

  async write(job: JobRecord): Promise<void> {
    assertJobId(job.job_id);
    const directory = this.#directory(job.job_id);
    const info = await lstat(directory).catch((cause: unknown) => {
      throw new DroneError({
        code: "NOT_FOUND",
        message: "Job was not found.",
        status: 404,
        cause,
      });
    });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new DroneError({
        code: "INTERNAL_ERROR",
        message: "Job directory is invalid.",
        status: 500,
        expose: false,
      });
    }
    const target = path.join(directory, "job.json");
    const temporary = path.join(directory, `.job-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(job)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  }

  async get(jobId: string): Promise<JobRecord> {
    assertJobId(jobId);
    try {
      const target = path.join(this.#directory(jobId), "job.json");
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid job record");
      return persistedJob(JSON.parse(await readFile(target, "utf8")) as unknown);
    } catch (cause) {
      if (cause instanceof DroneError) throw cause;
      throw new DroneError({
        code: "NOT_FOUND",
        message: "Job was not found.",
        status: 404,
        cause,
      });
    }
  }

  async list(): Promise<ReadonlyArray<JobRecord>> {
    const entries = await readdir(this.#root, { withFileTypes: true }).catch(() => []);
    const jobs: Array<JobRecord> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
      try {
        jobs.push(await this.get(entry.name));
      } catch {
        // A corrupt job record is isolated from unrelated records and remains on disk for inspection.
      }
    }
    return jobs.sort((left, right) => right.submitted_at.localeCompare(left.submitted_at));
  }

  isTerminal(job: JobRecord): boolean {
    return TERMINAL.has(job.status);
  }

  #directory(jobId: string): string {
    return path.join(this.#root, jobId);
  }
}
