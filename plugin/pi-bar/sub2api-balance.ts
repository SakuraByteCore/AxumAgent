/**
 * Sub2API / New API balance lookup for the pi-bar Codex row.
 *
 * Upstream contract (Wei-Shaw/sub2api, backend/internal/server/routes/gateway.go):
 *   GET {base}/usage      when base already ends with /v1
 *   GET {base}/v1/usage   otherwise
 *   Authorization: Bearer <api key>
 *
 * The 200 body is a top-level JSON object (no envelope):
 *   mode: "quota_limited" | "unrestricted"
 *   unit: "USD"
 *   balance: number            (wallet mode)
 *   remaining: number          (quota or subscription remainder, -1 = unlimited)
 *   quota: { limit, used, remaining, unit }
 *   subscription: { ... }
 *
 * `mode` identifies Sub2API. Unsupported usage endpoints fall back to New API
 * GET {base without /v1}/api/usage/token/ (QuantumNous/new-api). Only its
 * successful `data.object: "token_usage"` envelope is accepted. Internal quota
 * uses 500,000 units per USD; user_quota is available only with permission.
 * Keep token/account scope in snapshot.mode; display only the amount.
 *
 * The API key is only ever used as a request header: it is never logged,
 * persisted or embedded in a URL.
 */

export interface BalanceSnapshot {
	/** Display text, e.g. "$12.34", "$8.20", "∞". */
	label: string;
	/** Sub2API mode or New API balance scope. */
	mode: string;
	/** Numeric remainder, or null when the account is unlimited. */
	value: number | null;
	/** Upstream unit field ("USD"). */
	unit: string;
}

/** Outcome of one usage probe, including why a balance is missing. */
export interface BalanceProbe {
	/** Parsed remainder, or the last successful remainder when stale is true. */
	snapshot?: BalanceSnapshot;
	stale?: boolean;
	/** HTTP status code; 0 when the request never reached the server. */
	status: number;
	/** "ok" | "invalid-url" | "network-error" | "http-error" | "not-sub2api" | "no-balance". */
	reason: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const USAGE_MODES = new Set(["quota_limited", "unrestricted"]);

const NEW_API_QUOTA_PER_USD = 500_000;
const UNSUPPORTED_USAGE_STATUSES = new Set([404, 405]);

/** Preserve a reverse-proxy prefix while replacing the OpenAI /v1 suffix. */
export function newApiUsageUrl(baseUrl: string): string {
	const usage = usageUrl(baseUrl);
	if (!usage) return "";
	const url = new URL(usage);
	url.pathname = url.pathname.replace(/\/v1\/usage$/, "/api/usage/token/");
	return url.toString();
}

/** New API's read-only /api/usage/token/ contract, not its login-only API. */
function newApiUsageData(payload: unknown): Record<string, unknown> | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const body = payload as Record<string, unknown>;
	if (body.code !== true && body.success !== true) return undefined;
	if (!body.data || typeof body.data !== "object") return undefined;
	const data = body.data as Record<string, unknown>;
	return data.object === "token_usage" ? data : undefined;
}

export function parseNewApiUsagePayload(payload: unknown): BalanceSnapshot | undefined {
	const data = newApiUsageData(payload);
	if (!data) return undefined;
	const userQuota = data.user_quota && typeof data.user_quota === "object"
		? (data.user_quota as Record<string, unknown>).total_available : undefined;
	const hasUserQuota = typeof userQuota === "number" && Number.isFinite(userQuota);
	if (!hasUserQuota && data.unlimited_quota === true) {
		return { label: "∞", mode: "newapi-token", value: null, unit: "USD" };
	}
	const quota = hasUserQuota ? userQuota : data.total_available;
	if (typeof quota !== "number" || !Number.isFinite(quota)) return undefined;
	// Upstream common.QuotaPerUnit uses 500,000 internal units per USD.
	const value = quota / NEW_API_QUOTA_PER_USD;
	return {
		label: formatAmount(value, "USD"),
		mode: hasUserQuota ? "newapi-account" : "newapi-token",
		value,
		unit: "USD",
	};
}
function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

