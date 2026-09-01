import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceFingerprintCache } from '../src/fingerprint';
import { calculateCacheKeyForContentHash } from '../src/cache';

test('unchanged size and mtime reuse a remembered content hash', async () => {
	const cache = new SourceFingerprintCache();
	let reads = 0;
	const read = async () => { reads += 1; return Buffer.from('same'); };
	const first = await cache.get('file:///note.rmdoc', { size: 4, mtime: 100 }, read);
	const second = await cache.get('file:///note.rmdoc', { size: 4, mtime: 100 }, read);
	assert.equal(reads, 1);
	assert.equal(first.contentHash, second.contentHash);
	assert.equal(second.reused, true);
});

test('changed metadata causes a content rehash and changed content gets a new render key', async () => {
	const cache = new SourceFingerprintCache();
	const first = await cache.get('file:///note.rmdoc', { size: 4, mtime: 100 }, async () => Buffer.from('one!'));
	const second = await cache.get('file:///note.rmdoc', { size: 4, mtime: 101 }, async () => Buffer.from('two!'));
	assert.equal(second.reused, false);
	assert.notEqual(first.contentHash, second.contentHash);
	assert.notEqual(
		calculateCacheKeyForContentHash(first.contentHash, 'renderer', {}),
		calculateCacheKeyForContentHash(second.contentHash, 'renderer', {}),
	);
});
