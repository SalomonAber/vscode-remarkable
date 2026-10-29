import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { McpPdfService, McpWorkspace } from '../src/mcp-pdf';

test('MCP rendering returns and reuses the editor render cache entry', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-mcp-cache-'));
	try {
		const workspacePath = path.join(directory, 'workspace');
		const cachePath = path.join(directory, 'cache');
		const sourcePath = path.join(workspacePath, 'Meeting notes.rmdoc');
		await fs.mkdir(workspacePath);
		await fs.writeFile(sourcePath, 'rmdoc contents');
		let renders = 0;
		const calls: Array<{ executable: string; timeoutMs?: number }> = [];
		const service = new McpPdfService(cachePath, [workspace(workspacePath)], async (executable, _contents, outputPath, options) => {
			renders += 1;
			calls.push({ executable, timeoutMs: options?.timeoutMs });
			await fs.writeFile(outputPath, '%PDF-cached');
		});

		const first = await service.render('Meeting notes.rmdoc');
		const second = await service.render(sourcePath);

		assert.equal(renders, 1);
		assert.deepEqual(calls, [{ executable: '/opt/reMder-client', timeoutMs: 42_000 }]);
		assert.equal(first.pdfPath, second.pdfPath);
		assert.equal(Buffer.from(second.bytes).toString(), '%PDF-cached');
		assert.equal(second.name, 'Meeting notes.pdf');
		assert.match(second.uri, /^remarkable-preview:\/\/render\/[a-f0-9]{64}\/Meeting%20notes\.pdf$/);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('MCP rendering refuses a document outside the workspace', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-mcp-boundary-'));
	try {
		const workspacePath = path.join(directory, 'workspace');
		const outsidePath = path.join(directory, 'outside.rmdoc');
		await fs.mkdir(workspacePath);
		await fs.writeFile(outsidePath, 'outside');
		const service = new McpPdfService(path.join(directory, 'cache'), [workspace(workspacePath)]);

		await assert.rejects(service.render(outsidePath), /outside the current workspace/);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('MCP rendering resolves symlinks before checking the workspace boundary', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-mcp-symlink-'));
	try {
		const workspacePath = path.join(directory, 'workspace');
		const outsidePath = path.join(directory, 'outside.rmdoc');
		const linkedPath = path.join(workspacePath, 'linked.rmdoc');
		await fs.mkdir(workspacePath);
		await fs.writeFile(outsidePath, 'outside');
		await fs.symlink(outsidePath, linkedPath);
		const service = new McpPdfService(path.join(directory, 'cache'), [workspace(workspacePath)]);

		await assert.rejects(service.render(linkedPath), /outside the current workspace/);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('a duplicate relative path in a multi-root workspace must be disambiguated', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-mcp-multiroot-'));
	try {
		const firstRoot = path.join(directory, 'first');
		const secondRoot = path.join(directory, 'second');
		await Promise.all([fs.mkdir(firstRoot), fs.mkdir(secondRoot)]);
		await Promise.all([
			fs.writeFile(path.join(firstRoot, 'notes.rmdoc'), 'first'),
			fs.writeFile(path.join(secondRoot, 'notes.rmdoc'), 'second'),
		]);
		const service = new McpPdfService(path.join(directory, 'cache'), [workspace(firstRoot), workspace(secondRoot)]);

		await assert.rejects(service.render('notes.rmdoc'), /ambiguous across workspace folders/);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

function workspace(root: string): McpWorkspace {
	return { root, remderPath: '/opt/reMder-client', renderTimeoutMs: 42_000 };
}