/**
 * Map a provider base URL to the Sub2API usage endpoint. The base URL of a
 * Sub2API provider already carries the API prefix ("https://host/v1"), so the
 * usage path is appended directly; a bare origin gets the "/v1" prefix.
 */
export function usageUrl(baseUrl: string): string {
	const raw = typeof baseUrl === "string" ? baseUrl.trim() : "";
	if (!raw) return "";
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "";
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return "";
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = path.endsWith("/v1") ? `${path}/usage` : `${path}/v1/usage`;
	url.search = "";
	url.hash = "";
	return url.toString();
}

function formatAmount(value: number, unit: string): string {
	const amount = value.toFixed(2);
	return unit === "USD" ? `$${amount}` : `${unit} ${amount}`;
}

/** The Sub2API `mode` field, or undefined when the payload is not Sub2API. */
function usageMode(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const mode = (payload as Record<string, unknown>).mode;
	return typeof mode === "string" && USAGE_MODES.has(mode) ? mode : undefined;
}

/** True when the payload carries the Sub2API usage fingerprint. */
export function isSub2ApiPayload(payload: unknown): boolean {
	return usageMode(payload) !== undefined;
}

/**
 * Parse the upstream usage payload into a display snapshot. Returns undefined
 * when the payload does not match the Sub2API usage schema or carries no
 * usable remainder, so the bar hides the balance instead of showing a fake 0.
 */
export function parseUsagePayload(payload: unknown): BalanceSnapshot | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const body = payload as Record<string, unknown>;
	const mode = usageMode(body);
	if (!mode) return undefined;
	const unit = typeof body.unit === "string" && body.unit ? body.unit : "USD";
	const finite = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const balance = finite(body.balance);
	const quota = body.quota && typeof body.quota === "object" ? (body.quota as Record<string, unknown>) : undefined;
	const quotaRemaining = quota ? finite(quota.remaining) : undefined;
	const remaining = finite(body.remaining);

	if (balance !== undefined) return { label: formatAmount(balance, unit), mode, value: balance, unit };
	if (quotaRemaining !== undefined) {
		if (quotaRemaining < 0) return { label: "∞", mode, value: null, unit };
		return { label: formatAmount(quotaRemaining, unit), mode, value: quotaRemaining, unit };
	}
	if (remaining !== undefined) {
		if (remaining < 0) return { label: "∞", mode, value: null, unit };
		return { label: formatAmount(remaining, unit), mode, value: remaining, unit };
	}
	return undefined;
}

/**
 * Probe Sub2API, falling back to New API on unsupported routes or schemas.
 * Transport, status and schema failures return reasons without throwing.
 * Keep the exported name for callers of the original Sub2API helper.
 */
