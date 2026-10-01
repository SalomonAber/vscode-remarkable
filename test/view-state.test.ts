import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPreviewViewState, PreviewViewState, VIEW_STATE_STORAGE_KEY, ViewStateStore } from '../src/view-state';

class Storage {
	public writes = 0;
	private value: unknown;
	public constructor(initial?: unknown) { this.value = initial; }
	public get<T>(key: string): T | undefined { return key === VIEW_STATE_STORAGE_KEY ? this.value as T : undefined; }
	public update(key: string, value: unknown): void { assert.equal(key, VIEW_STATE_STORAGE_KEY); this.value = value; this.writes += 1; }
	public stored(): Record<string, PreviewViewState> { return (this.value ?? {}) as Record<string, PreviewViewState>; }
}

const position = (top: number): PreviewViewState => ({ page: 3, scale: 'page-width', top, left: 12 });

test('a remembered position is returned for the same source', () => {
	const store = new ViewStateStore();
	store.remember('file:///workspace/note.rmdoc', position(640));
	assert.deepEqual(store.get('file:///workspace/note.rmdoc'), position(640));
	assert.equal(store.get('file:///workspace/other.rmdoc'), undefined);
});

test('positions survive a restart and ignore unusable persisted entries', () => {
	const storage = new Storage({
		'file:///workspace/kept.rmdoc': position(640),
		'file:///workspace/partial.rmdoc': { page: 1, top: 0, left: 0 },
		'file:///workspace/broken.rmdoc': { page: 1, scale: 'auto', top: Number.NaN, left: 0 },
		// Written by the viewer before it tracked pdf.js destinations.
		'file:///workspace/older.rmdoc': { zoom: 1, scrollTop: 400, scrollLeft: 0 },
		'file:///workspace/hostile.rmdoc': 'not a position',
	});
	const store = new ViewStateStore(storage);

	assert.deepEqual(store.get('file:///workspace/kept.rmdoc'), position(640));
	assert.equal(store.get('file:///workspace/partial.rmdoc'), undefined);
	assert.equal(store.get('file:///workspace/broken.rmdoc'), undefined);
	assert.equal(store.get('file:///workspace/older.rmdoc'), undefined);
	assert.equal(store.get('file:///workspace/hostile.rmdoc'), undefined);
});

test('a stream of scroll reports is coalesced into one write', async () => {
	const storage = new Storage();
	const store = new ViewStateStore(storage, 10);
	for (let offset = 0; offset < 50; offset += 1) { store.remember('file:///workspace/note.rmdoc', position(offset)); }

	assert.equal(storage.writes, 0);
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.equal(storage.writes, 1);
	assert.deepEqual(storage.stored(), { 'file:///workspace/note.rmdoc': position(49) });
});

test('a closing window writes the last position through immediately', () => {
	const storage = new Storage();
	const store = new ViewStateStore(storage, 60_000);
	store.remember('file:///workspace/note.rmdoc', position(640));
	store.dispose();

	assert.equal(storage.writes, 1);
	assert.deepEqual(storage.stored(), { 'file:///workspace/note.rmdoc': position(640) });
});

test('only the most recently used positions are kept', () => {
	const storage = new Storage();
	const store = new ViewStateStore(storage, 1);
	for (let index = 0; index < 260; index += 1) { store.remember(`file:///workspace/note-${index}.rmdoc`, position(index)); }
	// Touching an early survivor again must keep it ahead of the eviction edge.
	store.remember('file:///workspace/note-100.rmdoc', position(1));
	for (let index = 260; index < 320; index += 1) { store.remember(`file:///workspace/note-${index}.rmdoc`, position(index)); }
	store.flush();

	const kept = Object.keys(storage.stored());
	assert.equal(kept.length, 200);
	assert.equal(store.get('file:///workspace/note-0.rmdoc'), undefined);
	assert.deepEqual(store.get('file:///workspace/note-100.rmdoc'), position(1));
	assert.deepEqual(store.get('file:///workspace/note-319.rmdoc'), position(319));
});

test('a forgotten source stops being restored', () => {
	const storage = new Storage();
	const store = new ViewStateStore(storage, 1);
	store.remember('file:///workspace/note.rmdoc', position(640));
	store.forget('file:///workspace/note.rmdoc');
	store.flush();

	assert.equal(store.get('file:///workspace/note.rmdoc'), undefined);
	assert.deepEqual(storage.stored(), {});
});

test('a store without storage still remembers for the session', () => {
	const store = new ViewStateStore();
	store.remember('file:///workspace/note.rmdoc', position(640));
	store.flush();
	store.dispose();
	assert.deepEqual(store.get('file:///workspace/note.rmdoc'), position(640));
});

test('view state is validated before it is trusted', () => {
	assert.equal(isPreviewViewState({ page: 1, scale: 'page-width', top: 0, left: 0 }), true);
	assert.equal(isPreviewViewState({ page: 4, scale: '1.25', top: 120, left: -8 }), true);
	assert.equal(isPreviewViewState({ page: 1, scale: 'auto', top: 0, left: 0, extra: true }), true);
	assert.equal(isPreviewViewState({ page: 1, scale: 'auto', top: 0 }), false);
	assert.equal(isPreviewViewState({ page: 0, scale: 'auto', top: 0, left: 0 }), false);
	assert.equal(isPreviewViewState({ page: 1, scale: '', top: 0, left: 0 }), false);
	assert.equal(isPreviewViewState({ page: 1, scale: 1.25, top: 0, left: 0 }), false);
	assert.equal(isPreviewViewState({ page: 1, scale: 'auto', top: Number.POSITIVE_INFINITY, left: 0 }), false);
	assert.equal(isPreviewViewState(null), false);
});
