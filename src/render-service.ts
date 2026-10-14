import { RenderCache, calculateCacheKeyForContentHash } from './cache';
import { hashContents, SourceFingerprintCache, SourceMetadata } from './fingerprint';
import { renderSnapshot } from './renderer';

export interface CachedRenderResult {
	contentHash: string;
	pdfPath: string;
}

export type SourceReader = () => Promise<Uint8Array>;
export type SnapshotRenderer = (executable: string, contents: Uint8Array, outputPath: string, options?: { timeoutMs?: number }) => Promise<unknown>;

export interface RendererBackend {
	executable: string;
	instanceKey: string;
	/** Omitted means wait indefinitely; see `RenderOptions` for why that is a bad idea. */
	timeoutMs?: number;
}

export interface RenderRequest {
	source: string;
	metadata: SourceMetadata;
	read: SourceReader;
	backend: RendererBackend;
	force?: boolean;
	log?: (message: string) => void;
}

export function createRendererBackend(
	executable: string,
	options: Partial<Pick<RendererBackend, 'instanceKey' | 'timeoutMs'>> = {},
): RendererBackend {
	return {
		executable,
		instanceKey: options.instanceKey ?? executable,
		timeoutMs: options.timeoutMs,
	};
}

export class RenderService {
	private readonly renderTails = new Map<string, Promise<void>>();

	public constructor(
		private readonly cache: RenderCache,
		private readonly fingerprints: SourceFingerprintCache,
		private readonly render: SnapshotRenderer = renderSnapshot,
	) {}

	public invalidate(source: string): void {
		this.fingerprints.forget(source);
	}

	public async getOrRender(request: RenderRequest): Promise<CachedRenderResult> {
		const { source, metadata, read, backend, force = false, log = () => {} } = request;
		if (force) {
			this.invalidate(source);
		}
		const fingerprint = await this.fingerprints.get(source, metadata, read);
		log(fingerprint.reused ? 'content hash reused from fingerprint' : 'content rehashed');
		let contentHash = fingerprint.contentHash;
		let key = calculateCacheKeyForContentHash(contentHash);
		let sourceContents = fingerprint.contents;
		let cached = await this.cache.hasValidEntry(key);
		// A reused fingerprint says only that the file has not moved, which is a
		// guess about its contents; before rendering on the strength of that guess,
		// reread and rehash. A fingerprint just computed already describes these
		// exact bytes, so rehashing them would only repeat the work.
		if (!cached && fingerprint.reused) {
			sourceContents = await read();
			contentHash = hashContents(sourceContents);
			key = calculateCacheKeyForContentHash(contentHash);
			cached = await this.cache.hasValidEntry(key);
		}
		// Said of the cache rather than of this render, so that the forced refresh
		// which deliberately ignores a good entry stops reporting itself as a miss.
		log(cached ? 'cache hit' : 'cache miss');
		if (cached && force) {
			log('forced refresh; re-rendering anyway');
		}
		const pdfPath = await this.cache.getOrRender(key, async temporaryPath => {
			const snapshot = sourceContents ?? await read();
			await this.enqueueRender(backend.instanceKey, async () => {
				log('renderer started');
				await this.render(backend.executable, snapshot, temporaryPath, { timeoutMs: backend.timeoutMs });
				log('renderer completed');
			});
		}, force);
		return { contentHash, pdfPath };
	}

	private enqueueRender(instanceKey: string, render: () => Promise<void>): Promise<void> {
		const operation = (this.renderTails.get(instanceKey) ?? Promise.resolve()).then(render);
		const tail = operation.then(() => undefined, () => undefined);
		this.renderTails.set(instanceKey, tail);
		void tail.then(() => {
			if (this.renderTails.get(instanceKey) === tail) { this.renderTails.delete(instanceKey); }
		});
		return operation;
	}
}
