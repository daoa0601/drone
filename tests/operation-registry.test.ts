import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { OperationRegistry } from "../src/operation-registry.js";
import { operation, temporaryDirectory, writeRegistry } from "./helpers.js";

describe("OperationRegistry", () => {
  it("creates an empty registry and reloads administrator-defined operations", async () => {
    const root = await temporaryDirectory("drone-registry-");
    const file = path.join(root, "nested", "operations.json");
    const registry = new OperationRegistry(file);
    await registry.initialize();
    expect(registry.list()).toEqual([]);

    await writeRegistry(file, [operation({ operation_id: "z.inspect" }), operation()]);
    await registry.reload();

    expect(registry.list().map(({ operation_id }) => operation_id)).toEqual([
      "test.inspect",
      "z.inspect",
    ]);
    expect(JSON.stringify(registry.get("test.inspect"))).toMatch(/sha256/iu);
    expect(JSON.stringify(registry.list())).not.toMatch(/image|command/iu);
  });

  it("distinguishes missing and disabled operations", async () => {
    const root = await temporaryDirectory("drone-registry-disabled-");
    const file = path.join(root, "operations.json");
    await writeRegistry(file, [operation({ enabled: false })]);
    const registry = new OperationRegistry(file);
    await registry.initialize();

    expect(() => registry.get("missing.operation")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(() => registry.get("test.inspect")).toThrow(
      expect.objectContaining({ code: "OPERATION_DISABLED" }),
    );
  });

  it("fails closed for invalid JSON, invalid contracts, and symbolic links", async () => {
    const root = await temporaryDirectory("drone-registry-invalid-");
    const file = path.join(root, "operations.json");
    const registry = new OperationRegistry(file);
    await registry.initialize();

    await writeFile(file, "not-json");
    await expect(registry.reload()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await writeFile(file, JSON.stringify({ schema_version: "1", operations: [{}] }));
    await expect(registry.reload()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });

    const target = path.join(root, "target.json");
    const link = path.join(root, "linked.json");
    await writeRegistry(target, []);
    await symlink(target, link);
    await expect(new OperationRegistry(link).initialize()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});
