import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { calculateCacheKey, getCachePath, RenderCache } from '../src/cache';

test('cache key changes when content changes', () => {
	const settings = { remderPath: 'reMder-client' };
	assert.notEqual(calculateCacheKey(Buffer.from('first'), 'renderer-v1', settings), calculateCacheKey(Buffer.from('second'), 'renderer-v1', settings));
});

test('identical content and settings produce an identical cache key', () => {
	assert.equal(
		calculateCacheKey(Buffer.from('same'), 'renderer-v1', { quality: 1, color: true }),
		calculateCacheKey(Buffer.from('same'), 'renderer-v1', { color: true, quality: 1 }),
	);
});

test('cache path is confined to the cache directory', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-cache-path-'));
	try {
		const key = 'a'.repeat(64);
		const cachePath = getCachePath(directory, key);
		assert.equal(path.dirname(cachePath), directory);
		assert.equal(path.basename(cachePath), `${key}.pdf`);
		assert.throws(() => getCachePath(directory, '../escape'));
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('successful render is promoted atomically into the cache', async () => {
	await withCache(async (cache, directory) => {
		const key = 'b'.repeat(64);
		const result = await cache.getOrRender(key, async temporaryPath => {
			assert.equal(temporaryPath, `${getCachePath(directory, key)}.tmp`);
			await fs.writeFile(temporaryPath, '%PDF-rendered');
		});
		assert.equal(await fs.readFile(result, 'utf8'), '%PDF-rendered');
		await assert.rejects(fs.stat(`${result}.tmp`));
	});
});

test('normal open uses the cache and refresh replaces it', async () => {
	await withCache(async cache => {
		const key = 'e'.repeat(64);
		let renders = 0;
		const render = async (temporaryPath: string) => {
			renders += 1;
			await fs.writeFile(temporaryPath, `%PDF-${renders}`);
		};
		const firstPath = await cache.getOrRender(key, render);
		await cache.getOrRender(key, render);
		assert.equal(renders, 1);
		await cache.getOrRender(key, render, true);
		assert.equal(renders, 2);
		assert.equal(await fs.readFile(firstPath, 'utf8'), '%PDF-2');
	});
});

test('failed render leaves no valid cache entry', async () => {
	await withCache(async (cache, directory) => {
		const key = 'c'.repeat(64);
		await assert.rejects(cache.getOrRender(key, async temporaryPath => {
			await fs.writeFile(temporaryPath, 'partial');
			throw new Error('render failed');
		}), /render failed/);
		await assert.rejects(fs.stat(getCachePath(directory, key)));
		await assert.rejects(fs.stat(`${getCachePath(directory, key)}.tmp`));
	});
});

test('concurrent rendering for one key is deduplicated', async () => {
	await withCache(async cache => {
		const key = 'd'.repeat(64);
		let renders = 0;
		let releaseRender: (() => void) | undefined;
		const blocked = new Promise<void>(resolve => { releaseRender = resolve; });
		const render = async (temporaryPath: string) => {
			renders += 1;
			await blocked;
			await fs.writeFile(temporaryPath, '%PDF-shared');
		};
		const first = cache.getOrRender(key, render);
		const second = cache.getOrRender(key, render);
		releaseRender?.();
		const [firstPath, secondPath] = await Promise.all([first, second]);
		assert.equal(renders, 1);
		assert.equal(firstPath, secondPath);
	});
});

test('cache cleanup removes oldest unused entries first', async () => {
	await withCache(async (cache, directory) => {
		const oldPath = getCachePath(directory, '1'.repeat(64));
		const newPath = getCachePath(directory, '2'.repeat(64));
		await fs.writeFile(oldPath, '%PDF-old');
		await fs.writeFile(newPath, '%PDF-new');
		await fs.utimes(oldPath, new Date(1_000), new Date(1_000));
		await fs.utimes(newPath, new Date(2_000), new Date(2_000));
		assert.deepEqual(await cache.cleanup(8), [oldPath]);
		await assert.rejects(fs.stat(oldPath));
		await fs.stat(newPath);
	});
});

test('cache cleanup preserves active and in-flight entries', async () => {
	await withCache(async (cache, directory) => {
		const activePath = getCachePath(directory, '3'.repeat(64));
		const removablePath = getCachePath(directory, '4'.repeat(64));
		await fs.writeFile(activePath, '%PDF-active');
		await fs.writeFile(removablePath, '%PDF-old');
		await fs.utimes(removablePath, new Date(1_000), new Date(1_000));
		const key = '5'.repeat(64);
		let release: (() => void) | undefined;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		const inFlight = cache.getOrRender(key, async temporaryPath => { await blocked; await fs.writeFile(temporaryPath, '%PDF-in-flight'); });
		await new Promise(resolve => setImmediate(resolve));
		await cache.cleanup(1, new Set([activePath]));
		await fs.stat(activePath);
		await assert.rejects(fs.stat(removablePath));
		release?.();
		await inFlight;
	});
});

async function withCache(run: (cache: RenderCache, directory: string) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-cache-'));
	try {
		await run(new RenderCache(directory), directory);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}
