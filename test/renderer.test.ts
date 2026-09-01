import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProcessRunner, renderDocument } from '../src/renderer';

test('Unicode and space-containing paths are passed as separate process arguments', async () => {
	const calls: Array<{ executable: string; args: readonly string[] }> = [];
	const runner: ProcessRunner = async (executable, args) => {
		calls.push({ executable, args });
		return { exitCode: 0, signal: null, stdout: 'ok', stderr: '' };
	};
	await renderDocument('/opt/reMder client', '/notes/Work/会議 Notes.rmdoc', '/cache/render result.pdf.tmp', runner);
	assert.deepEqual(calls, [{
		executable: '/opt/reMder client',
		args: ['/notes/Work/会議 Notes.rmdoc', '/cache/render result.pdf.tmp'],
	}]);
});