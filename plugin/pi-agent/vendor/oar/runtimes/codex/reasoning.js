import { asRecord } from "../../shared/json.js";
function textParts(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((part) => {
        const text = asRecord(part)?.text;
        return typeof text === "string" && text.length > 0 ? [text] : [];
    });
}
export function codexReasoningContent(item) {
    if (item?.type !== "reasoning") {
        return null;
    }
    const text = [...textParts(item.summary), ...textParts(item.content)].join("\n");
    if (text.length > 0) {
        return { kind: "text", text };
    }
    return typeof item.encrypted_content === "string"
        ? { kind: "redacted" }
        : { kind: "empty" };
}
