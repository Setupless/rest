import { describe, expect, it } from "bun:test";
import { expectErrorCode, useE2EServer } from "./server";

describe("black-box reads, pagination, and counts", () => {
  const server = useE2EServer();

  it("[read-basic] returns deterministic selected rows and range headers", async () => {
    const response = await server.request(
      "/tasks?select=id,title&order=id.asc&limit=2",
      { headers: { "X-Request-Id": "read-basic" } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBe("read-basic");
    expect(response.headers.get("Range-Unit")).toBe("items");
    expect(response.headers.get("Content-Range")).toBe("0-1/*");
    expect(await response.json()).toEqual([
      { id: 1, title: "Write contract" },
      { id: 2, title: "Review contract" },
    ]);
  });

  it("[read-head] returns GET metadata without a body", async () => {
    const response = await server.request("/tasks?limit=1", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Range")).toBe("0-0/*");
    expect(await response.text()).toBe("");
  });

  it("[resource-options] advertises table and view methods", async () => {
    const table = await server.request("/tasks", { method: "OPTIONS" });
    const view = await server.request("/open_tasks", { method: "OPTIONS" });

    expect(table.status).toBe(204);
    expect(table.headers.get("Allow")).toBe(
      "GET, HEAD, OPTIONS, POST, PATCH, DELETE, PUT",
    );
    expect(view.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("[range-items] applies exact inclusive item ranges", async () => {
    const response = await server.request("/tasks?order=id.asc&select=id", {
      headers: { Range: "0-0", "Range-Unit": "items", Prefer: "count=exact" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("0-0/3");
    expect(response.headers.get("Preference-Applied")).toBe("count=exact");
    expect(await response.json()).toEqual([{ id: 1 }]);
  });

  it("[pagination-query] distinguishes successful empty offsets and invalid ranges", async () => {
    const empty = await server.request("/tasks?offset=20", {
      headers: { Prefer: "count=exact" },
    });
    const invalid = await server.request("/tasks", {
      headers: { Range: "20-30", Prefer: "count=exact" },
    });

    expect(empty.status).toBe(200);
    expect(empty.headers.get("Content-Range")).toBe("*/3");
    expect(await empty.json()).toEqual([]);
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("Content-Range")).toBe("*/3");
    await expectErrorCode(invalid, "SLREST109");
  });

  it("[singular-response] requires exactly one row", async () => {
    const headers = { Accept: "application/vnd.pgrst.object+json" };
    const one = await server.request("/tasks?id=eq.1", { headers });
    const zero = await server.request("/tasks?id=eq.99", { headers });
    const many = await server.request("/tasks", { headers });

    expect(one.status).toBe(200);
    expect((await one.json()) as { id: number }).toHaveProperty("id", 1);
    await expectErrorCode(zero, "SLREST106");
    await expectErrorCode(many, "SLREST106");
  });

  it("[data-representation] serializes SQLite values without precision loss", async () => {
    const response = await server.request("/representations");

    expect(await response.json()).toEqual([
      {
        id: 1,
        unsafe_integer: "9007199254740992",
        enabled: true,
        payload: { ok: true },
        bytes: "\\x00a5ff",
      },
    ]);
  });
});
