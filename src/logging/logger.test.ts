import { describe, expect, it } from "bun:test";
import { createJsonLogger } from "./logger";

describe("createJsonLogger", () => {
  it("writes one valid JSON object per enabled record", () => {
    const lines: string[] = [];
    const logger = createJsonLogger("info", (line) => lines.push(line));

    logger.debug({ event: "hidden" });
    logger.info({ event: "request.completed", status: 200 });
    logger.error({ event: "server.failed" });

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { level: "info", event: "request.completed", status: 200 },
      { level: "error", event: "server.failed" },
    ]);
  });
});
