/**
 * Stale-runtime guard for the pi-bar.
 *
 * pi invalidates every captured `pi`/command ctx once the session is replaced
 * or reloaded (`ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`,
 * `ctx.reload()`). Any later call through that captured runtime throws
 * "This extension ctx is stale after session replacement or reload." — and an
 * uncaught exception of that kind kills the whole pi process. The bar's
 * balance probe is asynchronous and can outlive its session, so its updates
 * go through this guard: a stale runtime stops the bar instead of crashing.
 */

/** One pi-bar segment update. */
export interface BarSegmentUpdate {
	id: string;
	text?: string;
	color?: string;
	suffix?: string;
}

/** True when the error is pi's "extension ctx is stale" rejection. */
export function isStaleRuntimeError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("extension ctx is stale");
}

/**
 * Wrap a pi event emit so an invalidated runtime degrades gracefully:
 * `onStale` runs on the stale failure and the wrapper reports false instead
 * of throwing. Unexpected errors are rethrown unchanged.
 */
export function createStaleSafeEmit(
	emit: (update: BarSegmentUpdate) => void,
	onStale: () => void,
): (update: BarSegmentUpdate) => boolean {
	return (update: BarSegmentUpdate): boolean => {
		try {
			emit(update);
			return true;
		} catch (error) {
			if (!isStaleRuntimeError(error)) throw error;
			onStale();
			return false;
		}
	};
}
