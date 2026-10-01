/**
 * Remembers where each preview was scrolled to and how far it was zoomed, so
 * that reopening a document — or reopening the workspace — puts you back where
 * you left off. Kept free of `vscode` so the eviction and write-coalescing
 * behaviour is cheap to test.
 */

export interface PreviewViewState {
	zoom: number;
	scrollTop: number;
	scrollLeft: number;
}

/** The slice of `vscode.Memento` this needs, so tests can supply their own. */
export interface ViewStateStorage {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): unknown;
}

export const VIEW_STATE_STORAGE_KEY = 'remarkablePreview.viewState';

/** Positions worth keeping; the least recently touched fall off the end. */
const MAX_REMEMBERED = 200;

export function isPreviewViewState(value: unknown): value is PreviewViewState {
	if (!value || typeof value !== 'object') { return false; }
	const state = value as Record<string, unknown>;
	return [state.zoom, state.scrollTop, state.scrollLeft].every(item => typeof item === 'number' && Number.isFinite(item));
}

export class ViewStateStore {
	/** Insertion order doubles as recency, so the first key is the least recently used. */
	private readonly states = new Map<string, PreviewViewState>();
	private pendingFlush?: ReturnType<typeof setTimeout>;

	public constructor(private readonly storage?: ViewStateStorage, private readonly flushDelayMs = 1_000) {
		const persisted = storage?.get<Record<string, unknown>>(VIEW_STATE_STORAGE_KEY);
		for (const [source, state] of Object.entries(persisted ?? {})) {
			// Persisted state outlives the extension that wrote it, so ignore
			// anything an older or newer version may have left behind.
			if (isPreviewViewState(state)) { this.states.set(source, state); }
		}
	}

	public get(source: string): PreviewViewState | undefined {
		return this.states.get(source);
	}

	public remember(source: string, state: PreviewViewState): void {
		this.states.delete(source);
		this.states.set(source, state);
		for (const remembered of this.states.keys()) {
			if (this.states.size <= MAX_REMEMBERED) { break; }
			this.states.delete(remembered);
		}
		this.scheduleFlush();
	}

	public forget(source: string): void {
		if (this.states.delete(source)) { this.scheduleFlush(); }
	}

	/** Write through now rather than waiting out the coalescing delay. */
	public flush(): void {
		if (this.pendingFlush) { clearTimeout(this.pendingFlush); this.pendingFlush = undefined; }
		this.storage?.update(VIEW_STATE_STORAGE_KEY, Object.fromEntries(this.states));
	}

	public dispose(): void { this.flush(); }

	/** Scrolling reports continuously, so coalesce writes instead of hitting storage per event. */
	private scheduleFlush(): void {
		if (this.pendingFlush || !this.storage) { return; }
		this.pendingFlush = setTimeout(() => { this.pendingFlush = undefined; this.flush(); }, this.flushDelayMs);
	}
}
