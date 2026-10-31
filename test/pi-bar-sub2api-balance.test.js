import assert from "node:assert/strict";
import test from "node:test";

import {
	BalanceCache,
	fetchSub2ApiBalance,
	isSub2ApiPayload,
	parseUsagePayload,
	probeSub2ApiBalance,
	usageUrl,
} from "../plugin/pi-bar/sub2api-balance.ts";

test("usageUrl maps a provider base URL to the Sub2API usage endpoint", () => {
	assert.equal(usageUrl("https://ss2a.top/v1"), "https://ss2a.top/v1/usage");
	assert.equal(usageUrl("https://ss2a.top/v1/"), "https://ss2a.top/v1/usage");
	assert.equal(usageUrl("https://ss2a.top"), "https://ss2a.top/v1/usage");
	assert.equal(usageUrl("https://ss2a.top/openai"), "https://ss2a.top/openai/v1/usage");
	assert.equal(usageUrl("not a url"), "");
	assert.equal(usageUrl(""), "");
});

test("parseUsagePayload renders wallet, quota and unlimited remainders", () => {
	const wallet = parseUsagePayload({ mode: "unrestricted", unit: "USD", remaining: 12.3467, balance: 12.3467 });
	assert.equal(wallet.label, "$12.35");
	assert.equal(wallet.value, 12.3467);
	assert.equal(wallet.mode, "unrestricted");

	const quota = parseUsagePayload({
		mode: "quota_limited",
		unit: "USD",
		remaining: 8.2,
		quota: { limit: 10, used: 1.8, remaining: 8.2, unit: "USD" },
	});
	assert.equal(quota.label, "$8.20 quota");

	const unlimited = parseUsagePayload({ mode: "unrestricted", unit: "USD", remaining: -1 });
	assert.equal(unlimited.label, "∞");
	assert.equal(unlimited.value, null);

	// Unknown schema or no remainder: the balance is hidden, never faked.
	assert.equal(parseUsagePayload({ mode: "unknown", remaining: 5 }), undefined);
	assert.equal(parseUsagePayload({ mode: "quota_limited", rate_limits: [] }), undefined);
	assert.equal(parseUsagePayload(null), undefined);
});

test("isSub2ApiPayload only accepts the Sub2API usage fingerprint", () => {
	assert.equal(isSub2ApiPayload({ mode: "quota_limited" }), true);
	assert.equal(isSub2ApiPayload({ mode: "unrestricted" }), true);
	assert.equal(isSub2ApiPayload({ mode: "other" }), false);
	assert.equal(isSub2ApiPayload({ total: 12 }), false);
	assert.equal(isSub2ApiPayload(null), false);
});

test("fetchSub2ApiBalance sends the key as a bearer header and never in the URL", async () => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		return new Response(JSON.stringify({ mode: "unrestricted", unit: "USD", remaining: 3.5, balance: 3.5 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	const snapshot = await fetchSub2ApiBalance({ baseUrl: "https://ss2a.top/v1", apiKey: "sk-test-key", fetchImpl });
	assert.equal(snapshot.label, "$3.50");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://ss2a.top/v1/usage");
	assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test-key");
	assert.ok(!calls[0].url.includes("sk-test-key"));
});

test("fetchSub2ApiBalance hides the balance on errors and on plaintext remotes", async () => {
	const unauthorized = async () => new Response("{}", { status: 401 });
	assert.equal(await fetchSub2ApiBalance({ baseUrl: "https://ss2a.top/v1", apiKey: "sk-test", fetchImpl: unauthorized }), undefined);

	const broken = async () => {
		throw new Error("network down");
	};
	assert.equal(await fetchSub2ApiBalance({ baseUrl: "https://ss2a.top/v1", apiKey: "sk-test", fetchImpl: broken }), undefined);

	const mustNotRun = async () => {
		throw new Error("plaintext remote must not be queried");
	};
	assert.equal(await fetchSub2ApiBalance({ baseUrl: "http://ss2a.top/v1", apiKey: "sk-test", fetchImpl: mustNotRun }), undefined);
});

test("probeSub2ApiBalance reports why a balance is missing", async () => {
	const ok = await probeSub2ApiBalance({
		baseUrl: "https://ss2a.top/v1",
		apiKey: "sk-test",
		fetchImpl: async () => new Response(JSON.stringify({ mode: "unrestricted", unit: "USD", remaining: -1 }), { status: 200 }),
	});
	assert.equal(ok.reason, "ok");
	assert.equal(ok.status, 200);
	assert.equal(ok.snapshot.label, "∞");

	const foreign = await probeSub2ApiBalance({
		baseUrl: "https://example.com/v1",
		apiKey: "sk-test",
		fetchImpl: async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }),
	});
	assert.equal(foreign.reason, "not-sub2api");
	assert.equal(foreign.snapshot, undefined);

	const denied = await probeSub2ApiBalance({
		baseUrl: "https://ss2a.top/v1",
		apiKey: "sk-test",
		fetchImpl: async () => new Response("{}", { status: 401 }),
	});
	assert.equal(denied.reason, "http-error");
	assert.equal(denied.status, 401);

	const offline = await probeSub2ApiBalance({
		baseUrl: "https://ss2a.top/v1",
		apiKey: "sk-test",
		fetchImpl: async () => {
			throw new Error("network down");
		},
	});
	assert.equal(offline.reason, "network-error");
	assert.equal(offline.status, 0);
});

