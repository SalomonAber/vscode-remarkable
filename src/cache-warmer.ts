import * as vscode from 'vscode';
import { RenderService } from './render-service';

const CHANGE_DEBOUNCE_MS = 500;

export class WorkspaceCacheWarmer implements vscode.Disposable {
	private readonly queue = new Map<string, vscode.Uri>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly watcher: vscode.FileSystemWatcher;
	private processing = false;
	private disposed = false;

	public constructor(
		private readonly renders: RenderService,
		private readonly output: vscode.OutputChannel,
		private readonly cleanup: () => void,
	) {
		this.watcher = vscode.workspace.createFileSystemWatcher('**/*.rmdoc');
		this.watcher.onDidCreate(source => this.schedule(source));
		this.watcher.onDidChange(source => this.schedule(source));
		this.watcher.onDidDelete(source => this.forget(source));
	}

	public async scan(): Promise<void> {
		if (this.disposed) { return; }
		try {
			const sources = await vscode.workspace.findFiles('**/*.rmdoc');
			const enabled = sources.filter(source => this.isEnabled(source));
			if (enabled.length) { this.log(`background cache scan queued ${enabled.length} file(s)`); }
			for (const source of enabled) { this.enqueue(source); }
		} catch (error) {
			this.log(`background cache scan failed: ${describeError(error)}`);
		}
	}

	public dispose(): void {
		this.disposed = true;
		this.watcher.dispose();
		for (const timer of this.timers.values()) { clearTimeout(timer); }
		this.timers.clear();
		this.queue.clear();
	}

	private schedule(source: vscode.Uri): void {
		const key = source.toString();
		this.renders.invalidate(key);
		const existing = this.timers.get(key);
		if (existing) { clearTimeout(existing); }
		if (!this.isEnabled(source)) { this.queue.delete(key); return; }
		this.timers.set(key, setTimeout(() => {
			this.timers.delete(key);
			this.enqueue(source);
		}, CHANGE_DEBOUNCE_MS));
	}

	private forget(source: vscode.Uri): void {
		const key = source.toString();
		this.renders.invalidate(key);
		this.queue.delete(key);
		const timer = this.timers.get(key);
		if (timer) { clearTimeout(timer); this.timers.delete(key); }
	}

	private enqueue(source: vscode.Uri): void {
		if (this.disposed || !this.isEnabled(source)) { return; }
		this.queue.set(source.toString(), source);
		void this.process();
	}

	private async process(): Promise<void> {
		if (this.processing || this.disposed) { return; }
		this.processing = true;
		try {
			while (!this.disposed && this.queue.size) {
				const next = this.queue.entries().next().value as [string, vscode.Uri] | undefined;
				if (!next) { break; }
				const [key, source] = next;
				this.queue.delete(key);
				if (!this.isEnabled(source)) { continue; }
				try {
					const metadata = await vscode.workspace.fs.stat(source);
					const executable = vscode.workspace.getConfiguration('remarkablePreview', source).get<string>('remderPath', 'reMder-client');
					await this.renders.getOrRender(key, metadata, async () => vscode.workspace.fs.readFile(source), executable, false,
						message => this.log(`background ${message}`, source));
					this.log('background cache ready', source);
					this.cleanup();
				} catch (error) {
					this.log(`background cache failed: ${describeError(error)}`, source);
				}
			}
		} finally {
			this.processing = false;
		}
	}

	private isEnabled(source: vscode.Uri): boolean {
		return vscode.workspace.getConfiguration('remarkablePreview', source).get<boolean>('prewarmCache', true);
	}

	private log(message: string, source?: vscode.Uri): void {
		this.output.appendLine(`${new Date().toISOString()} ${message}${source ? `: ${source.fsPath}` : ''}`);
	}
}

function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
