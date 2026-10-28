import { utcInstantFromDate } from "./instant.js";
/** Parse JSON text; undefined (never a legal JSON value) signals invalid JSON. */
export function parseJson(text) {
    try {
        const value = JSON.parse(text);
        return value;
    }
    catch {
        return undefined;
    }
}
export function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : null;
}
export function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
/** Narrow an epoch timestamp in seconds or milliseconds to an ISO-8601 instant. */
export function asEpochInstant(value) {
    const raw = asNumber(value);
    if (raw === null) {
        return null;
    }
    const instant = new Date(raw >= 1_000_000_000_000 ? raw : raw * 1000);
    return utcInstantFromDate(instant);
}
/** Array members that are JSON objects; non-arrays and non-object members are dropped. */
export function asRecordList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const entries = value;
    const records = [];
    for (const entry of entries) {
        const record = asRecord(entry);
        if (record !== null) {
            records.push(record);
        }
    }
    return records;
}
