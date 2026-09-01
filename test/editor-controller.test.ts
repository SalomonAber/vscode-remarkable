import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorController, escapeHtml, isIncomingEditorMessage } from '../src/editor-controller';

class Sink {
	public readonly messages: unknown[] = [];
	public post(message: unknown): void { this.messages.push(message); }
}

test('source editor identity can have multiple views which share one result', () => {
	const controller = new EditorController();
	const one = new Sink(); const two = new Sink();
	controller.add(one); controller.add(two);
	const generation = controller.begin();
	assert.equal(controller.pdf(generation, '/cache/render.pdf'), true);
	assert.deepEqual(one.messages, [{ type: 'pdf', uri: '/cache/render.pdf' }]);
	assert.deepEqual(two.messages, [{ type: 'pdf', uri: '/cache/render.pdf' }]);
});

test('disposed previews ignore late render completion and stale completions never replace newer', () => {
	const controller = new EditorController(); const sink = new Sink(); const dispose = controller.add(sink);
	const old = controller.begin(); const current = controller.begin();
	assert.equal(controller.pdf(old, '/cache/old.pdf'), false);
	dispose();
	assert.equal(controller.pdf(current, '/cache/new.pdf'), true);
	assert.equal(sink.messages.length, 0);
});

test('refresh sends a new PDF to existing previews and failures have stable data', () => {
	const controller = new EditorController(); const sink = new Sink(); controller.add(sink);
	const first = controller.begin(); controller.pdf(first, '/cache/one.pdf');
	const refreshed = controller.begin(); controller.pdf(refreshed, '/cache/two.pdf');
	const failed = controller.begin(); controller.error(failed, 'source is unavailable');
	assert.deepEqual(sink.messages, [
		{ type: 'pdf', uri: '/cache/one.pdf' }, { type: 'pdf', uri: '/cache/two.pdf' }, { type: 'error', message: 'source is unavailable' },
	]);
});

test('retry and webview messages are strictly validated', () => {
	assert.equal(isIncomingEditorMessage({ type: 'retry' }), true);
	assert.equal(isIncomingEditorMessage({ type: 'openOutput' }), true);
	assert.equal(isIncomingEditorMessage({ type: 'viewState', page: 1, zoom: 1, scrollTop: 0 }), true);
	assert.equal(isIncomingEditorMessage({ type: 'retry', extra: true }), false);
	assert.equal(isIncomingEditorMessage({ type: 'pdf', uri: 'file:///etc/passwd' }), false);
	assert.equal(isIncomingEditorMessage(null), false);
});

test('HTML-sensitive names are escaped without relying on prior preview state', () => {
	assert.equal(escapeHtml('<Notes & "draft">'), '&lt;Notes &amp; &quot;draft&quot;&gt;');
	const restored = new EditorController(); const sink = new Sink(); restored.add(sink);
	const generation = restored.begin(); restored.pdf(generation, '/cache/reused.pdf');
	assert.deepEqual(sink.messages, [{ type: 'pdf', uri: '/cache/reused.pdf' }]);
});
