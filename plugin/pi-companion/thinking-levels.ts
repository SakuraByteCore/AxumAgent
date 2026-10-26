/**
 * Upstream-confirmed extended thinking levels (xhigh/max) for the built-in
 * /thinking selector.
 *
 * Axum writes a generic five-level map into models.json
 * ({off:null, minimal:"minimal", low:"low", medium:"medium", high:"high"}),
 * so models.json-defined models never offer xhigh/max even when the
 * underlying model accepts them. The upstream per-provider catalog shipped
 * inside the bundled pi-ai package (dist/providers/data/*.json, top-level key
 * = api form) is the only trusted record of which models really do.
 *
 * Matching is conservative and fail-closed:
 *   - candidates share the model's api form and the id's last path segment;
 *   - a level is adopted only when some candidate declares it with a non-null
 *     string value and no candidate declares it null (explicitly unsupported);
 *   - a missing key (unknown) never counts as support.
 * Only xhigh/max keys that are absent from the model's map are merged in
 * place — existing entries, including a curated map, are never touched.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The levels upstream catalogs declare beyond Axum's generic five. */
const EXTENDED_LEVELS = ["xhigh", "max"] as const;

type ThinkingLevelMap = Record<string, string | null>;
/** api form -> id basename -> declared maps of every matching catalog entry. */
type CatalogIndex = Map<string, Map<string, ThinkingLevelMap[]>>;

export type EnrichableModel = {
	id: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap | null;
};

function basename(modelId: string): string {
	const slash = modelId.lastIndexOf("/");
	return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

/** Locate the bundled pi-ai model catalog, or null when unresolvable. */
export function resolveUpstreamCatalogDir(): string | null {
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
		const dataDir = join(dirname(entry), "providers", "data");
		return existsSync(dataDir) ? dataDir : null;
	} catch {
		return null;
	}
}

/** Index every catalog entry by api form and id basename. */
export async function buildCatalogIndex(dataDir: string): Promise<CatalogIndex | undefined> {
	const index: CatalogIndex = new Map();
	let files: string[];
	try {
		files = (await readdir(dataDir)).filter((name) => name.endsWith(".json"));
	} catch {
		return undefined;
	}
	for (const name of files) {
		let catalog: Record<string, Record<string, { thinkingLevelMap?: ThinkingLevelMap }>>;
		try {
			catalog = JSON.parse(await readFile(join(dataDir, name), "utf8"));
		} catch {
			continue;
		}
		for (const [api, models] of Object.entries(catalog)) {
			if (!models || typeof models !== "object") continue;
			let byBasename = index.get(api);
			if (!byBasename) {
				byBasename = new Map();
				index.set(api, byBasename);
			}
			for (const [modelId, info] of Object.entries(models)) {
				const map = info?.thinkingLevelMap;
				if (!map || typeof map !== "object") continue;
				const key = basename(modelId);
				const maps = byBasename.get(key);
				if (maps) maps.push(map);
				else byBasename.set(key, [map]);
			}
		}
	}
	return index;
}

let catalogPromise: Promise<CatalogIndex | undefined> | undefined;

function loadCatalog(): Promise<CatalogIndex | undefined> {
	if (!catalogPromise) {
		const dir = resolveUpstreamCatalogDir();
		catalogPromise = dir ? buildCatalogIndex(dir) : Promise.resolve(undefined);
	}
	return catalogPromise;
}

/** The levels upstream confirms for (api, modelId); nothing is fabricated. */
export function confirmedExtendedLevels(
	index: CatalogIndex | undefined,
	api: string | undefined,
	modelId: string,
): { xhigh?: string; max?: string } {
	const confirmed: { xhigh?: string; max?: string } = {};
	if (!index || !api) return confirmed;
	const candidates = index.get(api)?.get(basename(modelId));
	if (!candidates) return confirmed;
	for (const level of EXTENDED_LEVELS) {
		const declared = candidates.map((map) => map[level]).filter((value) => value !== undefined);
		if (declared.includes(null)) continue;
		const strings = [...new Set(declared.filter((value): value is string => typeof value === "string" && value.length > 0))];
		if (strings.length === 1) confirmed[level] = strings[0];
	}
	return confirmed;
}

/**
 * Merge upstream-confirmed xhigh/max into the live model's thinkingLevelMap —
 * the very object the /thinking selector and the wire mapping both read.
 * Existing keys are never overwritten; returns whether anything was added.
 */
export async function enrichModelThinkingLevels(
	model: EnrichableModel | undefined,
	index?: CatalogIndex,
): Promise<boolean> {
	if (!model || !model.reasoning || !model.thinkingLevelMap || typeof model.thinkingLevelMap !== "object") return false;
	const confirmed = confirmedExtendedLevels(index ?? (await loadCatalog()), model.api, model.id);
	let changed = false;
	for (const level of EXTENDED_LEVELS) {
		const value = confirmed[level];
		if (value === undefined || model.thinkingLevelMap[level] !== undefined) continue;
		model.thinkingLevelMap[level] = value;
		changed = true;
	}
	return changed;
}
