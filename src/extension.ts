import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { calculateCacheKeyForContentHash, RenderCache } from './cache';
import { SourceFingerprintCache } from './fingerprint';
import { PreviewManager } from './preview-manager';
import { RendererError, RendererIdentityCache, renderDocument } from './renderer';

const OPEN_PREVIEW = 'remarkablePreview.openPreview';
const OPEN_PREVIEW_TO_SIDE = 'remarkablePreview.openPreviewToSide';
const REFRESH_PREVIEW = 'remarkablePreview.refreshPreview';
const WATCH_DEBOUNCE_MS = 350;

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('reMarkable Preview');
	const cache = new RenderCache(getCacheDirectory(context));
	const fingerprints = new SourceFingerprintCache();
	const rendererIdentities = new RendererIdentityCache();
	const watchers = new Map<string, vscode.FileSystemWatcher>();
	const manager = new PreviewManager(WATCH_DEBOUNCE_MS, (source, generation) => {
		void refreshAfterSourceChange(vscode.Uri.parse(source), generation);
	});

	const log = (message: string, source?: vscode.Uri) => output.appendLine(`${new Date().toISOString()} ${message}${source ? `: ${source.fsPath}` : ''}`);

	const ensureWatcher = (source: vscode.Uri) => {
		const key = source.toString();
		if (watchers.has(key)) {return;}
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(source.fsPath)), path.basename(source.fsPath)));
		const onEvent = () => {
			log('source changed; waiting for filesystem to stabilize', source);
			manager.scheduleChange(key);
		};
		watcher.onDidChange(onEvent, undefined, context.subscriptions);
		watcher.onDidCreate(onEvent, undefined, context.subscriptions);
		watcher.onDidDelete(onEvent, undefined, context.subscriptions);
		watchers.set(key, watcher);
		context.subscriptions.push(watcher);
	};

	const stopTracking = (source: string) => {
		watchers.get(source)?.dispose();
		watchers.delete(source);
		fingerprints.forget(source);
		manager.forget(source);
	};

	const closePriorPreviews = async (knownPaths: ReadonlySet<string>, nextPdfPath: string) => {
		const staleTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
			.filter(tab => {
				const input = tab.input;
				const uri = input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
				return uri?.scheme === 'file' && knownPaths.has(uri.fsPath) && uri.fsPath !== nextPdfPath;
			});
		if (staleTabs.length) {await vscode.window.tabGroups.close(staleTabs, true);}
	};

	const renderAndPresent = async (source: vscode.Uri, generation: number, force: boolean, viewColumn: vscode.ViewColumn, announceFailure: boolean): Promise<void> => {
		try {
			const sourceKey = source.toString();
			const configuration = vscode.workspace.getConfiguration('remarkablePreview', source);
			const executable = configuration.get<string>('remderPath', 'reMder-client');
			const fingerprint = await fingerprints.get(sourceKey, await vscode.workspace.fs.stat(source), async () => vscode.workspace.fs.readFile(source));
			log(fingerprint.reused ? 'content hash reused from fingerprint' : 'content rehashed', source);
			const previous = manager.state(sourceKey);
			if (!force && !announceFailure && previous?.contentHash === fingerprint.contentHash) {
				log('source unchanged after event', source);
				return;
			}
			const rendererIdentity = await rendererIdentities.get(executable);
			const cacheKey = calculateCacheKeyForContentHash(fingerprint.contentHash, rendererIdentity, { remderPath: executable });
			const hit = !force && await cache.hasValidEntry(cacheKey);
			log(hit ? 'cache hit' : 'cache miss', source);
			const pdfPath = await cache.getOrRender(cacheKey, async temporaryPath => {
				log('renderer started', source);
				await renderDocument(executable, source.fsPath, temporaryPath);
				log('renderer completed', source);
			}, force);
			if (!manager.isCurrent(sourceKey, generation)) {
				log('stale render completed; preview not replaced', source);
				return;
			}
			const previousPaths = new Set(previous?.pdfPaths ?? []);
			if (!manager.present(sourceKey, generation, fingerprint.contentHash, pdfPath)) {return;}
			await closePriorPreviews(previousPaths, pdfPath);
			ensureWatcher(source);
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(pdfPath), viewColumn);
			log('preview refreshed', source);
			void cleanupCache(cache, manager, configuration.get<number>('cacheMaxSizeMB', 500), log);
		} catch (error) {
			log(`renderer failed: ${describeError(error)}`, source);
			if (!announceFailure && isFileNotFound(error)) {
				stopTracking(source.toString());
				await vscode.window.showWarningMessage(`reMarkable preview stopped: source file was removed (${path.basename(source.fsPath)}).`);
				return;
			}
			if (announceFailure) {await vscode.window.showErrorMessage(`Unable to render reMarkable preview: ${describeError(error)}`);}
		}
	};

	const refreshAfterSourceChange = async (source: vscode.Uri, generation: number) => {
		const sourceKey = source.toString();
		try {
			const autoRefresh = vscode.workspace.getConfiguration('remarkablePreview', source).get<boolean>('autoRefresh', true);
			if (!autoRefresh) { log('source changed; auto refresh disabled', source); return; }
			await renderAndPresent(source, generation, false, vscode.ViewColumn.Active, false);
		} catch {
			// renderAndPresent handles errors; this keeps future filesystem events usable.
		}
		if (!manager.state(sourceKey)) {return;}
	};

	const openPreview = async (resource: vscode.Uri | undefined, force: boolean, viewColumn: vscode.ViewColumn) => {
		const source = resolveSource(resource);
		if (!source) { await vscode.window.showErrorMessage('Select or open a local .rmdoc file first.'); return; }
		if (source.scheme !== 'file') { await vscode.window.showErrorMessage('reMarkable Preview can only render files available to the extension host filesystem.'); return; }
		const generation = manager.begin(source.toString());
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: force ? 'Refreshing reMarkable preview' : 'Opening reMarkable preview' }, () => renderAndPresent(source, generation, force, viewColumn, true));
	};

	context.subscriptions.push(output,
		vscode.commands.registerCommand(OPEN_PREVIEW, (resource?: vscode.Uri) => openPreview(resource, false, vscode.ViewColumn.Active)),
		vscode.commands.registerCommand(OPEN_PREVIEW_TO_SIDE, (resource?: vscode.Uri) => openPreview(resource, false, vscode.ViewColumn.Beside)),
		vscode.commands.registerCommand(REFRESH_PREVIEW, (resource?: vscode.Uri) => openPreview(resource, true, vscode.ViewColumn.Active)),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('remarkablePreview.remderPath')) {
				rendererIdentities.invalidate();
				log('renderer path changed; identity cache invalidated');
			}
		}),
		vscode.window.tabGroups.onDidChangeTabs(event => {
			for (const tab of event.closed) {
				const input = tab.input;
				const uri = input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
				if (!uri || uri.scheme !== 'file') {continue;}
				for (const source of manager.removePdf(uri.fsPath)) {stopTracking(source);}
			}
		}),
	);
	void cleanupCache(cache, manager, vscode.workspace.getConfiguration('remarkablePreview').get<number>('cacheMaxSizeMB', 500), log);
}

