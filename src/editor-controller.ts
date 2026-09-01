/**
 * Small, VS Code-independent lifecycle helper for custom-editor views. Keeping
 * this separate makes the important stale/disposal behaviour cheap to test.
 */
export interface EditorSink {
	post(message: EditorMessage): void;
}

export type EditorMessage =
	| { type: 'pdf'; uri: string }
	| { type: 'error'; message: string }
	| { type: 'loading' };

export type IncomingEditorMessage = { type: 'retry' } | { type: 'openOutput' } | { type: 'viewState'; page: number; zoom: number; scrollTop: number };

export function isIncomingEditorMessage(value: unknown): value is IncomingEditorMessage {
	if (!value || typeof value !== 'object') { return false; }
	const message = value as Record<string, unknown>;
	if (message.type === 'retry' || message.type === 'openOutput') { return Object.keys(message).length === 1; }
	return message.type === 'viewState'
		&& Object.keys(message).length === 4
		&& [message.page, message.zoom, message.scrollTop].every(item => typeof item === 'number' && Number.isFinite(item));
}

export function escapeHtml(value: string): string {
	return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

export class EditorController {
	private readonly views = new Set<EditorSink>();
	private generation = 0;

	public add(view: EditorSink): () => void {
		this.views.add(view);
		return () => this.views.delete(view);
	}

	public begin(): number { return ++this.generation; }
	public isCurrent(generation: number): boolean { return generation === this.generation; }
	public get size(): number { return this.views.size; }
	public loading(): void { this.broadcast({ type: 'loading' }); }
	public pdf(generation: number, uri: string): boolean {
		if (!this.isCurrent(generation)) { return false; }
		this.broadcast({ type: 'pdf', uri });
		return true;
	}
	public error(generation: number, message: string): boolean {
		if (!this.isCurrent(generation)) { return false; }
		this.broadcast({ type: 'error', message });
		return true;
	}

	private broadcast(message: EditorMessage): void {
		for (const view of this.views) { view.post(message); }
	}
}
