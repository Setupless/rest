import { describe, expect, it } from "bun:test";
import { expectErrorCode, useE2EServer } from "./server";

describe("black-box Prefer behavior", () => {
  const server = useE2EServer();

  it("[prefer-lenient] ignores unknown preferences", async () => {
    const response = await server.request("/tasks?limit=0", {
      headers: { Prefer: "future-option=yes" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("[prefer-strict] rejects unknown and inapplicable preferences", async () => {
    const unknown = await server.request("/tasks", {
      headers: { Prefer: "handling=strict, future-option=yes" },
    });
    const rootCount = await server.request("/", {
      headers: { Prefer: "handling=strict, count=exact" },
    });

    await expectErrorCode(unknown, "SLREST104");
    await expectErrorCode(rootCount, "SLREST104");
  });

  it("[prefer-canonical] applies first values in canonical response order", async () => {
    const response = await server.request("/tasks?limit=1", {
      headers: {
        Prefer: "count=exact, handling=strict, count=ignored, handling=lenient",
      },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("Preference-Applied")).toBe(
      "handling=strict, count=exact",
    );
  });

  it("[prefer-mutation-count] reports affected rows without adding a body", async () => {
    const response = await server.request("/tasks?id=eq.999", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=minimal, count=exact",
      },
      body: JSON.stringify({ done: true }),
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Preference-Applied")).toBe(
      "return=minimal, count=exact",
    );
    expect(response.headers.get("Content-Range")).toBe("*/0");
    expect(await response.text()).toBe("");
  });
});
