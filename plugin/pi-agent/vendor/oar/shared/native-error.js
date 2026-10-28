import { asRecord } from "./json.js";
/** Only decoded protocol JSON, never an arbitrary Error, request parameters or spawn arguments. */
function redactNative(value, redact) {
    if (typeof value === "string") {
        return redact(value);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactNative(entry, redact));
    }
    const record = asRecord(value);
    return record === null ? value : redactRecord(record, redact);
}
function redactRecord(record, redact) {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [redact(key), redactNative(value, redact)]));
}
/** Diagnostic context for a failed native call, also usable before a Session exists to hold records. */
export function nativeErrorCause(method, native, redact) {
    return { method, native: redactRecord(native, redact) };
}
