/**
 * Sub2API balance lookup for the pi-bar Codex row.
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
 * `mode` is the Sub2API fingerprint: an endpoint that does not answer with it
 * is not a Sub2API deployment, so the bar stays silent instead of showing a
 * foreign provider's number.
 *
 * The API key is only ever used as a request header: it is never logged,
 * persisted or embedded in a URL.
 */

export interface BalanceSnapshot {
	/** Display text, e.g. "$12.34", "$8.20 quota", "∞". */
	label: string;
	/** Upstream mode field ("quota_limited" | "unrestricted"). */
	mode: string;
	/** Numeric remainder, or null when the account is unlimited. */
	value: number | null;
	/** Upstream unit field ("USD"). */
	unit: string;
}

/** Outcome of one usage probe, including why a balance is missing. */
export interface BalanceProbe {
	/** Parsed snapshot; present only when a usable remainder was returned. */
	snapshot?: BalanceSnapshot;
	/** HTTP status code; 0 when the request never reached the server. */
	status: number;
	/** "ok" | "invalid-url" | "network-error" | "http-error" | "not-sub2api" | "no-balance". */
	reason: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const USAGE_MODES = new Set(["quota_limited", "unrestricted"]);

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
		return { label: `${formatAmount(quotaRemaining, unit)} quota`, mode, value: quotaRemaining, unit };
	}
	if (remaining !== undefined) {
		if (remaining < 0) return { label: "∞", mode, value: null, unit };
		return { label: formatAmount(remaining, unit), mode, value: remaining, unit };
	}
	return undefined;
}

/**
 * Probe the Sub2API usage endpoint. Every transport, status or schema problem
 * is reported as a reason instead of throwing, so the caller can hide the
 * segment and still log why nothing was shown.
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
	// The key only ever travels to the provider's own origin, over TLS.
	if (parsed.protocol !== "https:" && !isLoopback(parsed.hostname)) return { status: 0, reason: "invalid-url" };
	const doFetch = options.fetchImpl ?? fetch;
	try {
		const response = await doFetch(url, {
			headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
			signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		if (!response.ok) return { status: response.status, reason: "http-error" };
		const payload = await response.json();
		if (!isSub2ApiPayload(payload)) return { status: response.status, reason: "not-sub2api" };
		const snapshot = parseUsagePayload(payload);
		return snapshot
			? { snapshot, status: response.status, reason: "ok" }
			: { status: response.status, reason: "no-balance" };
	} catch {
		return { status: 0, reason: "network-error" };
	}
}

/**
 * Query the Sub2API usage endpoint. Any transport, status or schema problem
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
}

/**
 * TTL cache for the balance probe: one in-flight request per key, a short
 * success TTL and a longer negative TTL so a broken or non-Sub2API endpoint is
 * not hammered on every turn.
 */
export class BalanceCache {
	private entries = new Map<string, CacheEntry>();
	private inflight = new Map<string, Promise<BalanceProbe>>();
	private ttlMs: number;
	private errorTtlMs: number;

	constructor(ttlMs = 60_000, errorTtlMs = 300_000) {
		this.ttlMs = ttlMs;
		this.errorTtlMs = errorTtlMs;
	}

	invalidate(key?: string): void {
		if (key === undefined) {
			this.entries.clear();
			return;
		}
		this.entries.delete(key);
	}

	async get(key: string, loader: () => Promise<BalanceProbe>, options: { force?: boolean } = {}): Promise<BalanceProbe> {
		const entry = this.entries.get(key);
		if (entry) {
			const age = Date.now() - entry.fetchedAt;
			// A forced refresh bypasses the success TTL so fresh consumption shows
			// up right away; the negative cache still shields a broken endpoint.
			if (entry.failed) {
				if (age < this.errorTtlMs) return entry.probe;
			} else if (!options.force && age < this.ttlMs) {
				return entry.probe;
			}
		}
		const pending = this.inflight.get(key);
		if (pending) return pending;
		const request = loader()
			.then((probe) => {
				this.entries.set(key, { probe, fetchedAt: Date.now(), failed: probe.snapshot === undefined });
				return probe;
			})
			.catch(() => {
				this.entries.set(key, {
					probe: { status: 0, reason: "network-error" },
					fetchedAt: Date.now(),
					failed: true,
				});
				return { status: 0, reason: "network-error" } as BalanceProbe;
			})
			.finally(() => {
				this.inflight.delete(key);
			});
		this.inflight.set(key, request);
		return request;
	}
}
