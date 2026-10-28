export function utcInstantFromDate(value) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}
