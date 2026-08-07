import { describe, expect, it } from "bun:test";
import { limitRequestBody } from "./body-limit";
import { RestError } from "./errors";

describe("limitRequestBody", () => {
  it("rejects a declared oversized body without consuming it", async () => {
    const request = new Request("http://setupless.test/records", {
      method: "POST",
      headers: { "Content-Length": "100" },
      body: "{}",
    });

    await expect(limitRequestBody(request, 10)).rejects.toMatchObject({
      code: "SLREST108",
      status: 413,
      details: "The request body exceeds the configured limit of 10 bytes.",
    });
  });

  it("bounds streamed bodies whose length is not declared", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
        controller.enqueue(new TextEncoder().encode("67890"));
        controller.close();
      },
    });
    const request = new Request("http://setupless.test/records", {
      method: "POST",
      body: stream,
    });

    try {
      await limitRequestBody(request, 9);
      throw new Error("Expected the streamed body to exceed its limit");
    } catch (error) {
      expect(error).toBeInstanceOf(RestError);
      expect(error).toMatchObject({ code: "SLREST108", status: 413 });
    }
  });

  it("replays an accepted body unchanged for downstream parsing", async () => {
    const request = new Request("http://setupless.test/records", {
      method: "POST",
      body: '{"ok":true}',
    });
    const bounded = await limitRequestBody(request, 11);

    expect(await bounded.text()).toBe('{"ok":true}');
  });
});
