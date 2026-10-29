import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RenderCache } from './cache';
import { SourceFingerprintCache } from './fingerprint';
import { createRendererBackend, RenderService, SnapshotRenderer } from './render-service';

export interface McpWorkspace {
	root: string;
	remderPath: string;
	renderTimeoutMs: number;
}

export interface RenderedPdfResource {
	contentHash: string;
	name: string;
	pdfPath: string;
	sourcePath: string;
	uri: string;
	bytes: Uint8Array;
}

/**
 * File-backed adapter for the MCP process. It deliberately uses the same
 * RenderService and cache directory as the editor, so an editor render is an
 * MCP cache hit and vice versa.
 */
export class McpPdfService {
	private readonly renders: RenderService;

	public constructor(
		cacheDirectory: string,
		private readonly workspaces: readonly McpWorkspace[],
		render?: SnapshotRenderer,
	) {
		this.renders = new RenderService(new RenderCache(cacheDirectory), new SourceFingerprintCache(), render);
	}

	public async render(source: string): Promise<RenderedPdfResource> {
		const { sourcePath, workspace } = await resolveSource(source, this.workspaces);
		const stat = await fs.stat(sourcePath);
		const result = await this.renders.getOrRender({
			source: pathToFileURL(sourcePath).toString(),
			metadata: { size: stat.size, mtime: stat.mtimeMs },
			read: () => fs.readFile(sourcePath),
			backend: createRendererBackend(workspace.remderPath, { timeoutMs: workspace.renderTimeoutMs }),
		});
		const bytes = await fs.readFile(result.pdfPath);
		const pdfName = `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`;
		return {
			...result,
			bytes,
			name: pdfName,
			sourcePath,
			uri: `remarkable-preview://render/${result.contentHash}/${encodeURIComponent(pdfName)}`,
		};
	}
}

export async function resolveSource(
	requested: string,
	workspaces: readonly McpWorkspace[],
): Promise<{ sourcePath: string; workspace: McpWorkspace }> {
	if (!requested.trim()) {
		throw new Error('A .rmdoc path is required.');
	}
	if (!workspaces.length) {
		throw new Error('No file-backed workspace is available.');
	}
	const suppliedPath = requested.startsWith('file:') ? fileURLToPath(requested) : requested;
	const candidates = path.isAbsolute(suppliedPath)
		? [suppliedPath]
		: workspaces.map(workspace => path.resolve(workspace.root, suppliedPath));
	const existing = new Map<string, string>();
	for (const candidate of candidates) {
		try {
			const realPath = await fs.realpath(candidate);
			if ((await fs.stat(realPath)).isFile()) { existing.set(normalizeForComparison(realPath), realPath); }
		} catch {}
	}
	if (!existing.size) {
		throw new Error(`Document not found: ${requested}`);
	}
	if (existing.size > 1) {
		throw new Error(`Document path is ambiguous across workspace folders: ${requested}`);
	}
	const sourcePath = [...existing.values()][0];
	if (path.extname(sourcePath).toLowerCase() !== '.rmdoc') {
		throw new Error('Only .rmdoc documents can be rendered.');
	}
	const rooted = await Promise.all(workspaces.map(async workspace => ({
		workspace,
		root: await fs.realpath(workspace.root),
	})));
	const matches = rooted
		.filter(({ root }) => isWithin(root, sourcePath))
		.sort((left, right) => right.root.length - left.root.length);
	if (!matches.length) {
		throw new Error('The requested document is outside the current workspace.');
	}
	return { sourcePath, workspace: matches[0].workspace };
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeForComparison(filePath: string): string {
	return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}
