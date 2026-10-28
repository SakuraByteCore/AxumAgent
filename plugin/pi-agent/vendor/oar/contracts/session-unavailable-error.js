/**
 * `session({ resume })` found the native conversation but the runtime will
 * not open it now. Only the documented runtime signals produce this error;
 * `message` keeps the runtime's own words. No turn exists yet: this is not a
 * FailureClass. See docs/spec/runtime-matrix.md#unavailable-resume-targets.
 */
export class SessionUnavailableError extends Error {
    name = "SessionUnavailableError";
    sessionId;
    reason;
    constructor(sessionId, message, details) {
        super(message, { cause: { method: details.method, native: details.native } });
        this.sessionId = sessionId;
        this.reason = details.reason;
    }
}
