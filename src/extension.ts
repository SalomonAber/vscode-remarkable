import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { calculateCacheKey, RenderCache } from './cache';
import { getRendererIdentity, RendererError, renderDocument } from './renderer';

const OPEN_PREVIEW = 'remarkablePreview.openPreview';
const OPEN_PREVIEW_TO_SIDE = 'remarkablePreview.openPreviewToSide';
const REFRESH_PREVIEW = 'remarkablePreview.refreshPreview';

export function activate(context: vscode.ExtensionContext): void {
	const cache = new RenderCache(getCacheDirectory(context));
	context.subscriptions.push(
		vscode.commands.registerCommand(OPEN_PREVIEW, (resource?: vscode.Uri) => openPreview(cache, resource, false, vscode.ViewColumn.Active)),
		vscode.commands.registerCommand(OPEN_PREVIEW_TO_SIDE, (resource?: vscode.Uri) => openPreview(cache, resource, false, vscode.ViewColumn.Beside)),
		vscode.commands.registerCommand(REFRESH_PREVIEW, (resource?: vscode.Uri) => openPreview(cache, resource, true, vscode.ViewColumn.Active)),
	);
}

function getCacheDirectory(context: vscode.ExtensionContext): string {
	if (context.globalStorageUri.scheme === 'file') {
		return vscode.Uri.joinPath(context.globalStorageUri, 'render-cache').fsPath;
	}
	const cacheRoot = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
	return path.join(cacheRoot, 'vscode-remarkable', 'render-cache');
}

async function openPreview(cache: RenderCache, resource: vscode.Uri | undefined, force: boolean, viewColumn: vscode.ViewColumn): Promise<void> {
	try {
		const source = resolveSource(resource);
		if (!source) {
			await vscode.window.showErrorMessage('Select or open a local .rmdoc file first.');
			return;
		}
		if (source.scheme !== 'file') {
			await vscode.window.showErrorMessage('reMarkable Preview can only render files available to the extension host filesystem.');
			return;
		}

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: force ? 'Refreshing reMarkable preview' : 'Opening reMarkable preview',
		}, async () => {
			const configuration = vscode.workspace.getConfiguration('remarkablePreview', source);
			const executable = configuration.get<string>('remderPath', 'reMder-client');
			const [contents, rendererIdentity] = await Promise.all([
				vscode.workspace.fs.readFile(source),
				getRendererIdentity(executable),
			]);
			const cacheKey = calculateCacheKey(contents, rendererIdentity, { remderPath: executable });
			const pdfPath = await cache.getOrRender(
				cacheKey,
				async temporaryPath => {
					await renderDocument(executable, source.fsPath, temporaryPath);
				},
				force,
			);
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(pdfPath), viewColumn);
		});
	} catch (error) {
		const detail = error instanceof RendererError ? error.summary : error instanceof Error ? error.message : String(error);
		await vscode.window.showErrorMessage(`Unable to render reMarkable preview: ${detail}`);
	}
}

function resolveSource(resource: vscode.Uri | undefined): vscode.Uri | undefined {
	const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	const activeTabUri = activeTabInput instanceof vscode.TabInputText || activeTabInput instanceof vscode.TabInputCustom
		? activeTabInput.uri
		: undefined;
	const candidate = resource ?? vscode.window.activeTextEditor?.document.uri ?? activeTabUri;
	return candidate && path.extname(candidate.path).toLowerCase() === '.rmdoc' ? candidate : undefined;
}

export function deactivate(): void {}
