// opencode-zen.ts — dynamic OpenCode Zen provider sync for /usemodel.
//
// Mirrors the catalog and disguise-header logic of FishBottle7/opencode2dsh
// (packages/plugin/src/adapter/catalog.ts + ids.ts) and exposes the free lane
// as provider id "opencode" (the upstream project's chosen lane is Zen; the
// disguise header seeds stay upstream-identical). The anonymous free lane now
// answers on https://opencode.ai/inference/v1 (the /zen/v1 chat path has been
// 403 FreeTierError since 2026-10-14) with `Authorization: Bearer public`,
// gated on the **OpenCode v2 client fingerprint** (2026-10-16, per
// Ebony-Vinyl/dsh-our-free-model docs/free-lane-wire.md + 9router v0.5.104):
//
//   - User-Agent must be exactly `opencode/latest/2.0.26/cli` (v1's
//     `opencode/1.18.31` and any decorated string are rejected);
//   - four same-value session headers (x-opencode-session, x-opencode-session-id,
//     x-session-affinity, x-session-id) and NO `x-opencode-request`
//     (v1-only header; its presence alone is a 403);
//   - the session id keeps the inverted-timestamp recipe (upstream ids.ts,
//     tightened 2026-10-13 per opencode issue #62) with a counter <= 63;
//   - the request tools must declare `read` + `shell` with the official v2 CLI
//     definitions verbatim, and `tool_choice: "none"` must never be sent.
//     That last gate cannot be expressed in static models.json headers, so the
//     payload rewrite lives in zen-v2-wire.ts and is attached through a
//     streamSimple provider registration in index.ts.
//
// Catalog chain, trimmed from upstream catalog.ts:
//   S1  GET https://opencode.ai/inference/v1/models   live ids
//   S2  GET https://models.dev/api.json         free decision + metadata
//   S3  compile-time verified static list       bootstrap / offline fallback
// with a disk cache (24h TTL) so /usemodel never blocks on the network.
//
// Env switches (read at call time, for hermetic tests and user opt-out):
//   PI_COMPANION_ZEN_SYNC_DISABLE=1  skip the sync entirely, touch nothing
//   PI_COMPANION_ZEN_OFFLINE=1       never fetch live; cache/static only
//
// Zero runtime relative imports so node --test can import it directly.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ZEN_PROVIDER_ID = "opencode";
// Key used by the first shipped version of this sync; migrated away on merge.
export const LEGACY_PROVIDER_ID = "opencode2dsh";
export const ZEN_CHAT_BASE_URL = "https://opencode.ai/inference/v1";
const ZEN_MODELS_URL = "https://opencode.ai/inference/v1/models";
const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const ZEN_API_KEY = "public";
export const CATALOG_CACHE_FILE = "opencode-catalog-cache.json";
export const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed live fetch, stay on cache/static (no retry) for one hour. */
export const LIVE_FETCH_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const LIVE_FETCH_TIMEOUT_MS = 8000;
/**
 * The User-Agent the v2 fingerprint gate matches on (upstream.js CLIENT_UA).
 * Must be sent alone: v2 compares the whole string, any prefix/suffix
 * (platform, node version, attribution) turns it back into a non-v2 client.
 */
export const ZEN_CLIENT_UA = "opencode/latest/2.0.26/cli";

/**
 * Curated offline floor for the anonymous lane. These ids were present in the
 * original hard-coded snapshot and were confirmed in the live catalog on
 * 2026-10-25. Retired ids are deliberately excluded so a cold offline start
 * never exposes a known-dead model.
 */
export const STATIC_FREE_MODEL_IDS: readonly string[] = [
	"big-pickle",
	"mimo-v2.6-flash-free",
	"nemotron-3.5-lightning-free",
	"jev-1.13-free",
];

export interface ZenModelInfo {
	id: string;
	name: string;
	reasoning: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Record<string, string | null>;
}

