import { describe, expect, it } from "bun:test";

import { app } from "./index";

describe("GET /health", () => {
  it("returns an ok status", async () => {
    const response = await app.handle(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
