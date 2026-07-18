import path from "node:path";

import { describe, expect, it } from "vitest";

import { isLoopbackHost, loadConfig } from "../src/config.js";
import { temporaryDirectory } from "./helpers.js";

describe("Drone configuration", () => {
  it("derives private storage paths from an explicit Drone home", async () => {
    const home = await temporaryDirectory("drone-config-");
    const config = loadConfig({ DRONE_HOME: home });

    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8090,
      droneHome: home,
      artifactRoot: path.join(home, "artifacts"),
      jobsRoot: path.join(home, "jobs"),
      runsRoot: path.join(home, "runs"),
      operationsFile: path.join(home, "operations.json"),
      maxActiveJobs: 2,
      appleNativeEnabled: false,
    });
    expect(config).not.toHaveProperty("bearerToken");
  });

  it("requires authentication for a non-loopback listener", () => {
    expect(() => loadConfig({ DRONE_HOST: "0.0.0.0" })).toThrow(/DRONE_BEARER_TOKEN is required/u);
    expect(
      loadConfig({
        DRONE_HOST: "0.0.0.0",
        DRONE_BEARER_TOKEN: "  operator-secret  ",
      }),
    ).toMatchObject({ host: "0.0.0.0", bearerToken: "operator-secret" });
  });

  it("accepts only explicit booleans and bounded integers", () => {
    expect(
      loadConfig({
        DRONE_PORT: "8443",
        DRONE_MAX_ACTIVE_JOBS: "4",
        DRONE_MAX_JSON_BYTES: "2048",
        DRONE_MAX_ARTIFACT_BYTES: "4096",
        DRONE_APPLE_NATIVE_ENABLED: "true",
      }),
    ).toMatchObject({
      port: 8443,
      maxActiveJobs: 4,
      maxJsonBytes: 2048,
      maxArtifactBytes: 4096,
      appleNativeEnabled: true,
    });

    for (const environment of [
      { DRONE_PORT: "0" },
      { DRONE_MAX_ACTIVE_JOBS: "1.5" },
      { DRONE_MAX_JSON_BYTES: "many" },
      { DRONE_APPLE_NATIVE_ENABLED: "yes" },
    ]) {
      expect(() => loadConfig(environment)).toThrow();
    }
  });

  it("recognizes only explicit loopback host names", () => {
    expect(["127.0.0.1", "::1", "localhost"].every(isLoopbackHost)).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});
