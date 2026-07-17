"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AxumRuntimeSession = void 0;
const events_1 = require("./events");
const protocol_1 = require("./protocol");
const turn_1 = require("./turn");
class AxumRuntimeSession {
    options;
    id;
    events = new events_1.AxumEventBus();
    submissions = [];
    constructor(options) {
        this.options = options;
        this.id = `session-${Date.now().toString(36)}`;
        this.events.emit("session_configured", {
            sessionId: this.id,
            cwd: options.cwd ?? process.cwd(),
            mode: options.mode ?? "build",
            providerModel: options.provider.model,
        });
    }
    enqueueUserInput(prompt) {
        const submission = (0, protocol_1.createSubmission)("user_input", { prompt });
        this.submissions.push(submission);
        return submission;
    }
    async runUserTurn(prompt, signal) {
        this.enqueueUserInput(prompt);
        return (0, turn_1.runCodexLikeTurn)({
            config: this.options.config,
            provider: this.options.provider,
            eventBus: this.events,
            mode: this.options.mode,
            cwd: this.options.cwd,
            maxToolIterations: this.options.maxToolIterations,
            systemPrompt: this.options.systemPrompt,
        }, prompt, signal);
    }
    submissionSnapshot() {
        return [...this.submissions];
    }
}
exports.AxumRuntimeSession = AxumRuntimeSession;
