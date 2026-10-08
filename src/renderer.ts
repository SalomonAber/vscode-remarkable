import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';

const OUTPUT_LIMIT = 16 * 1024;

export interface ProcessResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

export type ProcessRunner = (executable: string, args: readonly string[]) => Promise<ProcessResult>;

export class RendererError extends Error {
	public constructor(public readonly summary: string, public readonly result?: ProcessResult) {
		super(summary);
		this.name = 'RendererError';
	}
}

export async function renderDocument(executable: string, inputPath: string, outputPath: string, runner: ProcessRunner = spawnProcess): Promise<ProcessResult> {
	const result = await runner(executable, [inputPath, outputPath]);
	if (result.exitCode !== 0) {
		const status = result.exitCode === null ? `signal ${result.signal ?? 'unknown'}` : `exit code ${result.exitCode}`;
		const detail = summarizeOutput(result.stderr || result.stdout);
		throw new RendererError(detail ? `${status}: ${detail}` : status, result);
	}
	return result;
}

/** Render an immutable source snapshot so the cache key always describes the rendered bytes. */
export async function renderSnapshot(executable: string, contents: Uint8Array, outputPath: string, runner: ProcessRunner = spawnProcess): Promise<ProcessResult> {
	const inputPath = `${outputPath}.input.rmdoc`;
	try {
		await fs.writeFile(inputPath, contents);
		return await renderDocument(executable, inputPath, outputPath, runner);
	} finally {
		await fs.rm(inputPath, { force: true });
	}
}

async function spawnProcess(executable: string, args: readonly string[]): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, [...args], { shell: false, windowsHide: true });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutLength = 0;
		let stderrLength = 0;
		child.stdout.on('data', (chunk: Buffer) => {
			if (stdoutLength < OUTPUT_LIMIT) {
				stdout.push(chunk.subarray(0, OUTPUT_LIMIT - stdoutLength));
				stdoutLength += chunk.length;
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			if (stderrLength < OUTPUT_LIMIT) {
				stderr.push(chunk.subarray(0, OUTPUT_LIMIT - stderrLength));
				stderrLength += chunk.length;
			}
		});
		child.once('error', error => reject(new RendererError(`Failed to start ${executable}: ${error.message}`)));
		child.once('close', (exitCode, signal) => resolve({
			exitCode,
			signal,
			stdout: Buffer.concat(stdout).toString('utf8'),
			stderr: Buffer.concat(stderr).toString('utf8'),
		}));
	});
}

function summarizeOutput(output: string): string {
	const normalized = output.trim().replace(/\s+/g, ' ');
	return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}
