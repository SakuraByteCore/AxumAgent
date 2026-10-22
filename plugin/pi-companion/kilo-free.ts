// kilo-free.ts — dynamic Kilo free-pool provider sync for /usemodel.
//
// Port of the Kilo lane of Ebony-Vinyl/dsh-our-free-model (src/kilo.js +
// src/catalog.js): the Kilo gateway (https://api.kilo.ai/api/gateway) serves an
// OpenAI-compatible free pool whose roster is the listing's `isFree: true`
// slice. The lane is keyless — the gateway 401s (`INVALID_TOKEN`) any
// non-empty bearer token but accepts a blank one, so the provider block carries
// `apiKey: " "` which pi sends as `Authorization: Bearer  ` (verified live
// 2026-10-22: blank bearer 200, "Bearer public"/"Bearer none" 401).
//
// Cost disclosure: every free-pool model card declares
// `mayTrainOnYourPrompts: true` — prompts may be logged upstream and used to
// improve the service. The provider display name states it; this lane is for
// throwaway work, not secrets.
//
// Catalog chain, mirroring opencode-zen.ts:
//   S1  GET {base}/models            live roster (isFree slice)
//   S2  compile-time verified static list   bootstrap / offline fallback
// with a disk cache (24h TTL) so /usemodel never blocks on the network, and a
// background refresh with a 1h failure cooldown.
//
// Env switches (read at call time, for hermetic tests and user opt-out):
//   PI_COMPANION_KILO_SYNC_DISABLE=1  skip the sync entirely, touch nothing
//   PI_COMPANION_KILO_OFFLINE=1       never fetch live; cache/static only
//
// Zero runtime relative imports so node --test can import it directly.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const KILO_PROVIDER_ID = "kilo";
export const KILO_CHAT_BASE_URL = "https://api.kilo.ai/api/gateway";
const KILO_MODELS_URL = "https://api.kilo.ai/api/gateway/models";
export const KILO_CATALOG_CACHE_FILE = "kilo-catalog-cache.json";
export const KILO_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed live fetch, stay on cache/static (no retry) for one hour. */
export const KILO_LIVE_FETCH_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const KILO_LISTING_TIMEOUT_MS = 15000;

export interface KiloModelInfo {
	id: string;
	name: string;
	reasoning: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Record<string, string | null>;
}

export interface KiloCatalog {
	models: KiloModelInfo[];
	source: "live" | "cache" | "static";
}

export interface KiloSyncResult {
	changed: boolean;
	source: KiloCatalog["source"] | "disabled";
	count: number;
	error?: string;
}

/**
 * Offline floor for the Kilo pool. Intentionally empty: the compile-time
 * snapshot kept rotting as upstream retired free ids (e.g.
 * minimax/minimax-m3.1-flash:free was dead while still listed), so bootstrap
 * now relies solely on the live catalog and the on-disk cache. A cold offline
 * start yields an empty provider block until the first successful live fetch
 * fills the cache. Tuple shape (kept for the buildKiloModelInfo mapping):
 * [id, contextWindow, maxCompletionTokens (null = gateway default), imageInput,
 * declared effort values (null = no declared menu → identity ladder)].
 */
const STATIC_KILO_FREE_ROWS: readonly (readonly [string, number, number | null, 0 | 1, string | null])[] = [];

/** pi's identity thinking ladder for rows that declare no effort menu. */
const DEFAULT_KILO_THINKING_LADDER: Record<string, string | null> = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
};

/** Ladder for mandatory-reasoning families: no off rung, minimal as the floor. */
const MANDATORY_KILO_THINKING_LADDER: Record<string, string | null> = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
};

/**
 * Families that reject disabling reasoning outright — `reasoning_effort: "none"`
 * answers 400 "Reasoning is mandatory" (verified live 2026-10-22 on liquid and
 * minimax; stepfun/thinkingmachines per the upstream lane's probe record).
 * The auto-router rows tolerate `none` but keep thinking anyway, so they stay
 * in the disable-capable set and merely waste the rung.
 */
