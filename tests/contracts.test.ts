import { describe, expect, it } from "vitest";

import { decodeJobSubmission, decodeOperationRegistry } from "../src/contracts.js";
import { operation } from "./helpers.js";

describe("Drone contracts", () => {
  it("accepts a pinned, no-network operation", () => {
    expect(
      decodeOperationRegistry({ schema_version: "1", operations: [operation()] }),
    ).toMatchObject([
      {
        operation_id: "test.inspect",
        provider: "apple_native",
        network: "none",
        uid: 65_532,
      },
    ]);
  });

  it.each([
    ["mutable image", { image: "registry.example/drone/tool:latest" }],
    ["network", { network: "default" }],
    ["root user", { uid: 0 }],
    ["empty command", { command: [] }],
    [
      "oversized output",
      {
        outputs: [
          {
            name: "report",
            required: true,
            max_bytes: 32 * 1024 * 1024,
            media_type: "application/json",
          },
        ],
      },
    ],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      decodeOperationRegistry({ schema_version: "1", operations: [operation(override)] }),
    ).toThrow();
  });

  it("accepts only operation IDs and content-addressed input IDs from clients", () => {
    const artifactId = `sha256_${"b".repeat(64)}`;
    expect(
      decodeJobSubmission({
        schema_version: "1",
        operation_id: "test.inspect",
        inputs: { sample: artifactId },
      }),
    ).toEqual({
      schema_version: "1",
      operation_id: "test.inspect",
      inputs: { sample: artifactId },
    });
    expect(() =>
      decodeJobSubmission({
        schema_version: "1",
        operation_id: "test.inspect",
        inputs: { sample: artifactId },
        command: ["/bin/sh"],
      }),
    ).toThrow();
  });
});
