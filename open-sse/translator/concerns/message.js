import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array: a lone text part becomes a plain string,
// otherwise the array is returned as-is. Matches existing translator behavior.
export function collapseTextParts(parts) {
  return parts.length === 1 && parts[0].type === OPENAI_BLOCK.TEXT ? parts[0].text : parts;
}

// Some strict OpenAI-compatible endpoints (Cloudflare Workers AI) reject any
// message whose `content` is not a plain string: a content-part array → 400, a
// null content (assistant tool-call turns) → 400. Flatten both. Non-text parts
// (images) have no representation on these endpoints and become a placeholder.
export function flattenMessageContent(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const { content } = msg;
    if (typeof content === "string") return msg;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part?.type === OPENAI_BLOCK.TEXT) return part.text || "";
          return "";
        })
        .join("");
      const hadParts = content.length > 0;
      return { ...msg, content: text || (hadParts ? "[image]" : "") };
    }
    if (content === null || content === undefined) return { ...msg, content: "" };
    return msg;
  });
}