export interface ZenCatalog {
	models: ZenModelInfo[];
	/** Where this catalog came from. */
	source: "live" | "cache" | "static";
}

export interface ZenSyncResult {
	/** Whether models.json was rewritten by this call. */
	changed: boolean;
	source: ZenCatalog["source"] | "disabled";
	count: number;
	/** Set when the live fetch was attempted, failed, and the static floor was used. */
	error?: string;
}

interface ModelPrice {
	input?: number;
	output?: number;
	deprecated: boolean;
	reasoning?: boolean;
	effortValues?: string[];
	contextWindow?: number;
	maxOutput?: number;
	modalities?: string[];
}

// ── Correlation-id recipes (upstream ids.ts, same derivations) ─────────────

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function base62Fixed(value: bigint, width: number): string {
	let n = value;
	const out = new Array<string>(width);
	for (let i = width - 1; i >= 0; i--) {
		out[i] = BASE62_ALPHABET.charAt(Number(n % 62n));
		n /= 62n;
	}
	return out.join("");
}

/**
/** 48-bit mask over the 12 hex chars the gateway decodes. */
const SESSION_TIME_MASK = 0xffffffffffffn;
/** Intra-millisecond counter baked into the id; the gateway rejects counters > 63. */
const SESSION_COUNTER = 1n;

/**
 * Upstream ids.ts invertedTimestampHex — the Zen free-tier session recipe,
 * tightened 2026-10-13 per opencode issue #62: the 12 hex chars are the
 * bitwise-inverted low 48 bits of `Date.now() * 4096 + counter`, and the
 * gateway decodes them, 403-rejecting ids whose counter exceeds 63 (any
 * digest-derived hex, including this file's pre-fix sha256 derivation).
 */
function invertedTimestampHex(now: number): string {
	return (~(BigInt(now) * 4096n + SESSION_COUNTER) & SESSION_TIME_MASK).toString(16).padStart(12, "0");
}

/**
 * Digest-stable session time part (upstream canonicalizeSession): the 48-bit
 * value is derived from the signal's sha256 so one conversation always maps to
 * the same upstream session id, while the low 12 bits stay `0xffe` (counter 1),
 * inside the accepted counter window. Used for per-conversation sessions on
 * the wire; canonicalSessionID keeps the time-based recipe for callers that
 * want per-call freshness.
 */
function stableSessionTimeHex(signal: string): string {
	const sum = createHash("sha256").update(`ses\x00${signal}`).digest();
	const current =
		((BigInt(sum[0]) << 28n) | (BigInt(sum[1]) << 20n) | (BigInt(sum[2]) << 12n) | (BigInt(sum[3]) << 4n) | BigInt(sum[4] >> 4)) << 12n
		| SESSION_COUNTER;
	return (~current & SESSION_TIME_MASK).toString(16).padStart(12, "0");
}

/** True when the id follows the gateway recipe and decodes to a legal counter. */
export function isGatewaySessionID(id: string): boolean {
	if (!CANONICAL_SESSION_PATTERN.test(id)) return false;
	const decoded = ~BigInt(`0x${id.slice(4, 16)}`) & SESSION_TIME_MASK;
	return (decoded & 0xfffn) <= 63n;
}

/**
 * Ported from upstream ids.ts canonicalSessionID: gateway-recipe ids pass
 * through unchanged; anything else is re-encoded with the
 * inverted-timestamp recipe (sha256 now only derives the opaque base62 tail).
 */
export function canonicalSessionID(signal: string, now: number = Date.now()): string {
	if (isGatewaySessionID(signal)) return signal;
	const sum = createHash("sha256").update(`ses\x00${signal}`).digest();
	const randomPart = base62Fixed(BigInt(`0x${sum.subarray(0, 16).toString("hex")}`), 14);
	return `ses_${invertedTimestampHex(now)}${randomPart}`;
}

