import * as path from 'node:path';
import * as vscode from 'vscode';
import { renderTimeoutMs } from './configuration';
import type { McpServerConfiguration } from './mcp-server';

export const REMARKABLE_MCP_PROVIDER_ID = 'remarkablePreview.renderedPdf';

export class RemarkableMcpServerDefinitionProvider implements vscode.McpServerDefinitionProvider, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	public readonly onDidChangeMcpServerDefinitions = this.changed.event;

	public constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly cacheDirectory: string,
	) {}

	public provideMcpServerDefinitions(): vscode.McpServerDefinition[] {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
		if (!folders.length) { return []; }
		const configuration: McpServerConfiguration = {
			cacheDirectory: this.cacheDirectory,
			version: String(this.context.extension.packageJSON.version),
			workspaces: folders.map(folder => ({
				root: folder.uri.fsPath,
				remderPath: vscode.workspace.getConfiguration('remarkablePreview', folder.uri).get<string>('remderPath', 'reMder-client'),
				renderTimeoutMs: renderTimeoutMs(folder.uri),
			})),
		};
		const definition = new vscode.McpStdioServerDefinition(
			'reMarkable Preview',
			process.execPath,
			[this.context.asAbsolutePath(path.join('dist', 'mcp-server.js'))],
			{ REMARKABLE_PREVIEW_MCP_CONFIG: JSON.stringify(configuration) },
			configuration.version,
		);
		definition.cwd = folders[0].uri;
		return [definition];
	}

	public refresh(): void { this.changed.fire(); }
	public dispose(): void { this.changed.dispose(); }
}
