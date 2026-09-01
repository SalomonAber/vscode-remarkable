import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProcessRunner, RendererIdentityCache, renderDocument, renderSnapshot } from '../src/renderer';

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

test('renderer identity is reused and changing path selects a different identity', async () => {
	let resolutions = 0;
	const identities = new RendererIdentityCache(async executable => {
		resolutions += 1;
		return `identity:${executable}`;
	});
	assert.equal(await identities.get('/one'), 'identity:/one');
	assert.equal(await identities.get('/one'), 'identity:/one');
	assert.equal(resolutions, 1);
	assert.equal(await identities.get('/two'), 'identity:/two');
	assert.equal(resolutions, 2);
});

test('renderer receives an immutable cache-local input snapshot that is cleaned up', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-renderer-'));
	const output = path.join(directory, 'output.pdf.tmp');
	try {
		let inputPath = '';
		await renderSnapshot('/opt/reMder client', Buffer.from('rmdoc bytes'), output, async (_executable, args) => {
			inputPath = args[0];
			assert.equal(await fs.readFile(inputPath, 'utf8'), 'rmdoc bytes');
			await fs.writeFile(args[1], '%PDF-snapshot');
			return { exitCode: 0, signal: null, stdout: '', stderr: '' };
		});
		assert.equal(await fs.readFile(output, 'utf8'), '%PDF-snapshot');
		await assert.rejects(fs.stat(inputPath));
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
