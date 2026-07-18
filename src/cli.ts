#!/usr/bin/env node
import {
  createAppleNativeAttestationPayload,
  decodeAppleNativeAttestationPayload,
  providerAttestationSummary,
  readAttestationDocument,
  readPrivateAttestationKey,
  readPublicAttestationKey,
  signProviderAttestation,
  verifyAppleNativeAttestation,
} from "./attestation.js";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { DroneService } from "./service.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  const config = loadConfig();
  if (command === "attestation" && process.argv[3] === "request") {
    const issuer = process.argv[4];
    const expiresAt = process.argv[5];
    if (issuer === undefined || expiresAt === undefined) {
      throw new Error("Usage: drone attestation request <issuer> <expires-at>");
    }
    const payload = await createAppleNativeAttestationPayload({
      measurements: {
        driverPath: config.appleNativeDriver,
        kernelPath: config.appleNativeKernel,
        initfsPath: config.appleNativeInitfs,
      },
      issuer,
      issuedAt: new Date(),
      expiresAt: new Date(expiresAt),
    });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (command === "attestation" && process.argv[3] === "sign") {
    const payloadFile = process.argv[4];
    const privateKeyFile = process.argv[5];
    const publicKeyFile = process.argv[6];
    if (payloadFile === undefined || privateKeyFile === undefined || publicKeyFile === undefined) {
      throw new Error(
        "Usage: drone attestation sign <payload.json> <private-key.pem> <public-key.pem>",
      );
    }
    const payload = decodeAppleNativeAttestationPayload(
      JSON.parse((await readAttestationDocument(payloadFile)).toString("utf8")) as unknown,
    );
    const signed = signProviderAttestation({
      payload,
      privateKeyPem: await readPrivateAttestationKey(privateKeyFile),
      publicKeyPem: await readPublicAttestationKey(publicKeyFile),
    });
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    return;
  }
  if (command === "attestation" && process.argv[3] === "verify") {
    const attestation = await verifyAppleNativeAttestation({
      driverPath: config.appleNativeDriver,
      kernelPath: config.appleNativeKernel,
      initfsPath: config.appleNativeInitfs,
      attestationFile: config.appleNativeAttestationFile,
      publicKeyFile: config.appleNativeAttestationPublicKey,
    });
    process.stdout.write(
      `${JSON.stringify({ status: "verified", attestation: providerAttestationSummary(attestation) }, null, 2)}\n`,
    );
    return;
  }
  const service = new DroneService(config);
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
  process.stderr.write(
    "Usage: drone [serve|doctor|operations|attestation request <issuer> <expires-at>|attestation sign <payload.json> <private-key.pem> <public-key.pem>|attestation verify]\n",
  );
  process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Drone failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
