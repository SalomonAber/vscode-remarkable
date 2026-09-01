import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RenderCache } from './cache';
import { SourceFingerprintCache } from './fingerprint';
import { RemarkableEditorProvider, REMARKABLE_EDITOR_VIEW_TYPE } from './remarkable-editor';
import { RendererIdentityCache } from './renderer';

const OPEN_PREVIEW = 'remarkablePreview.openPreview';
const OPEN_PREVIEW_TO_SIDE = 'remarkablePreview.openPreviewToSide';
const REFRESH_PREVIEW = 'remarkablePreview.refreshPreview';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('reMarkable Preview');
	const cacheDirectory = getCacheDirectory(context);
	const cache = new RenderCache(cacheDirectory);
	const identities = new RendererIdentityCache();
	const provider = new RemarkableEditorProvider(context, cache, cacheDirectory, new SourceFingerprintCache(), identities, output,
		protectedPaths => void cleanupCache(cache, protectedPaths, vscode.workspace.getConfiguration('remarkablePreview').get<number>('cacheMaxSizeMB', 500), output));
	const open = async (resource: vscode.Uri | undefined, side: boolean) => {
		const source = resolveSource(resource);
		if (!source) { await vscode.window.showErrorMessage('Select or open a .rmdoc file first.'); return; }
		if (source.scheme !== 'file') { await vscode.window.showErrorMessage('reMarkable Preview requires a file available to the extension host.'); return; }
		await vscode.commands.executeCommand('vscode.openWith', source, REMARKABLE_EDITOR_VIEW_TYPE, side ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active);
	};
	const refresh = async (resource?: vscode.Uri) => {
		const source = resolveSource(resource);
		if (!source) { await vscode.window.showErrorMessage('Select or open a .rmdoc file first.'); return; }
		if (!provider.isOpen(source)) { await open(source, false); return; }
		await provider.refresh(source, true);
	};
	context.subscriptions.push(output, provider,
		vscode.window.registerCustomEditorProvider(REMARKABLE_EDITOR_VIEW_TYPE, provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }),
		vscode.commands.registerCommand(OPEN_PREVIEW, (resource?: vscode.Uri) => open(resource, false)),
		vscode.commands.registerCommand(OPEN_PREVIEW_TO_SIDE, (resource?: vscode.Uri) => open(resource, true)),
		vscode.commands.registerCommand(REFRESH_PREVIEW, refresh),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('remarkablePreview.remderPath')) { identities.invalidate(); output.appendLine(`${new Date().toISOString()} renderer path changed; identity cache invalidated`); }
		}),
	);
	void cleanupCache(cache, provider.activePdfPaths(), vscode.workspace.getConfiguration('remarkablePreview').get<number>('cacheMaxSizeMB', 500), output);
}

async function cleanupCache(cache: RenderCache, protectedPaths: ReadonlySet<string>, maxSizeMB: number, output: vscode.OutputChannel): Promise<void> {
	const removed = await cache.cleanup(Math.max(1, maxSizeMB) * 1024 * 1024, protectedPaths);
	if (removed.length) { output.appendLine(`${new Date().toISOString()} cache cleanup removed ${removed.length} unused PDF(s)`); }
}

function getCacheDirectory(context: vscode.ExtensionContext): string {
	if (context.globalStorageUri.scheme === 'file') { return vscode.Uri.joinPath(context.globalStorageUri, 'render-cache').fsPath; }
	return path.join(process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache'), 'vscode-remarkable', 'render-cache');
}

function resolveSource(resource: vscode.Uri | undefined): vscode.Uri | undefined {
	const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	const activeUri = active instanceof vscode.TabInputText || active instanceof vscode.TabInputCustom ? active.uri : undefined;
	const candidate = resource ?? vscode.window.activeTextEditor?.document.uri ?? activeUri;
	return candidate && path.extname(candidate.path).toLowerCase() === '.rmdoc' ? candidate : undefined;
}

export function deactivate(): void {}