export async function probeSub2ApiBalance(options: {
	baseUrl: string;
	apiKey: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<BalanceProbe> {
	const url = usageUrl(options.baseUrl);
	if (!url || !options.apiKey) return { status: 0, reason: "invalid-url" };
	const parsed = new URL(url);
	// Never send credentials over plaintext remotes or follow redirects.
	if (parsed.protocol !== "https:" && !isLoopback(parsed.hostname)) return { status: 0, reason: "invalid-url" };
	const doFetch = options.fetchImpl ?? fetch;
	const init = {
		headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		redirect: "error" as const,
	};
	try {
		const response = await doFetch(url, init);
		if (response.ok) {
			// Some New API sites return their HTML app for an unknown /v1 route.
			const payload = await response.json().catch(() => undefined);
			if (isSub2ApiPayload(payload)) {
				const snapshot = parseUsagePayload(payload);
				return { snapshot, status: response.status, reason: snapshot ? "ok" : "no-balance" };
			}
		} else if (!UNSUPPORTED_USAGE_STATUSES.has(response.status)) {
			return { status: response.status, reason: "http-error" };
		}
		const fallback = await doFetch(newApiUsageUrl(options.baseUrl), init);
		if (!fallback.ok) return { status: fallback.status, reason: "http-error" };
		const payload = await fallback.json().catch(() => undefined);
		if (!newApiUsageData(payload)) return { status: fallback.status, reason: "not-sub2api" };
		const snapshot = parseNewApiUsagePayload(payload);
		return { snapshot, status: fallback.status, reason: snapshot ? "ok" : "no-balance" };
	} catch {
		return { status: 0, reason: "network-error" };
	}
}

/**
 * Query a supported provider. Any transport, status or schema problem
 * resolves to undefined so the caller can hide the segment.
 */
export async function fetchSub2ApiBalance(options: {
	baseUrl: string;
	apiKey: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<BalanceSnapshot | undefined> {
	return (await probeSub2ApiBalance(options)).snapshot;
}

interface CacheEntry {
	probe: BalanceProbe;
	fetchedAt: number;
	failed: boolean;
	succeededAt?: number;
}

/**
 * TTL cache for the balance probe: one in-flight request per key, a short
 * success TTL and a longer negative TTL so a broken or unsupported endpoint is
 * not hammered on every turn.
 */
function isTransientProbe(probe: BalanceProbe): boolean {
	return probe.reason === "network-error"
		|| (probe.reason === "http-error" && (probe.status === 429 || probe.status >= 500));
}

export class BalanceCache {
	private entries = new Map<string, CacheEntry>();
	private inflight = new Map<string, Promise<BalanceProbe>>();
	private ttlMs: number;
	private errorTtlMs: number;
	private transientErrorTtlMs: number;

	constructor(ttlMs = 60_000, errorTtlMs = 300_000, transientErrorTtlMs = 15_000) {
		this.ttlMs = ttlMs;
		this.errorTtlMs = errorTtlMs;
		this.transientErrorTtlMs = transientErrorTtlMs;
	}

	invalidate(key?: string): void {
		if (key === undefined) {
			this.entries.clear();
			return;
		}
		this.entries.delete(key);
	}

	private storeProbe(key: string, probe: BalanceProbe): BalanceProbe {
		const previous = this.entries.get(key);
		const now = Date.now();
		const failed = probe.snapshot === undefined;
		const succeededAt = failed ? previous?.succeededAt : now;
		if (failed && isTransientProbe(probe) && previous?.probe.snapshot
			&& succeededAt !== undefined && now - succeededAt < this.ttlMs) {
			probe = { ...probe, snapshot: previous.probe.snapshot, stale: true };
		}
		this.entries.set(key, { probe, fetchedAt: now, failed, succeededAt });
		return probe;
	}

	async get(
		key: string,
		loader: () => Promise<BalanceProbe>,
		options: { force?: boolean; retryFailed?: boolean } = {},
	): Promise<BalanceProbe> {
		const entry = this.entries.get(key);
		if (entry) {
			const now = Date.now();
			const age = now - entry.fetchedAt;
			if (entry.probe.stale && now - entry.succeededAt! >= this.ttlMs) {
				entry.probe = { status: entry.probe.status, reason: entry.probe.reason };
			}
			// A forced refresh bypasses the success TTL so fresh consumption shows
			// up right away; the negative cache still shields a broken endpoint.
			if (entry.failed) {
				// A transport hiccup is transient: keep it cached only briefly so a
				// single timeout cannot hide the balance for the whole error TTL.
				// Structural answers (404/405, foreign schema) keep the long TTL.
				const ttl = isTransientProbe(entry.probe) ? this.transientErrorTtlMs : this.errorTtlMs;
				if (age < ttl && !options.retryFailed) return entry.probe;
			} else if (!options.force && age < this.ttlMs) {
				return entry.probe;
			}
		}
		const pending = this.inflight.get(key);
		if (pending) return pending;
		const request = loader()
			.catch(() => ({ status: 0, reason: "network-error" } as BalanceProbe))
			.then((probe) => this.storeProbe(key, probe))
			.finally(() => {
				this.inflight.delete(key);
			});
		this.inflight.set(key, request);
		return request;
	}
}
