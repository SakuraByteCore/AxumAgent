/** Refuse an input with neither text nor images before contacting the runtime. Whitespace is left intact. */
export function emptyInputRefusal(body) {
    if ((body.kind === "prompt" || body.kind === "steer" || body.kind === "queue")
        && body.input === "" && (body.images?.length ?? 0) === 0) {
        return { kind: "rejected", code: "unsupported", reason: "empty input: give text or images" };
    }
    return null;
}
