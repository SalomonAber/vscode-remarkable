import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { RenderCache } from '../src/cache';
import { SourceFingerprintCache } from '../src/fingerprint';
import { RenderService } from '../src/render-service';
import { RendererIdentityCache } from '../src/renderer';

test('background and interactive requests share the same cached render', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-render-service-'));
	try {
		let renders = 0;
		const service = new RenderService(
			new RenderCache(directory),
			new SourceFingerprintCache(),
			new RendererIdentityCache(async () => 'renderer-v1'),
			async (_executable, _contents, outputPath) => {
				renders += 1;
				await fs.writeFile(outputPath, `%PDF-${renders}`);
			},
		);
		const contents = Buffer.from('rmdoc contents');
		const metadata = { size: contents.length, mtime: 100 };
		const read = async () => contents;
		const warmed = await service.getOrRender('file:///workspace/note.rmdoc', metadata, read, 'reMder-client');
		const opened = await service.getOrRender('file:///workspace/note.rmdoc', metadata, read, 'reMder-client');

		assert.equal(renders, 1);
		assert.equal(opened.pdfPath, warmed.pdfPath);
		assert.equal(opened.contentHash, warmed.contentHash);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('changed source metadata and contents create a new warmed render', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-render-service-change-'));
	try {
		let renders = 0;
		const service = new RenderService(
			new RenderCache(directory),
			new SourceFingerprintCache(),
			new RendererIdentityCache(async () => 'renderer-v1'),
			async (_executable, _contents, outputPath) => {
				renders += 1;
				await fs.writeFile(outputPath, `%PDF-${renders}`);
			},
		);
		const source = 'file:///workspace/note.rmdoc';
		const first = Buffer.from('first');
		const second = Buffer.from('second');
		const initial = await service.getOrRender(source, { size: first.length, mtime: 100 }, async () => first, 'reMder-client');
		service.invalidate(source);
		const changed = await service.getOrRender(source, { size: second.length, mtime: 200 }, async () => second, 'reMder-client');

		assert.equal(renders, 2);
		assert.notEqual(changed.pdfPath, initial.pdfPath);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
