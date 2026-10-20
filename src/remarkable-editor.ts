import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderTimeoutMs } from './configuration';
import { EditorController, EditorSink, isIncomingEditorMessage } from './editor-controller';
import { SourceMetadata } from './fingerprint';
import { CachedRenderResult, createRendererBackend, RenderService } from './render-service';
import { PreviewViewState, ViewStateStore } from './view-state';

export const REMARKABLE_EDITOR_VIEW_TYPE = 'remarkablePreview.editor';
const SOURCE_POLL_INTERVAL_MS = 2_000;

interface RemarkableDocument extends vscode.CustomDocument { readonly uri: vscode.Uri; }
interface SourceState {
	controller: EditorController;
	panels: Set<vscode.WebviewPanel>;
	watcher?: vscode.FileSystemWatcher;
	timer?: ReturnType<typeof setTimeout>;
	poller?: ReturnType<typeof setInterval>;
	polling?: boolean;
	missing?: boolean;
	metadata?: SourceMetadata;
	/** What the views of this source are showing, once one of them is showing a render. */
	presented?: { contentHash: string; pdfPath: string };
}

export class RemarkableEditorProvider implements vscode.CustomReadonlyEditorProvider<RemarkableDocument>, vscode.Disposable {
	private readonly sources = new Map<string, SourceState>();
	private readonly viewStates: ViewStateStore;