test("BalanceCache serves a probe inside the TTL and refetches after invalidate", async () => {
	const cache = new BalanceCache(60_000, 300_000);
	let calls = 0;
	const loader = async () => {
		calls += 1;
		return { status: 200, reason: "ok", snapshot: { label: "$1.00", mode: "unrestricted", value: 1, unit: "USD" } };
	};
	assert.equal((await cache.get("k", loader)).snapshot.label, "$1.00");
	assert.equal((await cache.get("k", loader)).snapshot.label, "$1.00");
	assert.equal(calls, 1);
	cache.invalidate();
	await cache.get("k", loader);
	assert.equal(calls, 2);
});

test("BalanceCache caches failures for the error TTL", async () => {
	const cache = new BalanceCache(60_000, 300_000);
	let calls = 0;
	const loader = async () => {
		calls += 1;
		return { status: 404, reason: "not-sub2api" };
	};
	assert.equal((await cache.get("k", loader)).reason, "not-sub2api");
	assert.equal((await cache.get("k", loader)).reason, "not-sub2api");
	assert.equal(calls, 1);
});

test("BalanceCache force bypasses the success TTL but keeps the negative cache", async () => {
	const cache = new BalanceCache(60_000, 300_000);
	let calls = 0;
	const loader = async () => {
		calls += 1;
		return { status: 200, reason: "ok", snapshot: { label: "$1.00", mode: "unrestricted", value: 1, unit: "USD" } };
	};
	await cache.get("k", loader);
	await cache.get("k", loader);
	assert.equal(calls, 1);
	await cache.get("k", loader, { force: true });
	assert.equal(calls, 2);

	let failures = 0;
	const failing = async () => {
		failures += 1;
		return { status: 404, reason: "not-sub2api" };
	};
	await cache.get("bad", failing);
	await cache.get("bad", failing, { force: true });
	assert.equal(failures, 1);
});

test("BalanceCache keeps a transient network failure cached only briefly", async () => {
	// A transport hiccup must not hide the balance for the whole error TTL.
	const cache = new BalanceCache(60_000, 300_000, 0);
	let calls = 0;
	const flaky = async () => {
		calls += 1;
		return { status: 0, reason: "network-error" };
	};
	await cache.get("net", flaky);
	await cache.get("net", flaky);
	assert.equal(calls, 2);
});

test("BalanceCache retryFailed re-probes a cached failure on demand", async () => {
	const cache = new BalanceCache(60_000, 300_000);
	let calls = 0;
	const failing = async () => {
		calls += 1;
		return { status: 404, reason: "not-sub2api" };
	};
	await cache.get("bad", failing);
	await cache.get("bad", failing, { force: true, retryFailed: true });
	assert.equal(calls, 2);
});

test("BalanceCache retains a marked recent balance only for transient failures", async (t) => {
	let now = 1000;
	t.mock.method(Date, "now", () => now);
	const cache = new BalanceCache(60_000, 300_000, 15_000);
	const snapshot = { label: "$1.00", value: 1, mode: "unrestricted", unit: "USD" };
	const success = async () => ({ status: 200, reason: "ok", snapshot });
	await cache.get("k", success);
	for (const status of [0, 429, 503]) {
		const probe = await cache.get("k", async () => ({ status, reason: status ? "http-error" : "network-error" }), { force: true, retryFailed: true });
		assert.equal(probe.snapshot, snapshot);
		assert.equal(probe.stale, true);
	}
	assert.equal((await cache.get("other", async () => ({ status: 0, reason: "network-error" }))).snapshot, undefined);
	now += 60_000;
	assert.equal((await cache.get("k", async () => ({ status: 0, reason: "network-error" }))).snapshot, undefined);
	assert.equal((await cache.get("k", success, { retryFailed: true })).stale, undefined);
	assert.equal((await cache.get("k", async () => ({ status: 401, reason: "http-error" }), { force: true })).snapshot, undefined);
	await cache.get("k", success, { retryFailed: true });
	cache.invalidate();
	assert.equal((await cache.get("k", async () => { throw new Error("offline"); })).snapshot, undefined);
});
