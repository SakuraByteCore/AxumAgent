"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSubmission = createSubmission;
function createSubmission(op, payload) {
    return {
        id: `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        op,
        payload,
        createdAt: new Date().toISOString(),
    };
}
