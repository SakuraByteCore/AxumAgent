// opencode-zen.ts — dynamic OpenCode Zen (opencode2dsh) provider sync for /usemodel.
//
// Mirrors the catalog and disguise-header logic of FishBottle7/opencode2dsh
// (packages/plugin/src/adapter/catalog.ts + ids.ts). The anonymous free lane at
// https://opencode.ai/zen/v1 speaks plain openai-completions with
// `Authorization: Bearer public`, but it gates on OpenCode-CLI-shaped
// correlation headers, and the session id must match the canonical
// `ses_<12hex><14 base62>` shape or the free tier answers 403 — which is why
// the provider block built here carries a static disguise header set derived
// with the same recipes (a static approximation of the upstream per-session
// derivation; ids stay stable per install).
//
// Catalog chain, trimmed from upstream catalog.ts:
//   S1  GET https://opencode.ai/zen/v1/models   live ids
//   S2  GET https://models.dev/api.json         free decision + metadata
//   S3  compile-time verified static list       bootstrap / offline fallback
// with a disk cache (24h TTL) so /usemodel never blocks on the network.
//
// Env switches (read at call time, for hermetic tests and user opt-out):
//   PI_COMPANION_ZEN_SYNC_DISABLE=1  skip the sync entirely, touch nothing
//   PI_COMPANION_ZEN_OFFLINE=1       never fetch live; cache/static only
//
// Zero runtime relative imports so node --test can import it directly.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ZEN_PROVIDER_ID = "opencode2dsh";
export const ZEN_CHAT_BASE_URL = "https://opencode.ai/zen/v1";
const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const ZEN_API_KEY = "public";
export const CATALOG_CACHE_FILE = "opencode2dsh-catalog-cache.json";
export const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LIVE_FETCH_TIMEOUT_MS = 8000;
/** Upstream ids.ts opencodeUserAgent pins this CLI version string. */
const OPENCODE_UA_VERSION = "1.18.31";

/**
 * Compile-time verified free ids (upstream catalog.ts staticFreeModels; each
 * one verified against the anonymous lane with a real chat). Bootstrap list
 * and offline floor.
 */
export const STATIC_FREE_MODEL_IDS: readonly string[] = [
	"big-pickle",
	"mimo-v2.5-free",
	"mimo-v2.6-flash-free",
	"ling-3.0-flash-fin-free",
	"nemotron-3.5-lightning-free",
	"nemotron-3-ultra-free",
	"muse-spark-1.2-contributor-free",
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

/** sha256("prefix\0value") truncated to 12 bytes: stable, non-reversible. */
function stableID(prefix: string, value: string): string {
	const sum = createHash("sha256").update(`${prefix}\x00${value}`).digest();
	return `${prefix}_${sum.subarray(0, 12).toString("hex")}`;
}

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
 * Ported verbatim-semantics from upstream ids.ts canonicalSessionID: the Zen
 * free tier 403-rejects any session id that does not match this shape.
 */
export function canonicalSessionID(signal: string): string {
	if (CANONICAL_SESSION_PATTERN.test(signal)) return signal;
	const sum = createHash("sha256").update(`ses\x00${signal}`).digest();
	const timePart = sum.subarray(0, 6).toString("hex");
	const randomPart = base62Fixed(BigInt(`0x${sum.subarray(6, 16).toString("hex")}`), 14);
	return `ses_${timePart}${randomPart}`;
}

/** The CLI-identical disguise header set the free lane gates on (upstream disguiseHeaders). */
export function buildDisguiseHeaders(options: { requestID?: string } = {}): Record<string, string> {
	const session = canonicalSessionID("pi-companion:opencode2dsh:static-session");
	return {
		"user-agent": `opencode/${OPENCODE_UA_VERSION} (${process.platform} ${process.arch}; node${process.versions.node})`,
		"x-opencode-client": "cli",
		"x-opencode-session": session,
		"x-session-affinity": session,
		"X-Session-Id": session,
		"x-opencode-request": options.requestID ?? `req_${randomBytes(16).toString("hex")}`,
		"x-opencode-project": stableID("prj", "opencode2dsh:default-project"),
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
 * Merge the zen provider block into models.json. Only the `opencode2dsh` key
 * is managed; every other provider/key is preserved byte-for-byte in value.
 * The disguise headers are generated once and then reused from the existing
 * block so repeated merges are stable. Returns whether the file was rewritten.
 */
export async function mergeZenProvider(modelsJsonPath: string, models: ZenModelInfo[]): Promise<boolean> {
	const config = await readModelsConfig(modelsJsonPath);
	const providers = isRecord(config.providers) ? config.providers : {};
	const existing = isRecord(providers[ZEN_PROVIDER_ID]) ? providers[ZEN_PROVIDER_ID] : undefined;
	const headers = existing && isRecord(existing.headers) ? existing.headers : buildDisguiseHeaders();
	const block = buildZenProviderBlock(models, headers);
	if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(block)) return false;
	const next = { ...config, providers: { ...providers, [ZEN_PROVIDER_ID]: block } };
	await atomicWriteJson(modelsJsonPath, next);
	return true;
}

// ── Ensure: cache → live → stale cache → static ────────────────────────────

interface CatalogCacheEntry {
	models: ZenModelInfo[];
	writtenAt: number;
	fresh: boolean;
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
	return { models, writtenAt, fresh: now - writtenAt <= CATALOG_CACHE_TTL_MS };
}

async function writeCatalogCache(cachePath: string, models: ZenModelInfo[], now: () => number): Promise<void> {
	await atomicWriteJson(cachePath, { writtenAt: now(), models });
}

export interface ZenSyncOptions extends ZenCatalogFetchOptions {
	now?: () => number;
}

/**
 * Keep the opencode2dsh provider block in <agentDir>/models.json fresh:
 * fresh cache → live S1∩S2 fetch → stale cache → static verified list, then an
 * idempotent merge. Never throws for network reasons (the static floor always
 * lands); only models.json corruption/IO errors propagate to the caller.
 */
export async function ensureZenProvider(agentDir: string, options: ZenSyncOptions = {}): Promise<ZenSyncResult> {
	if (process.env.PI_COMPANION_ZEN_SYNC_DISABLE === "1") {
		return { changed: false, source: "disabled", count: 0 };
	}
	const now = options.now ?? Date.now;
	const cachePath = join(agentDir, CATALOG_CACHE_FILE);
	const cached = await loadCatalogCache(cachePath, now());

	let catalog: ZenCatalog | undefined = cached?.fresh ? { models: cached.models, source: "cache" } : undefined;
	let liveError: string | undefined;
	if (!catalog && process.env.PI_COMPANION_ZEN_OFFLINE !== "1") {
		try {
			catalog = await fetchZenCatalog(options);
		} catch (error) {
			liveError = error instanceof Error ? error.message : String(error);
		}
	}
	if (!catalog && cached) catalog = { models: cached.models, source: "cache" };
	if (!catalog) catalog = staticZenCatalog();

	const changed = await mergeZenProvider(join(agentDir, "models.json"), catalog.models);
	if (catalog.source !== "cache") await writeCatalogCache(cachePath, catalog.models, now);
	return {
		changed,
		source: catalog.source,
		count: catalog.models.length,
		error: catalog.source === "static" ? liveError : undefined,
	};
}
