export interface PreviewState {
	generation: number;
	contentHash?: string;
	pdfPaths: ReadonlySet<string>;
}

interface MutablePreviewState {
	generation: number;
	contentHash?: string;
	pdfPaths: Set<string>;
	timer?: ReturnType<typeof setTimeout>;
}

export class PreviewManager {
	private readonly previews = new Map<string, MutablePreviewState>();

	public constructor(private readonly debounceMs: number, private readonly onDebouncedChange: (source: string, generation: number) => void) {}

	public begin(source: string): number {
		return ++this.ensure(source).generation;
	}

	public scheduleChange(source: string): void {
		const state = this.ensure(source);
		const generation = ++state.generation;
		if (state.timer) {
			clearTimeout(state.timer);
		}
		state.timer = setTimeout(() => {
			state.timer = undefined;
			this.onDebouncedChange(source, generation);
		}, this.debounceMs);
	}

	public present(source: string, generation: number, contentHash: string, pdfPath: string): boolean {
		const state = this.ensure(source);
		if (state.generation !== generation) {
			return false;
		}
		state.contentHash = contentHash;
		state.pdfPaths = new Set([pdfPath]);
		return true;
	}

	public isCurrent(source: string, generation: number): boolean {
		return this.previews.get(source)?.generation === generation;
	}

	public state(source: string): PreviewState | undefined {
		const state = this.previews.get(source);
		return state && { generation: state.generation, contentHash: state.contentHash, pdfPaths: state.pdfPaths };
	}

	public activePdfPaths(): ReadonlySet<string> {
		return new Set([...this.previews.values()].flatMap(state => [...state.pdfPaths]));
	}

	public removePdf(pdfPath: string): string[] {
		const emptySources: string[] = [];
		for (const [source, state] of this.previews) {
			if (!state.pdfPaths.delete(pdfPath)) {continue;}
			if (!state.pdfPaths.size) {emptySources.push(source);}
		}
		return emptySources;
	}

	public forget(source: string): void {
		const state = this.previews.get(source);
		if (state?.timer) {
			clearTimeout(state.timer);
		}
		this.previews.delete(source);
	}

	private ensure(source: string): MutablePreviewState {
		let state = this.previews.get(source);
		if (!state) {
			state = { generation: 0, pdfPaths: new Set() };
			this.previews.set(source, state);
		}
		return state;
	}
}
