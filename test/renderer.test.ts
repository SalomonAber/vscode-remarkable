import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProcessRunner, renderDocument, renderSnapshot } from '../src/renderer';

test('Unicode and space-containing paths are passed as separate process arguments', async () => {
	const calls: Array<{ executable: string; args: readonly string[] }> = [];
	const runner: ProcessRunner = async (executable, args) => {
		calls.push({ executable, args });
		return { exitCode: 0, signal: null, stdout: 'ok', stderr: '' };
	};
	await renderDocument('/opt/reMder client', '/notes/Work/会議 Notes.rmdoc', '/cache/render result.pdf.tmp', { runner });
	assert.deepEqual(calls, [{
		executable: '/opt/reMder client',
		args: ['/notes/Work/会議 Notes.rmdoc', '/cache/render result.pdf.tmp'],
	}]);
});

test('a renderer that never returns is stopped rather than waited on forever', async () => {
	// Nothing above this layer can recover from a client that hangs: the cache entry
	// stays in flight, every other document queues behind it, and a refresh joins
	// the same stuck promise. So the limit has to be enforced here, against a real
	// child process that genuinely will not exit on its own.
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-hang-'));
	try {
		const output = path.join(directory, 'output.pdf.tmp');
		// Stands in for a wedged reMder-client: the snapshot is handed to a real child
		// process that will not exit until something stops it.
		await assert.rejects(
			renderSnapshot(process.execPath, Buffer.from('setInterval(() => {}, 1000);'), output, { timeoutMs: 250 }),
			/did not finish within 250ms and was stopped/,
		);
		// The snapshot it was reading is cleaned up even though the render was killed.
		await assert.rejects(fs.stat(`${output}.input.rmdoc`));
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('the timeout reaches the process runner and surfaces as a renderer error', async () => {
	const seen: Array<number | undefined> = [];
	const runner: ProcessRunner = async (_executable, _args, timeoutMs) => {
		seen.push(timeoutMs);
		return { exitCode: 0, signal: null, stdout: '', stderr: '' };
	};
	await renderDocument('reMder-client', '/in.rmdoc', '/out.pdf.tmp', { runner, timeoutMs: 42_000 });
	await renderDocument('reMder-client', '/in.rmdoc', '/out.pdf.tmp', { runner });
	assert.deepEqual(seen, [42_000, undefined]);
});

test('renderer receives an immutable cache-local input snapshot that is cleaned up', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-renderer-'));
	const output = path.join(directory, 'output.pdf.tmp');
	try {
		let inputPath = '';
		await renderSnapshot('/opt/reMder client', Buffer.from('rmdoc bytes'), output, {
			runner: async (_executable, args) => {
				inputPath = args[0];
				assert.equal(await fs.readFile(inputPath, 'utf8'), 'rmdoc bytes');
				await fs.writeFile(args[1], '%PDF-snapshot');
				return { exitCode: 0, signal: null, stdout: '', stderr: '' };
			},
		});
		assert.equal(await fs.readFile(output, 'utf8'), '%PDF-snapshot');
		await assert.rejects(fs.stat(inputPath));
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