async function cleanupCache(cache: RenderCache, manager: PreviewManager, maxSizeMB: number, log: (message: string) => void): Promise<void> {
	const removed = await cache.cleanup(Math.max(1, maxSizeMB) * 1024 * 1024, manager.activePdfPaths());
	if (removed.length) {log(`cache cleanup removed ${removed.length} unused PDF(s)`);}
}

function getCacheDirectory(context: vscode.ExtensionContext): string {
	if (context.globalStorageUri.scheme === 'file') {return vscode.Uri.joinPath(context.globalStorageUri, 'render-cache').fsPath;}
	return path.join(process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache'), 'vscode-remarkable', 'render-cache');
}

function describeError(error: unknown): string {
	return error instanceof RendererError ? error.summary : error instanceof Error ? error.message : String(error);
}

function isFileNotFound(error: unknown): boolean {
	return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

function resolveSource(resource: vscode.Uri | undefined): vscode.Uri | undefined {
	const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	const activeTabUri = activeTabInput instanceof vscode.TabInputText || activeTabInput instanceof vscode.TabInputCustom ? activeTabInput.uri : undefined;
	const candidate = resource ?? vscode.window.activeTextEditor?.document.uri ?? activeTabUri;
	return candidate && path.extname(candidate.path).toLowerCase() === '.rmdoc' ? candidate : undefined;
}

export function deactivate(): void {}
