/**
 * pi-response-guard — guard-logic regression tests
 *
 * Verifies that real runtime-observed provider errors (backed by actual
 * session JSONL logs) now trigger an automatic continue, while user-cancel
 * and normal-completion cases are left untouched.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	DEFAULT_CONFIG,
	getAutoContinueReason,
	matchesConfiguredError,
	normalizeConfig,
	shouldTerminalAutoContinue,
} from "../plugin/pi-response-guard/guard-logic.ts";

function guardMessage(stopReason, errorMessage, content) {
	return {
		stopReason,
		role: "assistant",
		errorMessage,
		content: content ?? [{ type: "text", text: "" }],
		usage: { input: 0, output: 0 },
	};
}

// Real errorMessage values observed in production session logs.
const OBSERVED_ERRORS = [
	["Connection error.", "error"],
	["Request timed out.", "error"],
	['400: {"message":"Bad Request","type":"api_error"}', "error"],
	['404: {"message":"Not Found","type":"api_error"}', "error"],
	["Rate limit reached", "error"],
	["fetch failed: ECONNRESET", "error"],
];

test("default errorPatterns cover all runtime-observed provider errors", () => {
	for (const [text] of OBSERVED_ERRORS) {
		assert.equal(
			matchesConfiguredError(text, DEFAULT_CONFIG.errorPatterns),
			true,
			`expected pattern to cover: ${JSON.stringify(text)}`,
		);
	}
});

test("error stopReasons with observed errorMessages trigger an auto continue", () => {
	for (const [errorMessage] of OBSERVED_ERRORS) {
		const reason = getAutoContinueReason(
			guardMessage("error", errorMessage),
			DEFAULT_CONFIG,
			{ previousMessageRole: "user", previousMessageWasAutoRetry: false },
		);
		assert.ok(reason, `expected continue for error: ${JSON.stringify(errorMessage)}`);
		assert.equal(reason.kind, "error");
	}
});

test("error stopReason without a configured pattern does NOT trigger continue", () => {
	const reason = getAutoContinueReason(
		guardMessage("error", "SomeWidget: unimplemented in widget version 9"),
		DEFAULT_CONFIG,
		{ previousMessageRole: "user" },
	);
	assert.equal(reason, undefined);
});

test("user-cancel stopReason aborted does NOT trigger continue", () => {
	const reason = getAutoContinueReason(
		guardMessage("aborted", "Operation aborted"),
		DEFAULT_CONFIG,
		{ previousMessageRole: "user" },
	);
	assert.equal(reason, undefined, "user-initiated aborted must not auto-continue");
});

test("length stopReasons trigger continue when enabled", () => {
	const reason = getAutoContinueReason(
		guardMessage("length", undefined),
		DEFAULT_CONFIG,
		{ previousMessageRole: "user" },
	);
	assert.ok(reason);
	assert.equal(reason.kind, "length");
});

test("normal completion with visible output does NOT trigger continue", () => {
	const reason = getAutoContinueReason(
		guardMessage("stop", undefined, [{ type: "text", text: "Final answer." }]),
		DEFAULT_CONFIG,
		{ previousMessageRole: "user" },
	);
	assert.equal(reason, undefined);
});

test("bundled config.json errorPatterns stay in sync with DEFAULT_CONFIG", () => {
	// The shipped config must include every default pattern so a deployed
	// bundle does not silently lose coverage for the observed errors.
	const { dirname, join } = path;
	const here = dirname(fileURLToPath(import.meta.url));
	const configPath = join(here, "..", "plugin", "pi-response-guard", "config.json");
	const bundled = JSON.parse(fs.readFileSync(configPath, "utf8"));
	for (const pattern of DEFAULT_CONFIG.errorPatterns) {
		assert.ok(
			bundled.errorPatterns.includes(pattern),
			`config.json missing default pattern: ${JSON.stringify(pattern)}`,
		);
	}
	for (const [text] of OBSERVED_ERRORS) {
		assert.equal(
			matchesConfiguredError(text, bundled.errorPatterns),
			true,
			`bundled config.json should cover: ${JSON.stringify(text)}`,
		);
	}
});

test("normalizeConfig preserves defaults when raw is empty", () => {
	const normalized = normalizeConfig({});
	assert.deepEqual(normalized.errorPatterns, DEFAULT_CONFIG.errorPatterns);
	assert.equal(normalized.enabled, true);
	assert.equal(normalized.maxConsecutiveAutoRetries, 10);
});

test("terminal fallback sends continue after retries exhaust (pending drained)", () => {
	const reason = shouldTerminalAutoContinue(DEFAULT_CONFIG, {
		lastMessage: guardMessage("error", "Connection error."),
		hasPendingMessages: false,
		consecutiveAutoRetries: 0,
	});
	assert.ok(reason, "expected terminal continue reason");
	assert.equal(reason.kind, "error");
});

test("terminal fallback does NOT send while messages are still pending", () => {
	const reason = shouldTerminalAutoContinue(DEFAULT_CONFIG, {
		lastMessage: guardMessage("error", "Connection error."),
		hasPendingMessages: true,
		consecutiveAutoRetries: 0,
	});
	assert.equal(reason, undefined);
});

test("terminal fallback does NOT double-send when fast path already handled it", () => {
	const reason = shouldTerminalAutoContinue(DEFAULT_CONFIG, {
		lastMessage: guardMessage("error", "Connection error."),
		hasPendingMessages: false,
		alreadyHandled: true,
		consecutiveAutoRetries: 0,
	});
	assert.equal(reason, undefined);
});

test("terminal fallback skipped when retry limit reached or disabled", () => {
	const noRetry = shouldTerminalAutoContinue(
		{ ...DEFAULT_CONFIG, maxConsecutiveAutoRetries: 2 },
		{
			lastMessage: guardMessage("error", "Connection error."),
			hasPendingMessages: false,
			consecutiveAutoRetries: 2,
		},
	);
	assert.equal(noRetry, undefined);

	const disabled = shouldTerminalAutoContinue(
		{ ...DEFAULT_CONFIG, enabled: false },
		{
			lastMessage: guardMessage("error", "Connection error."),
			hasPendingMessages: false,
			consecutiveAutoRetries: 0,
		},
	);
	assert.equal(disabled, undefined);
});

test("terminal fallback skipped for non-retryable or non-assistant messages", () => {
	const notRetryable = shouldTerminalAutoContinue(DEFAULT_CONFIG, {
		lastMessage: { role: "assistant", stopReason: "function_call" },
		hasPendingMessages: false,
	});
	assert.equal(notRetryable, undefined);

	const userMsg = shouldTerminalAutoContinue(DEFAULT_CONFIG, {
		lastMessage: { role: "user", content: [{ type: "text", text: "hi" }] },
		hasPendingMessages: false,
	});
	assert.equal(userMsg, undefined);

	const already = shouldTerminalAutoContinue(DEFAULT_CONFIG, {
		lastMessage: guardMessage("error", "Connection error."),
		hasPendingMessages: false,
		alreadyHandled: true,
	});
	assert.equal(already, undefined);
});