import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type RenderOperation = (temporaryPath: string) => Promise<void>;

export function calculateCacheKey(contents: Uint8Array, rendererIdentity: string, renderSettings: unknown): string {
	const hash = createHash('sha256');
	hash.update('rmdoc-content\0');
	hash.update(contents);
	hash.update('\0renderer-identity\0');
	hash.update(rendererIdentity);
	hash.update('\0render-settings\0');
	hash.update(stableStringify(renderSettings));
	return hash.digest('hex');
}

export function getCachePath(cacheDirectory: string, cacheKey: string): string {
	if (!/^[a-f0-9]{64}$/.test(cacheKey)) {
		throw new Error('Invalid render cache key.');
	}
	return path.join(cacheDirectory, `${cacheKey}.pdf`);
}

export class RenderCache {
	private readonly inFlight = new Map<string, Promise<string>>();

	public constructor(private readonly cacheDirectory: string) {}

	public getOrRender(cacheKey: string, render: RenderOperation, force = false): Promise<string> {
		const activeRender = this.inFlight.get(cacheKey);
		if (activeRender) {
			return activeRender;
		}
		const operation = this.render(cacheKey, render, force);
		this.inFlight.set(cacheKey, operation);
		const clearInFlight = () => {
			if (this.inFlight.get(cacheKey) === operation) {
				this.inFlight.delete(cacheKey);
			}
		};
		void operation.then(clearInFlight, clearInFlight);
		return operation;
	}

	private async render(cacheKey: string, render: RenderOperation, force: boolean): Promise<string> {
		const finalPath = getCachePath(this.cacheDirectory, cacheKey);
		const temporaryPath = `${finalPath}.tmp`;
		await fs.mkdir(this.cacheDirectory, { recursive: true });
		if (!force && await isValidCacheEntry(finalPath)) {
			return finalPath;
		}
		await Promise.all([
			fs.rm(temporaryPath, { force: true }),
			fs.rm(finalPath, { force: true }),
		]);
		try {
			await render(temporaryPath);
			if (!await isValidCacheEntry(temporaryPath)) {
				throw new Error('Renderer completed without producing a PDF.');
			}
			await fs.rename(temporaryPath, finalPath);
			return finalPath;
		} catch (error) {
			await fs.rm(temporaryPath, { force: true });
			throw error;
		}
	}
}

async function isValidCacheEntry(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile() && stat.size > 0;
	} catch {
		return false;
	}
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}