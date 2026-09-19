import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { RenderCache } from '../src/cache';
import { SourceFingerprintCache } from '../src/fingerprint';
import { createRendererBackend, RendererBackend, RenderRequest, RenderService } from '../src/render-service';
import { RendererIdentityCache } from '../src/renderer';

function request(
	source: string,
	contents: Uint8Array,
	executable = 'reMder-client',
	mtime = 100,
	backend: RendererBackend = createRendererBackend(executable),
): RenderRequest {
	return {
		source,
		metadata: { size: contents.length, mtime },
		read: async () => contents,
		backend,
	};
}

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
		const warmed = await service.getOrRender(request('file:///workspace/note.rmdoc', contents));
		const opened = await service.getOrRender(request('file:///workspace/note.rmdoc', contents));

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
		const initial = await service.getOrRender(request(source, first));
		service.invalidate(source);
		const changed = await service.getOrRender(request(source, second, 'reMder-client', 200));

		assert.equal(renders, 2);
		assert.notEqual(changed.pdfPath, initial.pdfPath);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('different client commands targeting one renderer instance are serialized', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-render-service-serial-'));
	let releaseFirst = () => {};
	try {
		let firstStarted = () => {};
		const firstDidStart = new Promise<void>(resolve => { firstStarted = resolve; });
		const firstCanFinish = new Promise<void>(resolve => { releaseFirst = resolve; });
		const started: string[] = [];
		const service = new RenderService(
			new RenderCache(directory),
			new SourceFingerprintCache(),
			new RendererIdentityCache(async () => 'renderer-v1'),
			async (_executable, contents, outputPath) => {
				const document = Buffer.from(contents).toString('utf8');
				started.push(document);
				if (document === 'first') {
					firstStarted();
					await firstCanFinish;
				}
				await fs.writeFile(outputPath, `%PDF-${document}`);
			},
		);
		const first = Buffer.from('first');
		const second = Buffer.from('second');
		const firstRequest = request('file:///workspace/first.rmdoc', first, 'first-client', 100,
			createRendererBackend('first-client', { instanceKey: 'shared-instance' }));
		const firstRender = service.getOrRender(firstRequest);
		await firstDidStart;
		const secondRequest = request('file:///workspace/second.rmdoc', second, 'second-client', 100,
			createRendererBackend('second-client', { instanceKey: 'shared-instance' }));
		const secondRender = service.getOrRender(secondRequest);
		await new Promise(resolve => setTimeout(resolve, 50));

		assert.deepEqual(started, ['first']);
		releaseFirst();
		await Promise.all([firstRender, secondRender]);
		assert.deepEqual(started, ['first', 'second']);
	} finally {
		releaseFirst();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('separate renderer instances can render concurrently and share cache identity', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-render-service-instances-'));
	let releaseForeground = () => {};
	try {
		let foregroundStarted = () => {};
		const foregroundDidStart = new Promise<void>(resolve => { foregroundStarted = resolve; });
		const foregroundCanFinish = new Promise<void>(resolve => { releaseForeground = resolve; });
		const started: string[] = [];
		const service = new RenderService(
			new RenderCache(directory),
			new SourceFingerprintCache(),
			new RendererIdentityCache(async executable => `identity:${executable}`),
			async (executable, contents, outputPath) => {
				started.push(executable);
				if (executable === 'foreground-client') {
					foregroundStarted();
					await foregroundCanFinish;
				}
				await fs.writeFile(outputPath, `%PDF-${Buffer.from(contents).toString('utf8')}`);
			},
		);
		const foregroundContents = Buffer.from('foreground');
		const foregroundRender = service.getOrRender(request('file:///workspace/foreground.rmdoc', foregroundContents, 'foreground-client'));
		await foregroundDidStart;
		const backgroundContents = Buffer.from('background');
		const backgroundRequest = request('file:///workspace/background.rmdoc', backgroundContents, 'background-client', 100,
			createRendererBackend('background-client', { cacheIdentity: 'foreground-client' }));
		await service.getOrRender(backgroundRequest);

		assert.deepEqual(started, ['foreground-client', 'background-client']);
		releaseForeground();
		await foregroundRender;

		const warmed = await service.getOrRender(request('file:///workspace/background.rmdoc', backgroundContents, 'foreground-client'));
		assert.equal(started.length, 2);
		assert.match(warmed.pdfPath, /\.pdf$/);
	} finally {
		releaseForeground();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
