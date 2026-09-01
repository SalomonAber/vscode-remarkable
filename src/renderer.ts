import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const OUTPUT_LIMIT = 16 * 1024;
const CLI_CONTRACT = 'reMder-client:positional-input-output:v1';

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

export async function getRendererIdentity(executable: string): Promise<string> {
	const resolvedPath = await resolveExecutable(executable);
	if (!resolvedPath) {
		return `${CLI_CONTRACT}\0command:${executable}`;
	}
	try {
		const contents = await fs.readFile(resolvedPath);
		return `${CLI_CONTRACT}\0sha256:${createHash('sha256').update(contents).digest('hex')}`;
	} catch {
		return `${CLI_CONTRACT}\0path:${resolvedPath}`;
	}
}

export class RendererIdentityCache {
	private readonly identities = new Map<string, Promise<string>>();
	public constructor(private readonly resolve: (executable: string) => Promise<string> = getRendererIdentity) {}

	public get(executable: string): Promise<string> {
		let identity = this.identities.get(executable);
		if (!identity) {
			identity = this.resolve(executable);
			this.identities.set(executable, identity);
		}
		return identity;
	}

	public invalidate(executable?: string): void {
		if (executable) {this.identities.delete(executable);}
		else {this.identities.clear();}
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

async function resolveExecutable(executable: string): Promise<string | undefined> {
	const candidates = executable.includes('/') || executable.includes('\\')
		? [path.resolve(executable)]
		: (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(directory => executableCandidates(directory, executable));
	for (const candidate of candidates) {
		try {
			await fs.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

function executableCandidates(directory: string, executable: string): string[] {
	if (process.platform !== 'win32' || path.extname(executable)) {
		return [path.join(directory, executable)];
	}
	return (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
		.map(extension => path.join(directory, `${executable}${extension.toLowerCase()}`));
}

function summarizeOutput(output: string): string {
	const normalized = output.trim().replace(/\s+/g, ' ');
	return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}
