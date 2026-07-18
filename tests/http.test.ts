import { afterEach, describe, expect, it } from "vitest";

import { startHttpServer } from "../src/http.js";
import type { DroneHttpServer } from "../src/http.js";
import { DroneService } from "../src/service.js";
import {
  FakeAppleProvider,
  PROVIDER_ATTESTATION_ID,
  testConfig,
  writeRegistry,
} from "./helpers.js";

const TOKEN = "drone-test-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const servers: Array<DroneHttpServer> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function terminal(origin: string, jobId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${origin}/v1/jobs/${jobId}`, { headers: AUTH });
    const job = (await response.json()) as Record<string, unknown>;
    if (job.status !== "queued" && job.status !== "running") return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("HTTP job did not finish");
}

describe("Drone HTTP API", () => {
  it("authenticates artifact and job custody without exposing commands or host paths", async () => {
    const config = await testConfig({ bearerToken: TOKEN });
    await writeRegistry(config.operationsFile);
    const service = new DroneService(config, { providers: [new FakeAppleProvider()] });
    const server = await startHttpServer(service, { port: 0 });
    servers.push(server);

    expect(await (await fetch(`${server.origin}/health/live`)).json()).toEqual({ status: "ok" });
    expect((await fetch(`${server.origin}/v1/providers`)).status).toBe(401);
    expect(await (await fetch(`${server.origin}/v1/providers`, { headers: AUTH })).json()).toEqual([
      expect.objectContaining({ provider_id: "apple_native", mutations_available: true }),
    ]);
    const operations = await (
      await fetch(`${server.origin}/v1/operations`, { headers: AUTH })
    ).json();
    expect(JSON.stringify(operations)).not.toMatch(/\/usr\/local|image|command|host_path/iu);

    const stagedResponse = await fetch(`${server.origin}/v1/artifacts`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/octet-stream" },
      body: Buffer.from("sample"),
    });
    expect(stagedResponse.status).toBe(201);
    const staged = (await stagedResponse.json()) as { readonly artifact_id: string };
    const submission = await fetch(`${server.origin}/v1/jobs`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: "1",
        operation_id: "test.inspect",
        provider_attestation_id: PROVIDER_ATTESTATION_ID,
        inputs: { sample: staged.artifact_id },
      }),
    });
    expect(submission.status).toBe(202);
    const queued = (await submission.json()) as { readonly job_id: string };
    const result = await terminal(server.origin, queued.job_id);
    expect(result).toMatchObject({ status: "succeeded" });
    const output = (result.outputs as ReadonlyArray<{ readonly artifact_id: string }>)[0]!;
    const content = await fetch(`${server.origin}/v1/artifacts/${output.artifact_id}/content`, {
      headers: AUTH,
    });
    expect(content.headers.get("content-type")).toBe("application/json");
    expect(await content.text()).toBe('{"verdict":"bounded"}\n');
  });

  it("rejects browser-origin requests in tokenless loopback mode", async () => {
    const config = await testConfig();
    await writeRegistry(config.operationsFile);
    const service = new DroneService(config, { providers: [new FakeAppleProvider()] });
    const server = await startHttpServer(service, { port: 0 });
    servers.push(server);

    const response = await fetch(`${server.origin}/v1/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "https://attacker.example" },
      body: "browser-post",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "AUTH_REQUIRED", message: "A valid bearer token is required." },
    });
  });
});