	public constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly renders: RenderService,
		private readonly cacheDirectory: string,
		private readonly output: vscode.OutputChannel,
		private readonly cleanup: (protectedPaths: ReadonlySet<string>) => void,
	) {
		this.viewStates = new ViewStateStore(context.workspaceState);
	}

	public openCustomDocument(uri: vscode.Uri): RemarkableDocument { return { uri, dispose: () => {} }; }

	public async resolveCustomEditor(document: RemarkableDocument, panel: vscode.WebviewPanel): Promise<void> {
		const source = document.uri;
		if (source.scheme !== 'file') { throw new Error('reMarkable Preview requires a file available to the extension host.'); }
		const state = this.ensure(source);
		state.panels.add(panel);
		panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media'), vscode.Uri.file(this.cacheDirectory)] };
		// A sibling view already has the current render, and the source is watched, so
		// this view can be given it outright. Rendering for it instead would put every
		// other view through a reload to arrive back at what it already shows.
		const presented = state.presented;
		// Both seeded through the HTML rather than posted, because a message sent
		// before the webview finishes loading is simply dropped — and so the viewer
		// knows where to scroll before the first page is rendered.
		panel.webview.html = this.html(panel.webview, this.viewStates.get(source.toString()),
			presented && panel.webview.asWebviewUri(vscode.Uri.file(presented.pdfPath)).toString());
		const sink: EditorSink = { post: message => {
			const outgoing = message.type === 'pdf'
				? { ...message, uri: panel.webview.asWebviewUri(vscode.Uri.file(message.uri)).toString() }
				: message;
			void panel.webview.postMessage(outgoing);
		} };
		const unsubscribe = state.controller.add(sink);
		const messageListener = panel.webview.onDidReceiveMessage(message => {
			if (!isIncomingEditorMessage(message)) { this.log('ignored invalid webview message', source); return; }
			if (message.type === 'retry') { void this.render(source, true); }
			if (message.type === 'openOutput') { this.output.show(true); }
			if (message.type === 'viewState') {
				this.viewStates.remember(source.toString(), { page: message.page, scale: message.scale, top: message.top, left: message.left });
			}
		});
		const viewStateListener = panel.onDidChangeViewState(() => this.syncPolling(source));
		// Each listener releases itself, so opening and closing previews all session
		// does not leave a closure per panel behind until the extension shuts down.
		const disposeListener = panel.onDidDispose(() => {
			unsubscribe(); messageListener.dispose(); viewStateListener.dispose(); disposeListener.dispose();
			state.panels.delete(panel);
			if (!state.controller.size) { this.stop(source); } else { this.syncPolling(source); }
		});
		this.syncPolling(source);
		if (presented) { return; }
		await this.render(source, false);
	}

	public refresh(source: vscode.Uri, force = true): Promise<void> { return this.render(source, force); }
	public async pdfFor(source: vscode.Uri): Promise<string> { return (await this.produce(source, false)).pdfPath; }
	public isOpen(source: vscode.Uri): boolean { return (this.sources.get(source.toString())?.controller.size ?? 0) > 0; }
	public activePdfPaths(): ReadonlySet<string> {
		return new Set([...this.sources.values()].flatMap(state => state.presented ? [state.presented.pdfPath] : []));
	}

	public dispose(): void { for (const source of [...this.sources.keys()]) { this.stop(vscode.Uri.parse(source)); } this.viewStates.dispose(); }

	private ensure(source: vscode.Uri): SourceState {
		const key = source.toString();
		let state = this.sources.get(key);
		if (!state) {
			state = { controller: new EditorController(), panels: new Set() };
			this.sources.set(key, state);
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(source.fsPath)), path.basename(source.fsPath)));
			const changed = () => this.schedule(source);
			watcher.onDidChange(changed); watcher.onDidCreate(changed); watcher.onDidDelete(changed);
			state.watcher = watcher;
		}
		return state;
	}

	/**
	 * Polling is the backstop for hosts whose watchers are unreliable, and it costs
	 * a stat — a remote round trip — every couple of seconds per source. A preview
	 * nobody is looking at does not need one running against it, so the poller
	 * follows visibility, catching up once on the way back in.
	 */
	private syncPolling(source: vscode.Uri): void {
		const state = this.sources.get(source.toString());
		if (!state) { return; }
		const watched = [...state.panels].some(panel => panel.visible);
		if (watched === Boolean(state.poller)) { return; }
		if (!watched) { clearInterval(state.poller); state.poller = undefined; return; }
		void this.poll(source);
		state.poller = setInterval(() => { void this.poll(source); }, SOURCE_POLL_INTERVAL_MS);
	}

	private async poll(source: vscode.Uri): Promise<void> {
		const state = this.sources.get(source.toString());
		if (!state || state.polling) { return; }
		state.polling = true;
		try {
			const metadata = await vscode.workspace.fs.stat(source);
			const previous = state.metadata;
			const changed = state.missing || (previous !== undefined && (previous.size !== metadata.size || previous.mtime !== metadata.mtime));
			state.metadata = metadata;
			state.missing = false;
			if (changed) { this.schedule(source); }
		} catch {
			if (!state.missing) {
				state.missing = true;
				state.metadata = undefined;
				this.schedule(source);
			}
		} finally {
			state.polling = false;
		}
	}

	private schedule(source: vscode.Uri): void {
		const state = this.sources.get(source.toString()); if (!state) { return; }
		this.renders.invalidate(source.toString());
		this.log('source changed; waiting for filesystem to stabilize', source);
		if (state.timer) { clearTimeout(state.timer); }
		state.timer = setTimeout(() => { state.timer = undefined; if (vscode.workspace.getConfiguration('remarkablePreview', source).get<boolean>('autoRefresh', true)) { void this.render(source, false); } }, 350);
	}

	private async produce(source: vscode.Uri, force: boolean): Promise<CachedRenderResult> {
		const metadata = await vscode.workspace.fs.stat(source);
		const state = this.sources.get(source.toString());
		if (state) { state.metadata = metadata; state.missing = false; }
		const executable = vscode.workspace.getConfiguration('remarkablePreview', source).get<string>('remderPath', 'reMder-client');
		return this.renders.getOrRender({
			source: source.toString(),
			metadata,
			read: async () => vscode.workspace.fs.readFile(source),
			backend: createRendererBackend(executable, { timeoutMs: renderTimeoutMs(source) }),
			force,
			log: message => this.log(message, source),
		});
	}

	private async render(source: vscode.Uri, force: boolean): Promise<void> {
		const state = this.sources.get(source.toString());
		// Only a source with views is worth rendering for, and re-creating its state
		// here would leave a watcher behind with no panel left to dispose it.
		if (!state) { return; }
		const generation = state.controller.begin();
		// Re-rendering in place leaves the pages on screen; only a refresh that will
		// certainly replace them, or a preview with nothing to show yet, overlays.
		if (force || !state.presented) { state.controller.loading(); }
		try {
			const { contentHash, pdfPath } = await this.produce(source, force);
			// The content hash exists so that the bookkeeping the tablet rewrites as
			// you merely read a document costs nothing. Reloading the viewer onto
			// identical pages would hand that saving straight back — and a document
			// being read on the device restabilises every few seconds.
			//
			// `presented` describes the render the views have, not what they are
			// showing: a forced refresh this one superseded may have put an overlay
			// up over it, and that refresh can no longer take it down itself. So
			// leaving identical pages in place is only an option while they are
			// actually on screen — otherwise the preview keeps the overlay for good.
			if (!force && state.presented?.contentHash === contentHash && !state.controller.loadingShown) {
				this.log('source unchanged; preview left in place', source);
				return;
			}
			if (!state.controller.pdf(generation, pdfPath)) { this.log('stale render completed; preview not replaced', source); return; }
			state.presented = { contentHash, pdfPath };
			this.log('preview refreshed', source); this.cleanup(this.activePdfPaths());
		} catch (error) {
			const message = describeError(error);
			this.log(`renderer failed: ${message}`, source);
			// The views are showing the failure now, not the render they had before,
			// so the next identical render has to be presented rather than skipped.
			if (state.controller.error(generation, isFileNotFound(error) ? 'The source file is no longer available.' : message)) {
				state.presented = undefined;
			}
			if (isFileNotFound(error)) {
				this.renders.invalidate(source.toString());
				state.watcher?.dispose(); state.watcher = undefined;
			}
		}
	}

	private stop(source: vscode.Uri): void { const state = this.sources.get(source.toString()); if (!state) { return; } if (state.timer) { clearTimeout(state.timer); } if (state.poller) { clearInterval(state.poller); } state.watcher?.dispose(); this.sources.delete(source.toString()); }
	private log(message: string, source?: vscode.Uri): void { this.output.appendLine(`${new Date().toISOString()} ${message}${source ? `: ${source.fsPath}` : ''}`); }
	private html(webview: vscode.Webview, view?: PreviewViewState, pdfUri?: string): string {
		const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.css'));
		const viewerStyle = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdfjs', 'pdf_viewer.css'));
		const worker = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdfjs', 'pdf.worker.mjs'));
		const nonce = randomNonce();
		// font-src covers embedded fonts that pdf.js has to fall back to declaring
		// as data URLs; the text layer needs them to measure glyphs.
		return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource} blob: data:; img-src ${webview.cspSource} blob: data:; script-src 'nonce-${nonce}'; worker-src ${webview.cspSource} blob:; connect-src ${webview.cspSource};"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${viewerStyle}"><link rel="stylesheet" href="${style}"></head><body><main id="app"><div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div><div id="status"><p>Loading reMarkable preview…</p></div></main><script nonce="${nonce}">window.__remarkableWorkerUri=${JSON.stringify(worker.toString())};window.__remarkableViewState=${JSON.stringify(view ?? null)};window.__remarkableInitialPdf=${JSON.stringify(pdfUri ?? null)};</script><script nonce="${nonce}" src="${script}"></script></body></html>`;
	}
}

function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isFileNotFound(error: unknown): boolean { return error instanceof vscode.FileSystemError && error.code === 'FileNotFound'; }
function randomNonce(): string { return randomBytes(16).toString('hex'); }
