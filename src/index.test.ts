import { describe, expect, it } from "bun:test";

import { TEST_USERS, useTestFixture } from "../test/fixtures";

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