/**
 * Digest-stable gateway session id: one conversation signal always encodes to
 * the same upstream session id (quota accounting is per session, so re-minting
 * per request would burn the free tier's per-session allowance).
 */
export function stableSessionID(signal: string): string {
	if (isGatewaySessionID(signal)) return signal;
	const sum = createHash("sha256").update(`ses\x00${signal}`).digest();
	const randomPart = base62Fixed(BigInt(`0x${sum.subarray(6, 16).toString("hex")}`), 14);
	return `ses_${stableSessionTimeHex(signal)}${randomPart}`;
}

/**
 * The v2 disguise header set the free lane gates on (upstream gatewayHeaders):
 * exact v2 CLI User-Agent, four same-value session headers, `x-opencode-project:
 * global`, and — critically — no `x-opencode-request` (v1-only header; sending
 * it is a 403 on its own).
 */
export function buildDisguiseHeaders(options: { session?: string } = {}): Record<string, string> {
	const session = options.session ?? canonicalSessionID("pi-companion:opencode2dsh:static-session");
	return {
		"user-agent": ZEN_CLIENT_UA,
		"x-opencode-client": "cli",
		"x-opencode-session": session,
		"x-opencode-session-id": session,
		"x-session-affinity": session,
		"x-session-id": session,
		"x-opencode-project": "global",
	};
}

// ── models.dev metadata decode + free decision (upstream catalog.ts port) ──

export function isFreeModel(model: string): boolean {
	return model.toLowerCase().includes("free");
}

function decodeEffortValues(raw: unknown): { effortValues?: string[] } {
	if (!Array.isArray(raw)) return {};
	const values: string[] = [];
	for (const option of raw) {
		if (typeof option !== "object" || option === null) continue;
		const entry = option as { type?: unknown; values?: unknown };
		if (entry.type !== "effort" || !Array.isArray(entry.values)) continue;
		for (const value of entry.values) {
			if (typeof value === "string" && value.length > 0 && !values.includes(value)) values.push(value);
		}
	}
	return { effortValues: values };
}

function decodeModalities(input: unknown): string[] | undefined {
	if (!Array.isArray(input)) return undefined;
	const kinds: string[] = [];
	for (const kind of input) {
		if (typeof kind === "string" && kind.length > 0 && !kinds.includes(kind)) kinds.push(kind);
	}
	return kinds.length > 0 ? kinds : undefined;
}

function metadataDeprecated(model: Record<string, unknown>): boolean {
	if (model.deprecated === true) return true;
	const status = String(model.status ?? model.lifecycle ?? "").toLowerCase();
	if (status === "deprecated" || status === "retired" || status === "disabled") return true;
	return model.deprecated_at != null || model.retirement_date != null;
}

function decodeModelPrice(raw: unknown): ModelPrice | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	const num = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const cost = (record.cost ?? {}) as Record<string, unknown>;
	const limit = (record.limit ?? {}) as Record<string, unknown>;
	const modalities = (record.modalities ?? {}) as Record<string, unknown>;
	const contextWindow = num(limit.context);
	const maxOutput = num(limit.output);
	const inputModalities = decodeModalities(modalities.input);
	return {
		input: num(cost.input),
		output: num(cost.output),
		deprecated: metadataDeprecated(record),
		reasoning: record.reasoning === true,
		...decodeEffortValues(record.reasoning_options),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxOutput !== undefined ? { maxOutput } : {}),
		...(inputModalities !== undefined ? { modalities: inputModalities } : {}),
	};
}

