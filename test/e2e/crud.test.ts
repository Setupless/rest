import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type E2EServer, expectErrorCode, startE2EServer } from "./server";

describe("black-box transactional CRUD", () => {
  let server: E2EServer;
  const jsonHeaders = { "Content-Type": "application/json" };

  beforeEach(async () => {
    server = await startE2EServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("[insert-single] inserts defaults and returns a representation", async () => {
    const response = await server.request(
      "/tasks?select=id,title,priority,done,generated_label",
      {
        method: "POST",
        headers: {
          ...jsonHeaders,
          Prefer: "missing=default, return=representation",
        },
        body: JSON.stringify({
          id: 10,
          project_id: 10,
          title: "Publish contract",
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual([
      {
        id: 10,
        title: "Publish contract",
        priority: 0,
        done: false,
        generated_label: "Publish contract!",
      },
    ]);
  });

  it("[insert-bulk] commits every row atomically and reports exact counts", async () => {
    const response = await server.request("/tasks?select=id,title", {
      method: "POST",
      headers: {
        ...jsonHeaders,
        Prefer: "missing=default, return=representation, count=exact",
      },
      body: JSON.stringify([
        { id: 11, project_id: 10, title: "Test examples" },
        { id: 12, project_id: 10, title: "Tag release" },
      ]),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Range")).toBe("0-1/2");
    expect(await response.json()).toEqual([
      { id: 11, title: "Test examples" },
      { id: 12, title: "Tag release" },
    ]);
  });

  it("[upsert-post] merges on a declared unique conflict target", async () => {
    const response = await server.request(
      "/tasks?on_conflict=project_id,title&select=id,priority",
      {
        method: "POST",
        headers: {
          ...jsonHeaders,
          Prefer:
            "missing=default, resolution=merge-duplicates, return=representation",
        },
        body: JSON.stringify({
          project_id: 10,
          title: "Write contract",
          priority: 4,
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual([{ id: 1, priority: 4 }]);
  });

  it("[update-filtered] and [update-full-table] support bounded PATCH", async () => {
    const filtered = await server.request("/tasks?id=eq.2&select=id,done", {
      method: "PATCH",
      headers: { ...jsonHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ done: true }),
    });
    const guarded = await server.request("/tasks", {
      method: "PATCH",
      headers: {
        ...jsonHeaders,
        Prefer: "max-affected=1, return=minimal",
      },
      body: JSON.stringify({ priority: 0 }),
    });

    expect(await filtered.json()).toEqual([{ id: 2, done: true }]);
    await expectErrorCode(guarded, "SLREST111");
  });

  it("[delete-filtered] returns deleted pre-images", async () => {
    const response = await server.request("/tasks?id=eq.3&select=id,title", {
      method: "DELETE",
      headers: { Prefer: "return=representation" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 3, title: "Private task" }]);
  });

  it("[upsert-put] inserts one row addressed by its complete primary key", async () => {
    const response = await server.request("/tasks?id=eq.30&select=id,title", {
      method: "PUT",
      headers: {
        ...jsonHeaders,
        Prefer: "missing=default, return=representation",
      },
      body: JSON.stringify({
        id: 30,
        project_id: 10,
        title: "Archive contract",
      }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("Location")).toBe("/tasks?id=eq.30");
    expect(await response.json()).toEqual([
      { id: 30, title: "Archive contract" },
    ]);
  });

  it("[return-headers-only] emits a stable primary-key location", async () => {
    const response = await server.request("/tasks", {
      method: "POST",
      headers: {
        ...jsonHeaders,
        Prefer: "missing=default, return=headers-only",
      },
      body: JSON.stringify({
        id: 31,
        project_id: 10,
        title: "Link result",
      }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("Location")).toBe("/tasks?id=eq.31");
    expect(await response.text()).toBe("");
  });

  it("[mutation-atomicity] rolls bulk constraint failures back completely", async () => {
    const response = await server.request("/tasks", {
      method: "POST",
      headers: { ...jsonHeaders, Prefer: "missing=default" },
      body: JSON.stringify([
        { id: 50, project_id: 10, title: "Atomic first" },
        { id: 51, project_id: 999, title: "Atomic second" },
      ]),
    });
    const rows = await server.request("/tasks?id=in.(50,51)&select=id");

    await expectErrorCode(response, "SLREST401");
    expect(await rows.json()).toEqual([]);
  });

  it("[read-only-resources] rejects view mutations with the advertised methods", async () => {
    const response = await server.request("/open_tasks", {
      method: "DELETE",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    await expectErrorCode(response, "SLREST204");
  });

  it("[delete-full-table] deliberately permits guarded full-table deletion", async () => {
    const response = await server.request("/disposable", {
      method: "DELETE",
      headers: { Prefer: "max-affected=100, return=minimal, count=exact" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Content-Range")).toMatch(/^0-\d+\/\d+$/);
    expect(await response.text()).toBe("");
    expect(await (await server.request("/disposable")).json()).toEqual([]);
  });
});