const KILO_REASONING_MANDATORY: RegExp[] = [/^stepfun\//, /^liquid\//, /^thinkingmachines\//, /^minimax\//];

export function kiloCanDisableThinking(id: string): boolean {
	return !KILO_REASONING_MANDATORY.some((pattern) => pattern.test(id));
}

const KILO_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Map the row's declared effort values onto pi's thinking levels. Declared
 * values map identity (the gateway accepts `reasoning_effort` with these
 * strings, verified live); undeclared pi levels are pinned to null so
 * getSupportedThinkingLevels never offers them; `off` maps to the gateway's
 * `none` when the row declares it (pi-ai never emits a param for `off`
 * anyway, mandatory-reasoning models keep their default behaviour).
 */
export function kiloThinkingLevelMap(effortValues: string[] | undefined, canDisable: boolean): Record<string, string | null> {
	if (!effortValues || effortValues.length === 0) {
		return canDisable ? { ...DEFAULT_KILO_THINKING_LADDER } : { ...MANDATORY_KILO_THINKING_LADDER };
	}
	const map: Record<string, string | null> = {};
	for (const level of KILO_THINKING_LEVELS) {
		if (effortValues.includes(level)) map[level] = level;
		else if (level === "off") map[level] = canDisable && effortValues.includes("none") ? "none" : null;
		else map[level] = null;
	}
	return map;
}

/** The picker name: listing name with the vendor prefix and `(free)` qualifier stripped (upstream kiloDisplayName). */
export function kiloDisplayName(id: string, listingName?: string): string {
	const raw = typeof listingName === "string" ? listingName.trim() : "";
	const bare = (raw !== "" ? raw : id).replace(/^[^:]{1,40}:\s+/, "").replace(/\s*\(free\)\s*$/i, "").trim();
	return bare !== "" ? bare : id;
}

export function buildKiloModelInfo(
	id: string,
	metadata: { contextWindow?: number; maxTokens?: number | null; image?: boolean; effortValues?: string[]; listingName?: string } = {},
): KiloModelInfo {
	const model: KiloModelInfo = {
		id,
		name: kiloDisplayName(id, metadata.listingName),
		reasoning: true,
		input: metadata.image ? ["text", "image"] : ["text"],
	};
	if (metadata.contextWindow !== undefined) model.contextWindow = metadata.contextWindow;
	if (metadata.maxTokens) model.maxTokens = metadata.maxTokens;
	model.thinkingLevelMap = kiloThinkingLevelMap(metadata.effortValues, kiloCanDisableThinking(id));
	return model;
}

export function staticKiloCatalog(): KiloCatalog {
	return {
		models: STATIC_KILO_FREE_ROWS.map(([id, contextWindow, maxTokens, image, efforts]) =>
			buildKiloModelInfo(id, {
				contextWindow,
				maxTokens,
				image: image === 1,
				effortValues: efforts === null ? undefined : efforts.split(","),
			}),
		),
		source: "static",
	};
}

// ── Live catalog fetch (S1 isFree slice) ────────────────────────────────────

interface KiloListingRow {
	id?: unknown;
	name?: unknown;
	isFree?: unknown;
	context_length?: unknown;
	top_provider?: { context_length?: unknown; max_completion_tokens?: unknown } | undefined;
	architecture?: { input_modalities?: unknown } | undefined;
	opencode?: { reasoning_options?: unknown } | undefined;
}

function rowEffortValues(row: KiloListingRow): string[] | undefined {
	const options = row.opencode?.reasoning_options;
	if (!Array.isArray(options)) return undefined;
	for (const option of options) {
		if (!option || typeof option !== "object" || Array.isArray(option)) continue;
		const entry = option as { type?: unknown; values?: unknown };
		if (entry.type === "effort" && Array.isArray(entry.values)) {
			const values = entry.values.filter((value): value is string => typeof value === "string" && value.length > 0);
			if (values.length > 0) return values;
		}
	}
	return undefined;
}

/** Upstream kiloEntryOf: isFree slice, numeric metadata with the same fallbacks. */
export function decodeKiloListing(data: unknown): KiloModelInfo[] {
	const rows = data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).data)
		? ((data as Record<string, unknown>).data as unknown[])
		: Array.isArray(data)
			? data
			: [];
	const seen = new Set<string>();
	const models: KiloModelInfo[] = [];
	const num = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
	for (const raw of rows) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const row = raw as KiloListingRow;
		if (row.isFree !== true) continue;
		const id = typeof row.id === "string" ? row.id.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const modalities = Array.isArray(row.architecture?.input_modalities) ? row.architecture?.input_modalities : [];
		models.push(
			buildKiloModelInfo(id, {
				contextWindow: num(row.context_length) ?? num(row.top_provider?.context_length) ?? 131072,
				maxTokens: num(row.top_provider?.max_completion_tokens) ?? null,
				image: Array.isArray(modalities) && modalities.includes("image"),
				effortValues: rowEffortValues(row),
				listingName: typeof row.name === "string" ? row.name : undefined,
			}),
		);
	}
	return models;
}

