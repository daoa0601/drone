import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  HttpGuardrailError,
  matchesBearerToken,
  readBoundedBody,
  readBoundedJson,
  requestMediaType,
  sendJson as sendHardenedJson,
} from "@agentic-orch/node-guardrails/http";

import type { DroneConfig } from "./config.js";
import { decodeJobSubmission } from "./contracts.js";
import { DroneError, redactedError } from "./errors.js";
import type { DroneService } from "./service.js";

const REJECTED_BODY_CLEANUP_MS = 1_000;

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  sendHardenedJson(response, status, value, { newline: true });
}

function authenticate(request: http.IncomingMessage, config: DroneConfig): boolean {
  if (config.bearerToken === undefined) {
    // Loopback mode is for non-browser local clients. Reject simple cross-origin requests so a
    // website cannot fill the artifact store through DNS rebinding or localhost POSTs.
    return request.headers.origin === undefined;
  }
  return matchesBearerToken(request.headers.authorization, config.bearerToken);
}

function bodyError(cause: HttpGuardrailError, limit: number): DroneError {
  if (cause.kind === "body_too_large") {
    return new DroneError({
      code: "BODY_TOO_LARGE",
      message: `Request body exceeds the ${limit}-byte limit.`,
      status: 413,
      cause,
    });
  }
  if (cause.kind === "content_encoding_unsupported") {
    return new DroneError({
      code: "INVALID_INPUT",
      message: "Compressed request bodies are not accepted.",
      status: 415,
      cause,
    });
  }
  if (cause.kind === "media_type_unsupported") {
    return new DroneError({
      code: "INVALID_INPUT",
      message: "Request body must be JSON.",
      status: 415,
      cause,
    });
  }
  if (cause.kind === "json_invalid") {
    return new DroneError({
      code: "INVALID_INPUT",
      message: "Request body is not valid JSON.",
      status: 400,
      cause,
    });
  }
  return new DroneError({
    code: "INVALID_INPUT",
    message: cause.kind === "content_length_invalid" ? "Content-Length is invalid." : cause.message,
    status: 400,
    cause,
  });
}

async function body(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  limit: number,
): Promise<Buffer> {
  try {
    return await readBoundedBody(request, {
      limitBytes: limit,
      rejection: {
        action: "respond-and-close",
        response,
        timeoutMs: REJECTED_BODY_CLEANUP_MS,
      },
    });
  } catch (cause) {
    if (cause instanceof HttpGuardrailError) throw bodyError(cause, limit);
    throw cause;
  }
}

async function jsonBody(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  limit: number,
): Promise<unknown> {
  try {
    return await readBoundedJson(request, {
      limitBytes: limit,
      rejection: {
        action: "respond-and-close",
        response,
        timeoutMs: REJECTED_BODY_CLEANUP_MS,
      },
    });
  } catch (cause) {
    if (cause instanceof HttpGuardrailError) throw bodyError(cause, limit);
    throw cause;
  }
}

async function artifactContent(
  response: http.ServerResponse,
  service: DroneService,
  artifactId: string,
): Promise<void> {
  const { metadata, bytes } = await service.artifactBytes(artifactId);
  response.writeHead(200, {
    "Content-Type": metadata.media_type,
    "Content-Length": metadata.size_bytes,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(bytes);
}

async function handle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  service: DroneService,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (method === "GET" && url.pathname === "/health/live") {
    return sendJson(response, 200, { status: "ok" });
  }
  if (method === "GET" && url.pathname === "/health/ready") {
    await service.initialize();
    return sendJson(response, 200, { status: "ready" });
  }
  if (!url.pathname.startsWith("/v1/")) {
    throw new DroneError({ code: "NOT_FOUND", message: "Route was not found.", status: 404 });
  }
  if (!authenticate(request, service.config)) {
    throw new DroneError({
      code: "AUTH_REQUIRED",
      message: "A valid bearer token is required.",
      status: 401,
    });
  }
  if (method === "GET" && url.pathname === "/v1/providers") {
    return sendJson(response, 200, await service.providers());
  }
  if (method === "GET" && url.pathname === "/v1/operations") {
    return sendJson(response, 200, await service.operations());
  }
  if (method === "POST" && url.pathname === "/v1/artifacts") {
    const mediaType = requestMediaType(request);
    if (mediaType === undefined || mediaType === "application/json") {
      throw new DroneError({
        code: "ARTIFACT_INVALID",
        message: "Artifact Content-Type is missing or unsupported.",
        status: 415,
      });
    }
    return sendJson(
      response,
      201,
      await service.stageArtifact(
        await body(request, response, service.config.maxArtifactBytes),
        mediaType,
      ),
    );
  }
  if (method === "POST" && url.pathname === "/v1/jobs") {
    return sendJson(
      response,
      202,
      await service.submit(
        decodeJobSubmission(await jsonBody(request, response, service.config.maxJsonBytes)),
      ),
    );
  }
  if (method === "GET" && url.pathname === "/v1/jobs") {
    return sendJson(response, 200, await service.listJobs());
  }

  const artifact = /^\/v1\/artifacts\/(sha256_[a-f0-9]{64})(?:\/(content))?$/u.exec(url.pathname);
  if (artifact !== null) {
    const artifactId = artifact[1]!;
    if (method === "GET" && artifact[2] === undefined) {
      return sendJson(response, 200, await service.artifact(artifactId));
    }
    if (method === "GET" && artifact[2] === "content") {
      return artifactContent(response, service, artifactId);
    }
  }

  const job = /^\/v1\/jobs\/(job_[a-f0-9]{32})(?:\/(cancel))?$/u.exec(url.pathname);
  if (job !== null) {
    const jobId = job[1]!;
    if (method === "GET" && job[2] === undefined) {
      return sendJson(response, 200, await service.inspectJob(jobId));
    }
    if (method === "POST" && job[2] === "cancel") {
      return sendJson(response, 200, await service.cancel(jobId));
    }
  }

  throw new DroneError({ code: "NOT_FOUND", message: "Route was not found.", status: 404 });
}

export interface DroneHttpServer {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

export async function startHttpServer(
  service: DroneService,
  overrides: { readonly host?: string; readonly port?: number } = {},
): Promise<DroneHttpServer> {
  await service.initialize();
  const server = http.createServer(
    {
      maxHeaderSize: 16 * 1024,
      requestTimeout: 65_000,
      headersTimeout: 10_000,
    },
    (request, response) => {
      void handle(request, response, service).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const redacted = redactedError(error);
        sendJson(response, redacted.status, redacted.body);
      });
    },
  );
  server.maxConnections = 128;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      overrides.port ?? service.config.port,
      overrides.host ?? service.config.host,
      () => {
        server.off("error", reject);
        resolve();
      },
    );
  });
  const address = server.address() as AddressInfo;
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  return {
    origin: `http://${host}:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      await service.shutdown();
    },
  };
}
