import { describe, expect, it } from "bun:test";
import { expectErrorCode, useE2EServer } from "./server";

describe("black-box filters and projections", () => {
  const server = useE2EServer();

  const cases = [
    ["filter-eq", "id=eq.1", [1]],
    ["filter-neq", "id=neq.1", [2, 3]],
    ["filter-gt", "priority=gt.2", [1, 3]],
    ["filter-gte", "priority=gte.3", [1, 3]],
    ["filter-lt", "priority=lt.3", [2]],
    ["filter-lte", "priority=lte.2", [2]],
    ["filter-like", "title=like.*contract", [1, 2]],
    ["filter-ilike", "title=ilike.write*", [1]],
    ["filter-in", "id=in.(1,2)", [1, 2]],
    ["filter-is-null", "metadata=is.null", [1, 2]],
    ["filter-is-boolean", "done=is.false", [1, 2]],
    ["filter-not", "done=not.is.true", [1, 2]],
    ["filter-and", "and=(priority.gte.2,done.is.false)", [1, 2]],
    ["filter-or", "or=(id.eq.1,id.eq.2)", [1, 2]],
    ["filter-not-group", "not=(priority.lt.2)", [1, 2, 3]],
  ] as const;

  for (const [id, query, expectedIds] of cases) {
    it(`[${id}] applies the documented operator`, async () => {
      const response = await server.request(
        `/tasks?${query}&select=id&order=id.asc`,
      );
      const rows = (await response.json()) as { id: number }[];

      expect(response.status).toBe(200);
      expect(rows.map((row) => row.id)).toEqual([...expectedIds]);
    });
  }

  it("[select-scalars] supports aliases, ordering, and bounded pagination", async () => {
    const response = await server.request(
      "/tasks?select=task_id:id,label:title&order=priority.desc.nullslast,id.asc&limit=1",
    );

    expect(await response.json()).toEqual([
      { task_id: 3, label: "Private task" },
    ]);
  });

  it("[filter-validation] rejects unknown fields and invalid controls before SQL", async () => {
    const unknown = await server.request("/tasks?missing=eq.1");
    const malformed = await server.request("/tasks?id=wat.1");
    const duplicate = await server.request("/tasks?limit=1&limit=2");
    const tooDeep = await server.request(
      "/tasks?and=(and=(and=(and=(and=(and=(id.eq.1))))))",
    );

    await expectErrorCode(unknown, "SLREST101");
    await expectErrorCode(malformed, "SLREST102");
    await expectErrorCode(duplicate, "SLREST103");
    await expectErrorCode(tooDeep, "SLREST110");
  });
});
