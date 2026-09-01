import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreviewManager } from '../src/preview-manager';

test('watcher bursts are debounced and unchanged content does not require a presentation', async () => {
	const events: Array<{ source: string; generation: number }> = [];
	const manager = new PreviewManager(10, (source, generation) => events.push({ source, generation }));
	const generation = manager.begin('file:///note.rmdoc');
	assert.equal(manager.present('file:///note.rmdoc', generation, 'same', '/cache/same.pdf'), true);
	manager.scheduleChange('file:///note.rmdoc');
	manager.scheduleChange('file:///note.rmdoc');
	manager.scheduleChange('file:///note.rmdoc');
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.equal(events.length, 1);
	assert.equal(manager.state('file:///note.rmdoc')?.contentHash, 'same');
});

test('a stale render cannot replace a newer generation', () => {
	const manager = new PreviewManager(1, () => {});
	const first = manager.begin('file:///note.rmdoc');
	const second = manager.begin('file:///note.rmdoc');
	assert.equal(manager.present('file:///note.rmdoc', first, 'A', '/cache/a.pdf'), false);
	assert.equal(manager.present('file:///note.rmdoc', second, 'B', '/cache/b.pdf'), true);
	assert.equal(manager.state('file:///note.rmdoc')?.contentHash, 'B');
});

test('a source can remain tracked through transient events and be forgotten after permanent deletion', () => {
	const manager = new PreviewManager(1, () => {});
	const generation = manager.begin('file:///note.rmdoc');
	manager.present('file:///note.rmdoc', generation, 'A', '/cache/a.pdf');
	manager.scheduleChange('file:///note.rmdoc');
	assert.ok(manager.state('file:///note.rmdoc'));
	manager.forget('file:///note.rmdoc');
	assert.equal(manager.state('file:///note.rmdoc'), undefined);
});

test('closing the last generated PDF identifies its source for watcher cleanup', () => {
	const manager = new PreviewManager(1, () => {});
	const generation = manager.begin('file:///note.rmdoc');
	manager.present('file:///note.rmdoc', generation, 'A', '/cache/a.pdf');
	assert.deepEqual(manager.removePdf('/cache/a.pdf'), ['file:///note.rmdoc']);
});
