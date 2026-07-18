import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { runProcess } from "../src/process.js";
import { temporaryDirectory } from "./helpers.js";

async function run(code: string, overrides: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  return Effect.runPromise(
    runProcess({
      executable: process.execPath,
      args: ["-e", code],
      stdin: "request-body",
      cwd: await temporaryDirectory("drone-process-"),
      env: { PATH: process.env.PATH },
      timeoutMs: overrides.timeoutMs ?? 2_000,
      maxOutputBytes: overrides.maxOutputBytes ?? 1024,
    }),
  );
}

describe("native process custody", () => {
  it("passes argv and stdin without a shell and captures bounded output", async () => {
    const result = await run(
      'process.stdin.setEncoding("utf8"); let value=""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => { process.stdout.write(value.toUpperCase()); process.stderr.write("diagnostic"); });',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("REQUEST-BODY");
    expect(result.stderr.toString()).toBe("diagnostic");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ["stdout", 'process.stdout.write("x".repeat(2048))'],
    ["stderr", 'process.stderr.write("x".repeat(2048))'],
  ])("terminates a driver whose %s exceeds its response budget", async (_stream, code) => {
    await expect(run(code, { maxOutputBytes: 32 })).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
    });
  });

  it("terminates a driver that exceeds the host watchdog", async () => {
    await expect(
      run("setInterval(() => undefined, 1000)", { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
  });

  it("reports launch failures as provider failures", async () => {
    await expect(
      Effect.runPromise(
        runProcess({
          executable: "/definitely/not/a/drone-driver",
          args: [],
          stdin: "",
          cwd: await temporaryDirectory("drone-process-missing-"),
          env: {},
          timeoutMs: 100,
          maxOutputBytes: 128,
        }),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
  });
});