/** Trimmed port of upstream decodeModelsDev: use the OpenCode section of models.dev. */
export function decodeModelsDev(data: unknown): Map<string, ModelPrice> {
	const result = new Map<string, ModelPrice>();
	if (!data || typeof data !== "object") return result;
	const providers = data as Record<string, { models?: Record<string, unknown>; id?: unknown; name?: unknown }>;
	const rank = (key: string): number => {
		const lower = key.toLowerCase();
		if (lower === "opencode" || lower === "opencode-zen" || lower === "opencode_zen") return 0;
		if (lower.includes("opencode")) return 1;
		return 2;
	};
	const keys = Object.keys(providers).sort((left, right) => {
		const leftRank = rank(left);
		const rightRank = rank(right);
		if (leftRank !== rightRank) return leftRank - rightRank;
		return left.localeCompare(right);
	});
	for (const key of keys) {
		if (rank(key) > 1) continue;
		const provider = providers[key];
		if (!provider || typeof provider !== "object") continue;
		if (rank(key) === 1) {
			const identity = `${provider.id ?? ""} ${provider.name ?? ""}`.toLowerCase().trim();
			if (!identity.includes("opencode")) continue;
		}
		if (!provider.models || typeof provider.models !== "object") continue;
		for (const [modelKey, raw] of Object.entries(provider.models)) {
			const price = decodeModelPrice(raw);
			if (!price) continue;
			const id = typeof (raw as Record<string, unknown>).id === "string" && (raw as Record<string, unknown>).id
				? ((raw as Record<string, unknown>).id as string)
				: modelKey;
			result.set(id, price);
		}
		if (result.size > 0) return result;
	}
	return result;
}

export interface AnonymousDecision {
	allowed: boolean;
	source: string;
}

/** Upstream catalog.ts decide(): metadata verdict first, name heuristic as fallback. */
export function decide(model: string, prices: Map<string, ModelPrice>, ready: boolean): AnonymousDecision {
	const nameFree = isFreeModel(model);
	const fallback = (source: string): AnonymousDecision =>
		nameFree ? { allowed: true, source: "name_free" } : { allowed: false, source };
	if (!ready || prices.size === 0) return fallback("metadata_pending");
	const price = prices.get(model);
	if (!price) return fallback("metadata_model_missing");
	if (price.deprecated) return { allowed: false, source: "metadata_deprecated" };
	const metadataFree = price.input === 0 && price.output === 0;
	if (metadataFree) return { allowed: true, source: nameFree ? "name_and_metadata_free" : "metadata_free" };
	if (price.input === undefined || price.output === undefined) return { allowed: false, source: "metadata_cost_unknown" };
	return { allowed: false, source: "metadata_paid" };
}

// ── Model entry + provider block construction ──────────────────────────────

/** The upstream default ladder for reasoning models without declared effort values. */
const DEFAULT_THINKING_LEVEL_MAP: Record<string, string | null> = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
};

export function buildZenModelInfo(id: string, price?: ModelPrice): ZenModelInfo {
	const model: ZenModelInfo = { id, name: id, reasoning: price?.reasoning === true };
	if (price?.contextWindow !== undefined) model.contextWindow = price.contextWindow;
	if (price?.maxOutput !== undefined) model.maxTokens = price.maxOutput;
	if (price?.modalities) model.input = price.modalities.includes("image") ? ["text", "image"] : ["text"];
	if (model.reasoning) {
		const efforts = price?.effortValues ?? [];
		const map: Record<string, string | null> = { off: "none" };
		for (const level of efforts) map[level] = level;
		model.thinkingLevelMap = efforts.length > 0 ? map : { ...DEFAULT_THINKING_LEVEL_MAP };
	}
	return model;
}

export function staticZenCatalog(): ZenCatalog {
	return { models: STATIC_FREE_MODEL_IDS.map((id) => buildZenModelInfo(id)), source: "static" };
}

/** Per-model contextWindow overrides persisted on disk (e.g. via /ctx); keyed by model id. */
function collectContextWindows(block: unknown): Map<string, number> {
	const windows = new Map<string, number>();
	if (!isRecord(block) || !Array.isArray(block.models)) return windows;
	for (const m of block.models) {
		if (isRecord(m) && typeof m.id === "string" && typeof m.contextWindow === "number") {
			windows.set(m.id, m.contextWindow);
		}
	}
	return windows;
}

