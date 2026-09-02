import * as path from 'node:path';
import * as vscode from 'vscode';
import { EditorController, isIncomingEditorMessage } from './editor-controller';
import { SourceMetadata } from './fingerprint';
import { RenderService } from './render-service';

export const REMARKABLE_EDITOR_VIEW_TYPE = 'remarkablePreview.editor';
const SOURCE_POLL_INTERVAL_MS = 2_000;

interface RemarkableDocument extends vscode.CustomDocument { readonly uri: vscode.Uri; }
interface SourceState {
	controller: EditorController;
	watcher?: vscode.FileSystemWatcher;
	timer?: ReturnType<typeof setTimeout>;
	poller?: ReturnType<typeof setInterval>;
	polling?: boolean;
	missing?: boolean;
	metadata?: SourceMetadata;
	contentHash?: string;
	pdfPath?: string;
}

export class RemarkableEditorProvider implements vscode.CustomReadonlyEditorProvider<RemarkableDocument>, vscode.Disposable {
	private readonly sources = new Map<string, SourceState>();
	private readonly disposables: vscode.Disposable[] = [];

	public constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly renders: RenderService,
		private readonly cacheDirectory: string,
		private readonly output: vscode.OutputChannel,
		private readonly cleanup: (protectedPaths: ReadonlySet<string>) => void,
	) {}

	public openCustomDocument(uri: vscode.Uri): RemarkableDocument { return { uri, dispose: () => {} }; }

	public async resolveCustomEditor(document: RemarkableDocument, panel: vscode.WebviewPanel): Promise<void> {
		const source = document.uri;
		if (source.scheme !== 'file') { throw new Error('reMarkable Preview requires a file available to the extension host.'); }
		const state = this.ensure(source);
		panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media'), vscode.Uri.file(this.cacheDirectory)] };
		panel.webview.html = this.html(panel.webview);
		const unsubscribe = state.controller.add({ post: message => {
			const outgoing = message.type === 'pdf'
				? { ...message, uri: panel.webview.asWebviewUri(vscode.Uri.file(message.uri)).toString() }
				: message;
			void panel.webview.postMessage(outgoing);
		} });
		const messageListener = panel.webview.onDidReceiveMessage(message => {
			if (!isIncomingEditorMessage(message)) { this.log('ignored invalid webview message', source); return; }
			if (message.type === 'retry') { void this.render(source, true); }
			if (message.type === 'openOutput') { this.output.show(true); }
		});
		panel.onDidDispose(() => {
			unsubscribe(); messageListener.dispose();
			if (!state.controller.size) { this.stop(source); }
		}, undefined, this.disposables);
		await this.render(source, false);
	}

	public refresh(source: vscode.Uri, force = true): Promise<void> { return this.render(source, force); }
	public isOpen(source: vscode.Uri): boolean { return (this.sources.get(source.toString())?.controller.size ?? 0) > 0; }
	public activePdfPaths(): ReadonlySet<string> {
		return new Set([...this.sources.values()].flatMap(state => state.pdfPath ? [state.pdfPath] : []));
	}

	public dispose(): void { for (const source of [...this.sources.keys()]) { this.stop(vscode.Uri.parse(source)); } for (const item of this.disposables) { item.dispose(); } }

	private ensure(source: vscode.Uri): SourceState {
		const key = source.toString();
		let state = this.sources.get(key);
		if (!state) {
			state = { controller: new EditorController() };
			this.sources.set(key, state);
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(source.fsPath)), path.basename(source.fsPath)));
			const changed = () => this.schedule(source);
			watcher.onDidChange(changed); watcher.onDidCreate(changed); watcher.onDidDelete(changed);
			state.watcher = watcher;
			state.poller = setInterval(() => { void this.poll(source); }, SOURCE_POLL_INTERVAL_MS);
		}
		return state;
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
		} catch (error) {
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

	private async render(source: vscode.Uri, force: boolean): Promise<void> {
		const state = this.ensure(source);
		const generation = state.controller.begin(); state.controller.loading();
		try {
			const metadata = await vscode.workspace.fs.stat(source);
			state.metadata = metadata;
			state.missing = false;
			const executable = vscode.workspace.getConfiguration('remarkablePreview', source).get<string>('remderPath', 'reMder-client');
			const { contentHash, pdfPath } = await this.renders.getOrRender(source.toString(), metadata,
				async () => vscode.workspace.fs.readFile(source), executable, force, message => this.log(message, source));
			if (!force && state.contentHash === contentHash) { this.log('source unchanged after event', source); }
			if (!state.controller.pdf(generation, pdfPath)) { this.log('stale render completed; preview not replaced', source); return; }
			state.contentHash = contentHash;
			state.pdfPath = pdfPath;
			this.log('preview refreshed', source); this.cleanup(this.activePdfPaths());
		} catch (error) {
			const message = describeError(error);
			this.log(`renderer failed: ${message}`, source);
			state.controller.error(generation, isFileNotFound(error) ? 'The source file is no longer available.' : message);
			if (isFileNotFound(error)) {
				this.renders.invalidate(source.toString());
				state.watcher?.dispose(); state.watcher = undefined;
			}
		}
	}

	private stop(source: vscode.Uri): void { const state = this.sources.get(source.toString()); if (!state) { return; } if (state.timer) { clearTimeout(state.timer); } if (state.poller) { clearInterval(state.poller); } state.watcher?.dispose(); this.sources.delete(source.toString()); }
	private log(message: string, source?: vscode.Uri): void { this.output.appendLine(`${new Date().toISOString()} ${message}${source ? `: ${source.fsPath}` : ''}`); }
	private html(webview: vscode.Webview): string {
		const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.css'));
		const worker = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdfjs', 'pdf.worker.mjs'));
		const nonce = randomNonce();
		return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} blob: data:; script-src 'nonce-${nonce}'; worker-src ${webview.cspSource} blob:; connect-src ${webview.cspSource};"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${style}"></head><body><main id="app"><p>Loading reMarkable preview…</p></main><script nonce="${nonce}">window.__remarkableWorkerUri=${JSON.stringify(worker.toString())};</script><script nonce="${nonce}" src="${script}"></script></body></html>`;
	}
}

function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isFileNotFound(error: unknown): boolean { return error instanceof vscode.FileSystemError && error.code === 'FileNotFound'; }
function randomNonce(): string { return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join(''); }
