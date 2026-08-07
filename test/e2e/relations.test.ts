import { describe, expect, it } from "bun:test";
import { expectErrorCode, useE2EServer } from "./server";

describe("black-box relationship embedding", () => {
  const server = useE2EServer();

  it("[select-relations] embeds direct and inverse relationships", async () => {
    const direct = await server.request(
      "/tasks?select=id,project:projects!project_id(id,name)&order=id.asc",
    );
    const inverse = await server.request(
      "/projects?select=id,tasks(id,title,priority)&order=id.asc&tasks.order=priority.desc",
    );

    expect(await direct.json()).toEqual([
      { id: 1, project: { id: 10, name: "REST 0.1" } },
      { id: 2, project: { id: 10, name: "REST 0.1" } },
      { id: 3, project: { id: 11, name: "Private project" } },
    ]);
    expect(await inverse.json()).toEqual([
      {
        id: 10,
        tasks: [
          { id: 1, title: "Write contract", priority: 3 },
          { id: 2, title: "Review contract", priority: 2 },
        ],
      },
      {
        id: 11,
        tasks: [{ id: 3, title: "Private task", priority: 9 }],
      },
    ]);
  });

  it("[select-many-to-many] recursively embeds qualifying junctions", async () => {
    const response = await server.request(
      "/projects?id=eq.10&select=id,tasks(id,title,tags(id,label))&tasks.order=id.asc&tasks.tags.order=id.asc",
    );

    expect(await response.json()).toEqual([
      {
        id: 10,
        tasks: [
          {
            id: 1,
            title: "Write contract",
            tags: [
              { id: 20, label: "docs" },
              { id: 21, label: "hidden" },
            ],
          },
          { id: 2, title: "Review contract", tags: [] },
        ],
      },
    ]);
  });

  it("[relation-controls] keeps roots while filtering and paginating children", async () => {
    const response = await server.request(
      "/projects?select=id,work:tasks(id,priority)&order=id.asc&work.priority=gte.3&work.order=priority.desc&work.limit=1",
    );

    expect(await response.json()).toEqual([
      { id: 10, work: [{ id: 1, priority: 3 }] },
      { id: 11, work: [{ id: 3, priority: 9 }] },
    ]);
  });

  it("[relation-errors] uses stable missing and depth failures", async () => {
    const missing = await server.request("/projects?select=id,tags(id)");
    const deep = await server.request(
      "/projects?select=id,tasks(id,projects(id,tasks(id,projects(id,tasks(id,projects(id))))))",
    );

    await expectErrorCode(missing, "SLREST202");
    await expectErrorCode(deep, "SLREST110");
  });
});
