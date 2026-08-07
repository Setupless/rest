import type { RestAuthPlugin } from "../../src/auth/types";
import { loadConfig } from "../../src/config";
import { createJsonLogger } from "../../src/logging/logger";
import { serveRest } from "../../src/server";

const auth: RestAuthPlugin = {
  /** Applies deterministic restrictive policies for black-box plugin coverage. */
  authorize({ request, table, operation }) {
    const credential = request.headers.get("X-E2E-Auth");

    if (credential === "throw") {
      throw new Error("plugin-secret-must-never-escape");
    }
    if (credential === "deny-401") return { allowed: false, status: 401 };
    if (credential !== "allow") return { allowed: false };

    if (table === "tasks") {
      return {
        allowed: true,
        ...(operation === "select" ||
        operation === "update" ||
        operation === "delete"
          ? {
              using: {
                field: "project_id",
                operator: "eq",
                value: 10,
              } as const,
            }
          : {}),
        ...(operation === "insert" || operation === "update"
          ? {
              check: {
                field: "priority",
                operator: "lte",
                value: 5,
              } as const,
            }
          : {}),
      };
    }

    if (table === "projects" && operation === "select") {
      return {
        allowed: true,
        using: { field: "id", operator: "eq", value: 10 },
      };
    }
    if (table === "tags" && operation === "select") {
      return {
        allowed: true,
        using: { field: "label", operator: "neq", value: "hidden" },
      };
    }
    if (table === "task_tags" && operation === "select") {
      return {
        allowed: true,
        using: { field: "visible", operator: "eq", value: true },
      };
    }

    return { allowed: true };
  },
};

try {
  const config = loadConfig();
  await serveRest({
    config,
    auth,
    logger: createJsonLogger(config.logLevel),
  });
} catch {
  console.error(
    JSON.stringify({ event: "server.start_failed", message: "fixture failed" }),
  );
  process.exitCode = 1;
}