export interface KiloCatalogFetchOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export async function fetchKiloCatalog(options: KiloCatalogFetchOptions = {}): Promise<KiloCatalog> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? KILO_LISTING_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(KILO_MODELS_URL, {
			headers: { accept: "application/json", "user-agent": "axum-pi-companion (kilo-free-lane)" },
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status} from ${KILO_MODELS_URL}`);
		const models = decodeKiloListing(await response.json());
		if (models.length === 0) throw new Error("empty Kilo free-pool listing");
		return { models, source: "live" };
	} finally {
		clearTimeout(timer);
	}
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
	const tmp = `${filePath}.tmp-kilo-sync`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tmp, filePath);
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

function buildKiloProviderBlock(models: KiloModelInfo[]): Record<string, unknown> {
	return {
		name: "Kilo (free, may log prompts)",
		baseUrl: KILO_CHAT_BASE_URL,
		api: "openai-completions",
		// Blank bearer: the gateway 401s any non-empty token and 200s a blank
		// one; pi-ai needs a truthy apiKey to skip its own key requirement.
		apiKey: " ",
		models,
	};
}

/**
 * Merge the kilo provider block into models.json. Only the `kilo` key is
 * managed; every other provider/key is preserved. A user-authored `kilo` block
 * pointing at another baseUrl is never overwritten: the merge refuses with a
 * clear error instead. Returns whether the file was rewritten.
 */
export async function mergeKiloProvider(modelsJsonPath: string, models: KiloModelInfo[]): Promise<boolean> {
	const config = await readModelsConfig(modelsJsonPath);
	const providers = isRecord(config.providers) ? config.providers : {};
	const current = isRecord(providers[KILO_PROVIDER_ID]) ? providers[KILO_PROVIDER_ID] : undefined;
	if (current !== undefined && current.baseUrl !== KILO_CHAT_BASE_URL) {
		throw new Error(`models.json already has a non-Kilo "${KILO_PROVIDER_ID}" provider (baseUrl: ${String(current.baseUrl)}); refusing to overwrite it`);
	}
	// /ctx persists contextWindow into the on-disk kilo block; the catalog
	// rebuild must never clobber those values (ctx is user-owned, not sync-owned).
	const userContextWindows = collectContextWindows(current);
	const mergedModels = models.map((m) => {
		const pinned = userContextWindows.get(m.id);
		return pinned === undefined || pinned === m.contextWindow ? m : { ...m, contextWindow: pinned };
	});
	const next = { ...config, providers: { ...providers, [KILO_PROVIDER_ID]: buildKiloProviderBlock(mergedModels) } };
	if (JSON.stringify(next) === JSON.stringify(config)) return false;
	await atomicWriteJson(modelsJsonPath, next);
	return true;
}

// ── Ensure: cache → live → stale cache → static ────────────────────────────

interface CatalogCacheEntry {
	models: KiloModelInfo[];
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
	const models: KiloModelInfo[] = [];
	for (const item of raw.models) {
		if (isRecord(item) && typeof item.id === "string" && item.id.trim()) models.push(item as KiloModelInfo);
	}
	if (models.length === 0) return undefined;
	const writtenAt = typeof raw.writtenAt === "number" ? raw.writtenAt : 0;
	const lastFailedAttemptAt = typeof raw.lastFailedAttemptAt === "number" ? raw.lastFailedAttemptAt : undefined;
	return { models, writtenAt, fresh: now - writtenAt <= KILO_CATALOG_CACHE_TTL_MS, lastFailedAttemptAt };
}

async function writeCatalogCache(
	cachePath: string,
	models: KiloModelInfo[],
	writtenAt: number,
	lastFailedAttemptAt?: number,
): Promise<void> {
	const entry: Record<string, unknown> = { writtenAt, models };
	if (lastFailedAttemptAt !== undefined) entry.lastFailedAttemptAt = lastFailedAttemptAt;
	await atomicWriteJson(cachePath, entry);
}

export interface KiloSyncOptions extends KiloCatalogFetchOptions {
	now?: () => number;
}

/** Result of the network-free local pass: what got merged and whether a live refresh is due. */
export interface KiloLocalSyncResult extends KiloSyncResult {
	needsLiveRefresh: boolean;
}

/**
 * Network-free fast path: merge whatever the on-disk catalog cache (any age,
 * stale still beats the compile-time static floor) or the static floor has
 * into models.json. Never touches the network; reports whether a live
 * refresh should run in the background. Only models.json corruption/IO
 * errors propagate.
 */
export async function ensureKiloProviderLocal(agentDir: string, options: KiloSyncOptions = {}): Promise<KiloLocalSyncResult> {
	if (process.env.PI_COMPANION_KILO_SYNC_DISABLE === "1") {
		return { changed: false, source: "disabled", count: 0, needsLiveRefresh: false };
	}
	const now = options.now ?? Date.now;
	const cachePath = join(agentDir, KILO_CATALOG_CACHE_FILE);
	const cached = await loadCatalogCache(cachePath, now());

	const catalog: KiloCatalog = cached ? { models: cached.models, source: "cache" } : staticKiloCatalog();
	const changed = await mergeKiloProvider(join(agentDir, "models.json"), catalog.models);
	if (!cached) {
		// Bootstrap the cache file so the failure cooldown has a home and later
		// opens are pure cache reads; writtenAt 0 keeps it stale until a live
		// fetch succeeds, so freshness is never faked.
		await writeCatalogCache(cachePath, catalog.models, 0);
	}
	const cooldownActive =
		cached?.lastFailedAttemptAt !== undefined &&
		now() - cached.lastFailedAttemptAt < KILO_LIVE_FETCH_FAILURE_COOLDOWN_MS;
	const needsLiveRefresh = !cached?.fresh && !cooldownActive && process.env.PI_COMPANION_KILO_OFFLINE !== "1";
	return { changed, source: catalog.source, count: catalog.models.length, needsLiveRefresh };
}

/**
 * Live-only refresh for the background lane: fetch the isFree slice, merge
 * into models.json, and update the cache. On failure, stamp the attempt time
 * so the cooldown window suppresses retries (the stale cache keeps its own
 * writtenAt and is never faked fresh). Never throws for network reasons.
 */
export async function refreshKiloProviderLive(agentDir: string, options: KiloSyncOptions = {}): Promise<KiloSyncResult> {
	if (process.env.PI_COMPANION_KILO_SYNC_DISABLE === "1" || process.env.PI_COMPANION_KILO_OFFLINE === "1") {
		return { changed: false, source: "disabled", count: 0 };
	}
	const now = options.now ?? Date.now;
	const cachePath = join(agentDir, KILO_CATALOG_CACHE_FILE);
	const cached = await loadCatalogCache(cachePath, now());
	try {
		const catalog = await fetchKiloCatalog(options);
		await writeCatalogCache(cachePath, catalog.models, now());
		const changed = await mergeKiloProvider(join(agentDir, "models.json"), catalog.models);
		return { changed, source: catalog.source, count: catalog.models.length };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const models = cached?.models ?? staticKiloCatalog().models;
		await writeCatalogCache(cachePath, models, cached?.writtenAt ?? 0, now());
		return { changed: false, source: cached ? "cache" : "static", count: models.length, error: message };
	}
}

/**
 * Keep the "kilo" free-pool provider block in <agentDir>/models.json fresh:
 * local pass first, then a live fetch only when due. Composed from the two
 * split entry points above; the UI calls them separately so the selector
 * never waits on the network. Only models.json corruption/IO errors propagate.
 */
export async function ensureKiloProvider(agentDir: string, options: KiloSyncOptions = {}): Promise<KiloSyncResult> {
	const local = await ensureKiloProviderLocal(agentDir, options);
	if (!local.needsLiveRefresh) {
		return { changed: local.changed, source: local.source, count: local.count };
	}
	const live = await refreshKiloProviderLive(agentDir, options);
	if (!live.error) return live;
	return { changed: local.changed, source: local.source, count: local.count, error: live.error };
}