export function buildZenProviderBlock(models: ZenModelInfo[], headers: Record<string, string>): Record<string, unknown> {
	return {
		name: "OpenCode Zen (free, anonymous)",
		baseUrl: ZEN_CHAT_BASE_URL,
		api: "openai-completions",
		apiKey: ZEN_API_KEY,
		headers,
		models,
	};
}

// ── Live catalog fetch (S1 ∩ S2) ────────────────────────────────────────────

async function fetchJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, { headers, signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

async function fetchZenModelIds(fetchImpl: typeof fetch, timeoutMs: number): Promise<string[]> {
	const data = await fetchJson(ZEN_MODELS_URL, { Authorization: `Bearer ${ZEN_API_KEY}`, ...buildDisguiseHeaders() }, fetchImpl, timeoutMs);
	if (!data || typeof data !== "object" || !Array.isArray((data as Record<string, unknown>).data)) {
		throw new Error("unexpected /v1/models payload");
	}
	const ids: string[] = [];
	for (const item of (data as { data: unknown[] }).data) {
		const id = item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string"
			? ((item as Record<string, unknown>).id as string).trim()
			: "";
		if (id && !ids.includes(id)) ids.push(id);
	}
	if (ids.length === 0) throw new Error("empty /v1/models payload");
	return ids;
}

export interface ZenCatalogFetchOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/**
 * S1 live /v1/models ∩ S2 models.dev free decision. A models.dev failure is
 * non-fatal (degrades to the name heuristic, like upstream's fallback); an S1
 * failure rejects and the caller falls back to cache/static.
 */
export async function fetchZenCatalog(options: ZenCatalogFetchOptions = {}): Promise<ZenCatalog> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? LIVE_FETCH_TIMEOUT_MS;
	const ids = await fetchZenModelIds(fetchImpl, timeoutMs);
	let prices = new Map<string, ModelPrice>();
	try {
		const raw = await fetchJson(MODELS_DEV_API_URL, {}, fetchImpl, timeoutMs);
		prices = decodeModelsDev(raw);
	} catch {
		// metadata is optional; decide() falls back to the name heuristic
	}
	const allowed = ids.filter((id) => decide(id, prices, prices.size > 0).allowed);
	return { models: allowed.map((id) => buildZenModelInfo(id, prices.get(id))), source: "live" };
}

