import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createE2EDatabase } from "./fixture";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_API_KEY = "e2e-api-key-canary";
const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 5_000;

export interface E2EServer {
  readonly origin: string;
  readonly databasePath: string;
  /** Sends an authenticated request to the child process. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Stops the child process once and releases every owned fixture resource. */
  stop(signal?: "SIGINT" | "SIGTERM"): Promise<void>;
  /** Returns the currently captured, credential-redacted process output. */
  diagnostics(): Readonly<{ stdout: string; stderr: string }>;
}

export interface E2EServerOptions {
  readonly entrypoint?: "cli" | "auth-plugin";
  readonly databasePath?: string;
  readonly apiKey?: string;
  readonly maxRows?: number;
  readonly maxEmbedDepth?: number;
  readonly maxBodyBytes?: number;
  readonly busyTimeoutMs?: number;
  readonly corsOrigins?: readonly string[];
  readonly logLevel?: "debug" | "info" | "warn" | "error";
}

interface CapturedOutput {
  readonly done: Promise<void>;
  text(): string;
}

/** Drains one process stream continuously so a verbose child cannot deadlock. */
function capture(stream: ReadableStream<Uint8Array>): CapturedOutput {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const done = (async () => {
    const reader = stream.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(decoder.decode(result.value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } finally {
      reader.releaseLock();
    }
  })();
  return { done, text: () => chunks.join("") };
}

/** Asks the operating system for an unused loopback port. */
async function chooseEphemeralPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate an ephemeral test port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

/** Removes credentials and authorization values before exposing diagnostics. */
function redact(value: string, secrets: readonly string[]): string {
  let redacted = value.replace(
    /authorization\s*[:=]\s*[^\s,"}]+/giu,
    "authorization=[REDACTED]",
  );
  for (const secret of secrets) {
    if (secret !== "") redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

/** Rejects an asynchronous lifecycle step after one fixed upper bound. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Polls process liveness without allowing one readiness request to hang. */
async function waitForReadiness(
  origin: string,
  subprocess: Bun.Subprocess,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (subprocess.exitCode !== null) {
      throw new Error(
        `Server exited during startup with ${subprocess.exitCode}`,
      );
    }
    try {
      const response = await fetch(`${origin}/health/live`, {
        signal: AbortSignal.timeout(250),
      });
      if (response.status === 200) return;
    } catch {
      // The listener is not ready yet.
    }
    await Bun.sleep(25);
  }
  throw new Error(`Server did not become ready within ${START_TIMEOUT_MS}ms`);
}

/** Builds one isolated database and launches a real child-process HTTP server. */
export async function startE2EServer(
  options: E2EServerOptions = {},
): Promise<E2EServer> {
  const port = await chooseEphemeralPort();
  const ownedDirectory =
    options.databasePath === undefined
      ? mkdtempSync(join(tmpdir(), "setupless-rest-e2e-"))
      : undefined;
  const databasePath =
    options.databasePath ?? join(ownedDirectory as string, "database.sqlite");
  try {
    if (options.databasePath === undefined) createE2EDatabase(databasePath);
  } catch (error) {
    if (ownedDirectory !== undefined) {
      rmSync(ownedDirectory, { recursive: true, force: true });
    }
    throw error;
  }

  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const entrypoint = options.entrypoint ?? "cli";
  const command =
    entrypoint === "cli"
      ? [process.execPath, "dist/cli.js"]
      : [process.execPath, "dist/e2e/auth-server.js"];
  let subprocess: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    subprocess = Bun.spawn({
      cmd: command,
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        DATABASE_PATH: databasePath,
        HOST: "127.0.0.1",
        PORT: String(port),
        SETUPLESS_REST_API_KEY: entrypoint === "cli" ? apiKey : "",
        MAX_ROWS: String(options.maxRows ?? 1000),
        MAX_EMBED_DEPTH: String(options.maxEmbedDepth ?? 5),
        MAX_BODY_BYTES: String(options.maxBodyBytes ?? 1_048_576),
        SQLITE_BUSY_TIMEOUT_MS: String(options.busyTimeoutMs ?? 5000),
        CORS_ORIGINS: options.corsOrigins?.join(",") ?? "",
        LOG_LEVEL: options.logLevel ?? "info",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if (ownedDirectory !== undefined) {
      rmSync(ownedDirectory, { recursive: true, force: true });
    }
    throw error;
  }
  const stdout = capture(subprocess.stdout);
  const stderr = capture(subprocess.stderr);
  const origin = `http://127.0.0.1:${port}`;
  let stopPromise: Promise<void> | undefined;

  const diagnostics = () =>
    Object.freeze({
      stdout: redact(stdout.text(), [apiKey]),
      stderr: redact(stderr.text(), [apiKey]),
    });

  const stop = (signal: "SIGINT" | "SIGTERM" = "SIGTERM") => {
    if (!stopPromise) {
      stopPromise = (async () => {
        if (subprocess.exitCode === null) subprocess.kill(signal);
        try {
          await withTimeout(
            subprocess.exited,
            STOP_TIMEOUT_MS,
            `Server did not stop after ${signal}`,
          );
        } catch (error) {
          if (subprocess.exitCode === null) subprocess.kill("SIGKILL");
          await subprocess.exited;
          throw error;
        } finally {
          await Promise.all([stdout.done, stderr.done]);
          if (ownedDirectory !== undefined) {
            rmSync(ownedDirectory, { recursive: true, force: true });
          }
        }
      })();
    }
    return stopPromise;
  };

  try {
    await waitForReadiness(origin, subprocess);
  } catch (error) {
    await stop().catch(() => undefined);
    const output = diagnostics();
    throw new Error(
      `${error instanceof Error ? error.message : "Server startup failed"}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
    );
  }

  return Object.freeze({
    origin,
    databasePath,
    request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (entrypoint === "cli" && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${apiKey}`);
      }
      return fetch(`${origin}${path}`, { ...init, headers });
    },
    stop,
    diagnostics,
  });
}

/** Installs bounded before/after hooks for one independently isolated test file. */
export function useE2EServer(options: E2EServerOptions = {}): E2EServer {
  let server: E2EServer | undefined;
  beforeAll(async () => {
    server = await startE2EServer(options);
  });
  afterAll(async () => {
    await server?.stop();
    server = undefined;
  });
  return {
    get origin() {
      if (!server)
        throw new Error("E2E server is unavailable outside its suite");
      return server.origin;
    },
    get databasePath() {
      if (!server)
        throw new Error("E2E server is unavailable outside its suite");
      return server.databasePath;
    },
    request(path, init) {
      if (!server)
        throw new Error("E2E server is unavailable outside its suite");
      return server.request(path, init);
    },
    stop(signal) {
      if (!server) return Promise.resolve();
      return server.stop(signal);
    },
    diagnostics() {
      if (!server)
        throw new Error("E2E server is unavailable outside its suite");
      return server.diagnostics();
    },
  };
}

/** Asserts one stable public error code while retaining useful failure output. */
export async function expectErrorCode(
  response: Response,
  code: `SLREST${number}`,
): Promise<void> {
  const body = (await response.json()) as Record<string, unknown>;
  if (body.code !== code) {
    throw new Error(`Expected ${code}, received ${JSON.stringify(body)}`);
  }
}
