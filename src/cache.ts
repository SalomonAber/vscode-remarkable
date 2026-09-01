import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type RenderOperation = (temporaryPath: string) => Promise<void>;

export function calculateCacheKey(contents: Uint8Array, rendererIdentity: string, renderSettings: unknown): string {
	return calculateCacheKeyForContentHash(createHash('sha256').update(contents).digest('hex'), rendererIdentity, renderSettings);
}

export function calculateCacheKeyForContentHash(contentHash: string, rendererIdentity: string, renderSettings: unknown): string {
	const hash = createHash('sha256');
	hash.update('rmdoc-content-sha256\0');
	hash.update(contentHash);
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

	public hasValidEntry(cacheKey: string): Promise<boolean> {
		return isValidCacheEntry(getCachePath(this.cacheDirectory, cacheKey));
	}

	public async cleanup(maxSizeBytes: number, protectedPaths: ReadonlySet<string> = new Set()): Promise<string[]> {
		try {
			const entries = await fs.readdir(this.cacheDirectory, { withFileTypes: true });
			const files = (await Promise.all(entries
				.filter(entry => entry.isFile() && entry.name.endsWith('.pdf'))
				.map(async entry => {
					const filePath = path.join(this.cacheDirectory, entry.name);
					return { filePath, stat: await fs.stat(filePath) };
				})))
				.filter(entry => !protectedPaths.has(entry.filePath) && !this.inFlight.has(path.basename(entry.filePath, '.pdf')))
				.sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
			let total = files.reduce((sum, entry) => sum + entry.stat.size, 0)
				+ (await this.protectedSize(protectedPaths));
			const removed: string[] = [];
			for (const entry of files) {
				if (total <= maxSizeBytes) {
					break;
				}
				await fs.rm(entry.filePath, { force: true });
				total -= entry.stat.size;
				removed.push(entry.filePath);
			}
			return removed;
		} catch {
			return [];
		}
	}

	private async protectedSize(protectedPaths: ReadonlySet<string>): Promise<number> {
		let size = 0;
		for (const filePath of protectedPaths) {
			try { size += (await fs.stat(filePath)).size; } catch {}
		}
		return size;
	}

	private async render(cacheKey: string, render: RenderOperation, force: boolean): Promise<string> {
		const finalPath = getCachePath(this.cacheDirectory, cacheKey);
		const temporaryPath = `${finalPath}.tmp`;
		await fs.mkdir(this.cacheDirectory, { recursive: true });
		if (!force && await isValidCacheEntry(finalPath)) {
			return finalPath;
		}
		await fs.rm(temporaryPath, { force: true });
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
