import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RenderCache } from './cache';
import { WorkspaceCacheWarmer } from './cache-warmer';
import { SourceFingerprintCache } from './fingerprint';
import { RemarkableEditorProvider, REMARKABLE_EDITOR_VIEW_TYPE } from './remarkable-editor';
import { RenderService } from './render-service';
import { RendererIdentityCache } from './renderer';

const OPEN_PREVIEW = 'remarkablePreview.openPreview';
const OPEN_PREVIEW_TO_SIDE = 'remarkablePreview.openPreviewToSide';
const REFRESH_PREVIEW = 'remarkablePreview.refreshPreview';
const EXPORT_PDF = 'remarkablePreview.exportPdf';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('reMarkable Preview');
	const cacheDirectory = getCacheDirectory(context);
	const cache = new RenderCache(cacheDirectory);
	const identities = new RendererIdentityCache();
	const renders = new RenderService(cache, new SourceFingerprintCache(), identities);
	const provider = new RemarkableEditorProvider(context, renders, cacheDirectory, output,
		protectedPaths => void cleanupCache(cache, protectedPaths, vscode.workspace.getConfiguration('remarkablePreview').get<number>('cacheMaxSizeMB', 500), output));
	const warmer = new WorkspaceCacheWarmer(renders, output,
		() => void cleanupCache(cache, provider.activePdfPaths(), vscode.workspace.getConfiguration('remarkablePreview').get<number>('cacheMaxSizeMB', 500), output));
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
	const exportPdf = async (resource?: vscode.Uri) => {
		const source = resolveSource(resource);
		if (!source) { await vscode.window.showErrorMessage('Select or open a .rmdoc file first.'); return; }
		if (source.scheme !== 'file') { await vscode.window.showErrorMessage('reMarkable Preview requires a file available to the extension host.'); return; }
		let pdfPath: string;
		try {
			pdfPath = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Rendering ${path.basename(source.fsPath)}…` },
				() => provider.pdfFor(source));
		} catch (error) {
			await vscode.window.showErrorMessage(`reMarkable Preview could not render the document: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const target = await vscode.window.showSaveDialog({
			title: 'Export Rendered PDF',
			defaultUri: source.with({ path: source.path.replace(/\.rmdoc$/i, '.pdf') }),
			filters: { PDF: ['pdf'] },
		});
		if (!target) { return; }
		try {
			await vscode.workspace.fs.copy(vscode.Uri.file(pdfPath), target, { overwrite: true });
		} catch (error) {
			await vscode.window.showErrorMessage(`reMarkable Preview could not write the PDF: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		output.appendLine(`${new Date().toISOString()} exported PDF to ${target.fsPath}: ${source.fsPath}`);
		const action = await vscode.window.showInformationMessage(`Exported ${path.basename(target.path)}.`, 'Open');
		if (action) { await vscode.commands.executeCommand('vscode.open', target); }
	};
	context.subscriptions.push(output, provider, warmer,
		vscode.window.registerCustomEditorProvider(REMARKABLE_EDITOR_VIEW_TYPE, provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }),
		vscode.commands.registerCommand(OPEN_PREVIEW, (resource?: vscode.Uri) => open(resource, false)),
		vscode.commands.registerCommand(OPEN_PREVIEW_TO_SIDE, (resource?: vscode.Uri) => open(resource, true)),
		vscode.commands.registerCommand(REFRESH_PREVIEW, refresh),
		vscode.commands.registerCommand(EXPORT_PDF, (resource?: vscode.Uri) => exportPdf(resource)),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('remarkablePreview.remderPath')) {
				identities.invalidate();
				output.appendLine(`${new Date().toISOString()} renderer path changed; identity cache invalidated`);
				void warmer.scan();
			}
			if (event.affectsConfiguration('remarkablePreview.backgroundRemderPath')) { void warmer.scan(); }
			if (event.affectsConfiguration('remarkablePreview.prewarmCache')) { void warmer.scan(); }
		}),
	);
	void cleanupCache(cache, provider.activePdfPaths(), vscode.workspace.getConfiguration('remarkablePreview').get<number>('cacheMaxSizeMB', 500), output);
	void warmer.scan();
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
