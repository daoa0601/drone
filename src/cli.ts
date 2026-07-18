#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { DroneService } from "./service.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  const service = new DroneService(loadConfig());
  if (command === "serve") {
    const server = await startHttpServer(service);
    const auth =
      service.config.bearerToken === undefined
        ? "loopback development mode without bearer auth"
        : "bearer authentication enabled";
    process.stdout.write(`Drone listening at ${server.origin} (${auth}).\n`);
    const stop = async (): Promise<void> => {
      await server.close();
      process.exitCode = 0;
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    return;
  }
  if (command === "doctor") {
    const providers = await service.providers();
    process.stdout.write(`${JSON.stringify({ status: "ok", providers }, null, 2)}\n`);
    return;
  }
  if (command === "operations") {
    process.stdout.write(`${JSON.stringify(await service.operations(), null, 2)}\n`);
    return;
  }
  process.stderr.write("Usage: drone [serve|doctor|operations]\n");
  process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Drone failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
