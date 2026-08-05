import { describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  cleanupTestDatabase,
  createTestDatabase,
  TEST_USERS,
  useTestFixture,
} from "../test/fixtures";
import { loadConfig } from "./config";
import { serveRest } from "./server";

describe("GET /health", () => {
  const fixture = useTestFixture();

  it("returns an ok status", async () => {
    const response = await fixture.app.handle(
      new Request("http://setupless.test/health"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("runs against the seeded SQLite database without opening a port", () => {
    const users = fixture.database
      .query<
        {
          id: number;
          name: string;
          email: string;
          age: number | null;
          active: number;
          created_at: string;
        },
        []
      >(
        `SELECT id, name, email, age, active, created_at
         FROM users
         ORDER BY id`,
      )
      .all();

    expect(users).toEqual(
      TEST_USERS.map((user, index) => ({
        id: index + 1,
        name: user.name,
        email: user.email,
        age: user.age,
        active: user.active,
        created_at: user.createdAt,
      })),
    );
    expect(
      fixture.database
        .query<{ name: string }, []>(
          "SELECT name FROM active_users ORDER BY id",
        )
        .all(),
    ).toEqual([{ name: "Alice Johnson" }, { name: "Charlie Brown" }]);
    expect(fixture.app.server).toBeNull();
  });
});

describe("library entrypoint", () => {
  it("can be imported without opening a database, port, or signal handlers", async () => {
    const testDatabase = createTestDatabase();
    const importDatabasePath = join(
      testDatabase.directoryPath,
      "import-side-effect.sqlite",
    );

    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
            const before = {
              sigint: process.listenerCount("SIGINT"),
              sigterm: process.listenerCount("SIGTERM"),
            };
            const api = await import("./src/index.ts");
            console.log(JSON.stringify({
              before,
              after: {
                sigint: process.listenerCount("SIGINT"),
                sigterm: process.listenerCount("SIGTERM"),
              },
              exports: {
                createRestApp: typeof api.createRestApp,
                serveRest: typeof api.serveRest,
              },
            }));
          `,
        ],
        {
          cwd: `${import.meta.dir}/..`,
          env: {
            ...process.env,
            DATABASE_PATH: importDatabasePath,
            PORT: "3000",
          },
          stderr: "pipe",
          stdout: "pipe",
        },
      );

      const timeout = setTimeout(() => child.kill(), 2_000);
      const exitCode = await child.exited;
      clearTimeout(timeout);

      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({
        before: { sigint: 0, sigterm: 0 },
        after: { sigint: 0, sigterm: 0 },
        exports: { createRestApp: "function", serveRest: "function" },
      });
      expect(existsSync(importDatabasePath)).toBe(false);
    } finally {
      cleanupTestDatabase(testDatabase);
    }
  });
});

describe("stock CLI configuration", () => {
  it.each([undefined, "   "])(
    "rejects a missing or blank API key before opening the database",
    async (apiKey) => {
      const testDatabase = createTestDatabase();
      const databasePath = join(
        testDatabase.directoryPath,
        "cli-must-not-open.sqlite",
      );
      testDatabase.database.close();
      const env = {
        ...process.env,
        DATABASE_PATH: databasePath,
        ...(apiKey === undefined
          ? { SETUPLESS_REST_API_KEY: undefined }
          : { SETUPLESS_REST_API_KEY: apiKey }),
      };

      try {
        const child = Bun.spawn([process.execPath, "src/cli.ts"], {
          cwd: `${import.meta.dir}/..`,
          env,
          stderr: "pipe",
          stdout: "pipe",
        });
        const timeout = setTimeout(() => child.kill(), 2_000);
        const exitCode = await child.exited;
        clearTimeout(timeout);

        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();

        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("SETUPLESS_REST_API_KEY is required");
        expect(stderr).not.toContain(databasePath);
        expect(existsSync(databasePath)).toBe(false);
      } finally {
        rmSync(testDatabase.directoryPath, {
          force: true,
          recursive: true,
        });
      }
    },
  );
});

describe("server lifecycle", () => {
  it("starts and stops idempotently on an ephemeral port", async () => {
    const testDatabase = createTestDatabase();
    const { databasePath, directoryPath } = testDatabase;
    testDatabase.database.close();
    let server: Awaited<ReturnType<typeof serveRest>> | undefined;

    try {
      const initialSigintListeners = process.listenerCount("SIGINT");
      const initialSigtermListeners = process.listenerCount("SIGTERM");
      server = await serveRest({
        config: { ...loadConfig({ DATABASE_PATH: databasePath }), port: 0 },
      });

      expect(server.port).toBeGreaterThan(0);
      expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners + 1);
      expect(process.listenerCount("SIGTERM")).toBe(
        initialSigtermListeners + 1,
      );

      const response = await fetch(`http://localhost:${server.port}/health`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });

      await Promise.all([server.stop(), server.stop()]);

      expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);
      expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
    } finally {
      await server?.stop();
      rmSync(directoryPath, { force: true, recursive: true });
    }
  });

  it("fails before listening when the database parent is missing", async () => {
    const testDatabase = createTestDatabase();
    const missingParent = join(testDatabase.directoryPath, "missing");
    const databasePath = join(missingParent, "database.sqlite");
    testDatabase.database.close();
    const initialSigintListeners = process.listenerCount("SIGINT");
    const initialSigtermListeners = process.listenerCount("SIGTERM");

    try {
      await expect(
        serveRest({
          config: loadConfig({ DATABASE_PATH: databasePath }),
        }),
      ).rejects.toThrow("DATABASE_PATH parent directory must already exist");
      expect(existsSync(missingParent)).toBe(false);
      expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);
      expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
    } finally {
      rmSync(testDatabase.directoryPath, { force: true, recursive: true });
    }
  });
});
