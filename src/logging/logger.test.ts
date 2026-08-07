import { describe, expect, it } from "bun:test";
import { createJsonLogger } from "./logger";

describe("createJsonLogger", () => {
  it("writes one valid JSON object per enabled record", () => {
    const lines: string[] = [];
    const logger = createJsonLogger("info", (line) => lines.push(line));

    logger.debug({ event: "hidden" });
    logger.info({ event: "request.completed", status: 200 });
    logger.error({ event: "server.failed", level: "debug" });

    expect(lines).toHaveLength(2);
    const records = lines.map((line) => JSON.parse(line)) as Array<
      Record<string, unknown>
    >;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      level: "info",
      event: "request.completed",
      status: 200,
    });
    expect(records[1]).toMatchObject({
      level: "error",
      event: "server.failed",
    });
    expect(records.every((record) => typeof record.time === "string")).toBe(
      true,
    );
  });
});