// ── models.json merge (idempotent, atomic) ─────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readModelsConfig(file: string): Promise<Record<string, unknown>> {
	let text = "";
	try {
		text = await readFile(file, "utf8");
	} catch {
		return {}; // absent file → fresh install; later writes create it
	}
	if (!text.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`models.json is not valid JSON (${file})`);
	}
	if (!isRecord(parsed)) throw new Error(`models.json is not a JSON object (${file})`);
	return parsed;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-zen-sync`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tmp, filePath);
}

/**
 * Stored headers are always rebuilt to the current v2 shape (the v1 set with
 * `x-opencode-request`/`X-Session-Id`/decorated UA is a 403 on the wire), but
 * the stored session id is preserved whenever it still passes the gateway
 * decode so the per-install identity stays stable across upgrades.
 */
function repairStoredHeaders(source: unknown): Record<string, string> {
	const stored = isRecord(source) && isRecord(source.headers) ? source.headers : undefined;
	const storedSession = stored?.["x-opencode-session"];
	const session = typeof storedSession === "string" && isGatewaySessionID(storedSession)
		? storedSession
		: undefined;
	return buildDisguiseHeaders(session === undefined ? {} : { session });
}

/**
 * Merge the zen provider block into models.json. Only the `opencode` key is
 * managed; every other provider/key is preserved. A leftover
 * `opencode2dsh` block from the first shipped version is migrated away (its
 * headers are reused so the disguise ids stay stable). A user-authored
 * `opencode` block pointing at another baseUrl is never overwritten: the
 * merge refuses with a clear error instead. Returns whether the file was
 * rewritten.
 */
export async function mergeZenProvider(modelsJsonPath: string, models: ZenModelInfo[]): Promise<boolean> {
	const config = await readModelsConfig(modelsJsonPath);
	const providers = isRecord(config.providers) ? config.providers : {};
	const current = isRecord(providers[ZEN_PROVIDER_ID]) ? providers[ZEN_PROVIDER_ID] : undefined;
	if (current !== undefined && current.baseUrl !== ZEN_CHAT_BASE_URL) {
		throw new Error(`models.json already has a non-Zen "${ZEN_PROVIDER_ID}" provider (baseUrl: ${String(current.baseUrl)}); refusing to overwrite it`);
	}
	const legacy = isRecord(providers[LEGACY_PROVIDER_ID]) ? providers[LEGACY_PROVIDER_ID] : undefined;
	const headersSource = current ?? legacy;
	const headers = repairStoredHeaders(headersSource);
	// /ctx persists contextWindow into the on-disk opencode block; the catalog
	// rebuild must never clobber those values (ctx is user-owned, not sync-owned).
	const userContextWindows = collectContextWindows(current);
	const mergedModels = models.map((m) => {
		const pinned = userContextWindows.get(m.id);
		return pinned === undefined || pinned === m.contextWindow ? m : { ...m, contextWindow: pinned };
	});
	const block = buildZenProviderBlock(mergedModels, headers);
	const nextProviders = { ...providers, [ZEN_PROVIDER_ID]: block };
	if (legacy) delete nextProviders[LEGACY_PROVIDER_ID];
	const next = { ...config, providers: nextProviders };
	if (JSON.stringify(next) === JSON.stringify(config)) return false;
	await atomicWriteJson(modelsJsonPath, next);
	return true;
}

// ── Ensure: cache → live → stale cache → static ────────────────────────────

interface CatalogCacheEntry {
	models: ZenModelInfo[];
	writtenAt: number;
	fresh: boolean;
	/** Time of the last failed live fetch; suppresses live retries for the cooldown window. */
	lastFailedAttemptAt?: number;
}

async function loadCatalogCache(cachePath: string, now: number): Promise<CatalogCacheEntry | undefined> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(cachePath, "utf8"));
	} catch {
		return undefined;
	}
	if (!isRecord(raw) || !Array.isArray(raw.models)) return undefined;
	const models: ZenModelInfo[] = [];
	for (const item of raw.models) {
		if (isRecord(item) && typeof item.id === "string" && item.id.trim()) models.push(item as ZenModelInfo);
	}
	if (models.length === 0) return undefined;
	const writtenAt = typeof raw.writtenAt === "number" ? raw.writtenAt : 0;
	const lastFailedAttemptAt = typeof raw.lastFailedAttemptAt === "number" ? raw.lastFailedAttemptAt : undefined;
	return { models, writtenAt, fresh: now - writtenAt <= CATALOG_CACHE_TTL_MS, lastFailedAttemptAt };
}

async function writeCatalogCache(
	cachePath: string,
	models: ZenModelInfo[],
	writtenAt: number,
	lastFailedAttemptAt?: number,
): Promise<void> {
	const entry: Record<string, unknown> = { writtenAt, models };
	if (lastFailedAttemptAt !== undefined) entry.lastFailedAttemptAt = lastFailedAttemptAt;
	await atomicWriteJson(cachePath, entry);
}

export interface ZenSyncOptions extends ZenCatalogFetchOptions {
	now?: () => number;
}

/** Result of the network-free local pass: what got merged and whether a live refresh is due. */
export interface ZenLocalSyncResult extends ZenSyncResult {
	/** True when the catalog is stale/missing, live fetching is allowed (env switches off) and no failure cooldown is active. */
	needsLiveRefresh: boolean;
}

/**
 * Network-free fast path: merge whatever the on-disk catalog cache (any age,
 * stale still beats the compile-time static floor) or the static floor has
 * into models.json. Never touches the network; reports whether a live
 * refresh should run in the background. Only models.json corruption/IO
 * errors propagate.
 */
export async function ensureZenProviderLocal(agentDir: string, options: ZenSyncOptions = {}): Promise<ZenLocalSyncResult> {
	if (process.env.PI_COMPANION_ZEN_SYNC_DISABLE === "1") {
		return { changed: false, source: "disabled", count: 0, needsLiveRefresh: false };
	}
	const now = options.now ?? Date.now;
	const cachePath = join(agentDir, CATALOG_CACHE_FILE);
	const cached = await loadCatalogCache(cachePath, now());

	const catalog: ZenCatalog = cached ? { models: cached.models, source: "cache" } : staticZenCatalog();
	const changed = await mergeZenProvider(join(agentDir, "models.json"), catalog.models);
	if (!cached) {
		// Bootstrap the cache file so the failure cooldown has a home and later
		// opens are pure cache reads; writtenAt 0 keeps it stale until a live
		// fetch succeeds, so freshness is never faked.
		await writeCatalogCache(cachePath, catalog.models, 0);
	}
	const cooldownActive =
		cached?.lastFailedAttemptAt !== undefined &&
		now() - cached.lastFailedAttemptAt < LIVE_FETCH_FAILURE_COOLDOWN_MS;
	const needsLiveRefresh = !cached?.fresh && !cooldownActive && process.env.PI_COMPANION_ZEN_OFFLINE !== "1";
	return { changed, source: catalog.source, count: catalog.models.length, needsLiveRefresh };
}

/**
 * Live-only refresh for the background lane: fetch S1∩S2, merge into
 * models.json, and update the cache. On failure, stamp the attempt time so
 * the cooldown window suppresses retries (the stale cache keeps its own
 * writtenAt and is never faked fresh). Never throws for network reasons.
 */
export async function refreshZenProviderLive(agentDir: string, options: ZenSyncOptions = {}): Promise<ZenSyncResult> {
	if (process.env.PI_COMPANION_ZEN_SYNC_DISABLE === "1" || process.env.PI_COMPANION_ZEN_OFFLINE === "1") {
		return { changed: false, source: "disabled", count: 0 };
	}
	const now = options.now ?? Date.now;
	const cachePath = join(agentDir, CATALOG_CACHE_FILE);
	const cached = await loadCatalogCache(cachePath, now());
	try {
		const catalog = await fetchZenCatalog(options);
		await writeCatalogCache(cachePath, catalog.models, now());
		const changed = await mergeZenProvider(join(agentDir, "models.json"), catalog.models);
		return { changed, source: catalog.source, count: catalog.models.length };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const models = cached?.models ?? staticZenCatalog().models;
		await writeCatalogCache(cachePath, models, cached?.writtenAt ?? 0, now());
		return { changed: false, source: cached ? "cache" : "static", count: models.length, error: message };
	}
}

/**
 * Keep the "opencode" Zen provider block in <agentDir>/models.json fresh:
 * local pass first, then a live fetch only when due. Composed from the two
 * split entry points above; the UI calls them separately so the selector
 * never waits on the network. Only models.json corruption/IO errors propagate.
 */
export async function ensureZenProvider(agentDir: string, options: ZenSyncOptions = {}): Promise<ZenSyncResult> {
	const local = await ensureZenProviderLocal(agentDir, options);
	if (!local.needsLiveRefresh) {
		return { changed: local.changed, source: local.source, count: local.count };
	}
	const live = await refreshZenProviderLive(agentDir, options);
	if (!live.error) return live;
	return { changed: local.changed, source: local.source, count: local.count, error: live.error };
}
