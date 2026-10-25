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

/**
 * Parse the upstream usage payload into a display snapshot. Returns undefined
 * when the payload does not match the Sub2API usage schema or carries no
 * usable remainder, so the bar hides the balance instead of showing a fake 0.
 */
export function parseUsagePayload(payload: unknown): BalanceSnapshot | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const body = payload as Record<string, unknown>;
	const mode = typeof body.mode === "string" ? body.mode : "";
	if (!USAGE_MODES.has(mode)) return undefined;
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
 * Query the Sub2API usage endpoint. Any transport, status or schema problem
 * resolves to undefined so the caller can hide the segment.
 */
export async function fetchSub2ApiBalance(options: {
	baseUrl: string;
	apiKey: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<BalanceSnapshot | undefined> {
	const url = usageUrl(options.baseUrl);
	if (!url || !options.apiKey) return undefined;
	const parsed = new URL(url);
	// The key only ever travels to the provider's own origin, over TLS.
	if (parsed.protocol !== "https:" && !isLoopback(parsed.hostname)) return undefined;
	const doFetch = options.fetchImpl ?? fetch;
	try {
		const response = await doFetch(url, {
			headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
			signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		return parseUsagePayload(await response.json());
	} catch {
		return undefined;
	}
}

interface CacheEntry {
	snapshot?: BalanceSnapshot;
	fetchedAt: number;
	failed: boolean;
}

/**
 * TTL cache for the balance snapshot: one in-flight request per key, a short
 * success TTL and a longer negative TTL so a broken endpoint is not hammered.
 */
export class BalanceCache {
	private entries = new Map<string, CacheEntry>();
	private inflight = new Map<string, Promise<BalanceSnapshot | undefined>>();
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

	async get(key: string, loader: () => Promise<BalanceSnapshot | undefined>): Promise<BalanceSnapshot | undefined> {
		const entry = this.entries.get(key);
		if (entry) {
			const age = Date.now() - entry.fetchedAt;
			if (entry.failed ? age < this.errorTtlMs : age < this.ttlMs) return entry.snapshot;
		}
		const pending = this.inflight.get(key);
		if (pending) return pending;
		const request = loader()
			.then((snapshot) => {
				this.entries.set(key, { snapshot, fetchedAt: Date.now(), failed: snapshot === undefined });
				return snapshot;
			})
			.catch(() => {
				this.entries.set(key, { fetchedAt: Date.now(), failed: true });
				return undefined;
			})
			.finally(() => {
				this.inflight.delete(key);
			});
		this.inflight.set(key, request);
		return request;
	}
}
