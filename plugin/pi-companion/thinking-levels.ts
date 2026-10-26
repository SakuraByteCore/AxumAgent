/**
 * Hardcoded extended thinking levels (xhigh/max) for the built-in /thinking
 * selector.
 *
 * The selector derives its rows from the live model's thinkingLevelMap
 * (pi-ai getSupportedThinkingLevels): xhigh/max only appear when that map
 * declares the keys. Axum writes models.json models with its own generic
 * five-level baseline map, so models served by Axum-managed providers never
 * offered the extended rungs — and the upstream per-provider catalog cannot
 * confirm a custom model id either.
 *
 * The extended rungs are therefore hardcoded onto Axum's own baseline map.
 * Upstream and curated maps keep exactly the rungs their provider declares:
 * they do not match the baseline shape and are never touched.
 *
 * pi deep-freezes every models.json provider block, so the live map cannot be
 * written into; the extended rungs are published as a replacement map instead.
 */
export type EnrichableModel = {
	id: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null> | null;
};

/** The five-level map Axum writes for every reasoning model. */
const AXUM_BASELINE_LEVEL_MAP: Record<string, string | null> = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
};

/** The extended rungs hardcoded onto Axum's baseline map. */
export const HARDED_EXTENDED_LEVELS: Record<string, string> = {
	xhigh: "xhigh",
	max: "max",
};

/** True when the map is exactly Axum's generic five-level baseline. */
export function isAxumBaselineLevelMap(map: Record<string, unknown>): boolean {
	const keys = Object.keys(map);
	if (keys.length !== Object.keys(AXUM_BASELINE_LEVEL_MAP).length) return false;
	return keys.every((key) => key in AXUM_BASELINE_LEVEL_MAP && map[key] === AXUM_BASELINE_LEVEL_MAP[key]);
}

/**
 * Hardcode xhigh/max into an Axum-generated model's live thinkingLevelMap —
 * the very object the /thinking selector reads every time it opens.
 * Returns whether anything was added.
 */
export function enrichModelThinkingLevels(model: EnrichableModel | undefined): boolean {
	const map = model?.thinkingLevelMap;
	if (!model || !model.reasoning || !map || typeof map !== "object") return false;
	if (!isAxumBaselineLevelMap(map)) return false;
	const additions: Record<string, string> = {};
	for (const [level, value] of Object.entries(HARDED_EXTENDED_LEVELS)) {
		if (map[level] === undefined) additions[level] = value;
	}
	if (Object.keys(additions).length === 0) return false;
	// The live map comes from pi's deep-frozen models.json provider block, so
	// writing into it throws "Cannot add property xhigh, object is not
	// extensible". The model object itself stays extensible: publish a new map
	// and let the /thinking selector read the extended rungs from it.
	if (!Object.isExtensible(model)) return false;
	model.thinkingLevelMap = { ...map, ...additions };
	return true;
}
