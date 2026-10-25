import { describe, expect, it } from "vitest";
import { flattenMessageContent } from "../../open-sse/translator/concerns/message.js";
import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

describe("flattenMessageContent", () => {
  it("collapses a text-only content-part array to a string", () => {
    const out = flattenMessageContent([
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "text", text: " world" }] },
    ]);
    expect(out[0].content).toBe("hello world");
  });

  it("replaces image-only parts with a placeholder", () => {
    const out = flattenMessageContent([
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:..." } }] },
    ]);
    expect(out[0].content).toBe("[image]");
  });

  it("leaves plain string content untouched", () => {
    const out = flattenMessageContent([{ role: "user", content: "hi" }]);
    expect(out[0].content).toBe("hi");
  });

  it("coerces null content (assistant tool-call turn) to an empty string", () => {
    const out = flattenMessageContent([
      { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
    ]);
    expect(out[0].content).toBe("");
  });

  it("coerces undefined content to an empty string", () => {
    const out = flattenMessageContent([{ role: "assistant", tool_calls: [{ id: "1" }] }]);
    expect(out[0].content).toBe("");
  });

  it("does not mutate the input messages", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "x" }] }];
    flattenMessageContent(messages);
    expect(Array.isArray(messages[0].content)).toBe(true);
  });
});

describe("stripUnsupportedParams flattens Cloudflare Workers AI content", () => {
  it("flattens arrays and coerce null content for cloudflare-ai only", () => {
    const body = {
      messages: [
        { role: "system", content: [{ type: "text", text: "You are terse." }] },
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
      ],
    };
    stripUnsupportedParams("cloudflare-ai", "@cf/meta/llama-3.2-3b-instruct", body);
    expect(body.messages.every((m) => typeof m.content === "string")).toBe(true);
    expect(body.messages[0].content).toBe("You are terse.");
    expect(body.messages[2].content).toBe("");
  });

  it("leaves other providers' array content intact", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
    stripUnsupportedParams("openai", "gpt-4o-mini", body);
    expect(Array.isArray(body.messages[0].content)).toBe(true);
  });
});
