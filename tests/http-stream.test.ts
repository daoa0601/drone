import { afterEach, describe, expect, it, vi } from "vitest";

import { startHttpServer, type DroneHttpServer } from "../src/http.js";
import type { DroneService } from "../src/service.js";
import { testConfig } from "./helpers.js";

const TOKEN = "drone-stream-test-token";
const ARTIFACT_ID = `sha256_${"a".repeat(64)}`;
const servers: Array<DroneHttpServer> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Drone artifact download custody", () => {
  it("serves the verified byte snapshot without reopening a pathname", async () => {
    const config = await testConfig({ bearerToken: TOKEN });
    const bytes = Buffer.from("verified artifact snapshot");
    const artifactBytes = vi.fn(async () => ({
      metadata: {
        schema_version: "1" as const,
        artifact_id: ARTIFACT_ID,
        sha256: "a".repeat(64),
        size_bytes: bytes.byteLength,
        media_type: "application/octet-stream",
        created_at: new Date(0).toISOString(),
      },
      bytes,
    }));
    const service = {
      config,
      initialize: async () => undefined,
      shutdown: async () => undefined,
      artifactBytes,
    } as unknown as DroneService;
    const server = await startHttpServer(service, { port: 0 });
    servers.push(server);

    const response = await fetch(`${server.origin}/v1/artifacts/${ARTIFACT_ID}/content`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    await expect(response.arrayBuffer()).resolves.toEqual(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    expect(artifactBytes).toHaveBeenCalledOnce();
    expect(artifactBytes).toHaveBeenCalledWith(ARTIFACT_ID);
  });
});
