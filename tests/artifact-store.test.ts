import { mkdir, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/artifact-store.js";
import { temporaryDirectory } from "./helpers.js";

describe("ArtifactStore", () => {
  it("deduplicates bytes by sha256 and preserves bounded metadata", async () => {
    const root = await temporaryDirectory("drone-artifacts-");
    const store = new ArtifactStore(root, 1024);
    const first = await store.stage(Buffer.from("sample"), "application/octet-stream");
    const second = await store.stage(Buffer.from("sample"), "application/octet-stream");
    expect(second.artifact_id).toBe(first.artifact_id);
    expect(second.size_bytes).toBe(6);
    expect((await store.read(first.artifact_id)).bytes.toString()).toBe("sample");
  });

  it("rejects empty, oversized, and symbolic-link output files", async () => {
    const root = await temporaryDirectory("drone-artifacts-invalid-");
    const store = new ArtifactStore(path.join(root, "store"), 4);
    await expect(store.stage(Buffer.alloc(0), "application/octet-stream")).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });
    await expect(store.stage(Buffer.alloc(5), "application/octet-stream")).rejects.toMatchObject({
      code: "ARTIFACT_LIMIT_EXCEEDED",
    });
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    await writeFile(target, "x");
    await symlink(target, link);
    await expect(store.stageFile(link, "text/plain")).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });
  });

  it("normalizes media types and stages bounded regular files", async () => {
    const root = await temporaryDirectory("drone-artifacts-file-");
    const file = path.join(root, "report.txt");
    await writeFile(file, "report");
    const store = new ArtifactStore(path.join(root, "store"), 1024);

    const metadata = await store.stageFile(file, " Text/Plain; charset=utf-8 ", 16);

    expect(metadata).toMatchObject({ size_bytes: 6, media_type: "text/plain" });
    expect((await store.read(metadata.artifact_id)).bytes.toString("utf8")).toBe("report");
    await expect(store.stageFile(file, "text/plain", 4)).rejects.toMatchObject({
      code: "ARTIFACT_LIMIT_EXCEEDED",
    });
    await expect(store.stage(Buffer.from("x"), "invalid")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("detects missing blobs and inconsistent metadata", async () => {
    const root = await temporaryDirectory("drone-artifacts-corrupt-");
    const storeRoot = path.join(root, "store");
    const store = new ArtifactStore(storeRoot, 1024);
    const metadata = await store.stage(Buffer.from("sample"), "application/octet-stream");
    const metadataFile = path.join(storeRoot, "metadata", `${metadata.sha256}.json`);
    const blob = path.join(storeRoot, "blobs", metadata.sha256);

    await writeFile(metadataFile, `${JSON.stringify({ ...metadata, size_bytes: 999 })}\n`);
    await expect(store.inspect(metadata.artifact_id)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });
    await writeFile(metadataFile, `${JSON.stringify(metadata)}\n`);
    await unlink(blob);
    await expect(store.inspect(metadata.artifact_id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.inspect("not-an-artifact-id")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects bounded metadata sidecars that are oversized or symbolic links", async () => {
    const root = await temporaryDirectory("drone-artifacts-metadata-");
    const storeRoot = path.join(root, "store");
    const store = new ArtifactStore(storeRoot, 1024);
    const metadata = await store.stage(Buffer.from("sample"), "application/octet-stream");
    const metadataFile = path.join(storeRoot, "metadata", `${metadata.sha256}.json`);
    const valid = `${JSON.stringify(metadata)}\n`;

    await writeFile(metadataFile, `${valid}${" ".repeat(8 * 1024)}`);
    await expect(store.inspect(metadata.artifact_id)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      status: 500,
    });

    const external = path.join(root, "external.json");
    await writeFile(external, valid, { mode: 0o600 });
    await unlink(metadataFile);
    await symlink(external, metadataFile);
    await expect(store.inspect(metadata.artifact_id)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });
  });

  it("rejects a symbolic-link metadata root without writing through it", async () => {
    const root = await temporaryDirectory("drone-artifacts-root-");
    const storeRoot = path.join(root, "store");
    const external = path.join(root, "external");
    await Promise.all([mkdir(storeRoot, { mode: 0o700 }), mkdir(external, { mode: 0o700 })]);
    await symlink(external, path.join(storeRoot, "metadata"));
    const store = new ArtifactStore(storeRoot, 1024);

    await expect(store.stage(Buffer.from("sample"), "text/plain")).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });
    await expect(readdir(external)).resolves.toEqual([]);
  });

  it("makes conflicting media types explicit for sequential and concurrent deduplication", async () => {
    const root = await temporaryDirectory("drone-artifacts-media-");
    const store = new ArtifactStore(path.join(root, "store"), 1024);
    const first = await store.stage(Buffer.from("same"), " Text/Plain; charset=utf-8 ");

    await expect(
      store.stage(Buffer.from("same"), "application/octet-stream"),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    await expect(store.inspect(first.artifact_id)).resolves.toMatchObject({
      media_type: "text/plain",
    });

    const concurrentStore = new ArtifactStore(path.join(root, "concurrent"), 1024);
    const results = await Promise.allSettled([
      concurrentStore.stage(Buffer.from("race"), "text/plain"),
      concurrentStore.stage(Buffer.from("race"), "application/octet-stream"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "CONFLICT", status: 409 },
    });
  });
});
