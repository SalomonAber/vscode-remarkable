import { RenderCache, calculateCacheKeyForContentHash } from './cache';
import { hashContents, SourceFingerprintCache, SourceMetadata } from './fingerprint';
import { RendererIdentityCache, renderSnapshot } from './renderer';

export interface CachedRenderResult {
	contentHash: string;
	pdfPath: string;
}

export type SourceReader = () => Promise<Uint8Array>;
export type SnapshotRenderer = (executable: string, contents: Uint8Array, outputPath: string) => Promise<unknown>;

export interface RendererBackend {
	executable: string;
	instanceKey: string;
	/** Executable whose output contract and binary identity this backend shares. */
	cacheIdentity: string;
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
	options: Partial<Pick<RendererBackend, 'instanceKey' | 'cacheIdentity'>> = {},
): RendererBackend {
	return {
		executable,
		instanceKey: options.instanceKey ?? executable,
		cacheIdentity: options.cacheIdentity ?? executable,
	};
}

export class RenderService {
	private readonly renderTails = new Map<string, Promise<void>>();

	public constructor(
		private readonly cache: RenderCache,
		private readonly fingerprints: SourceFingerprintCache,
		private readonly identities: RendererIdentityCache,
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
		const identity = await this.identities.get(backend.cacheIdentity);
		let contentHash = fingerprint.contentHash;
		let key = calculateCacheKeyForContentHash(contentHash, identity, { remderPath: backend.cacheIdentity });
		let hit = !force && await this.cache.hasValidEntry(key);
		let sourceContents: Uint8Array | undefined;
		if (!hit) {
			sourceContents = fingerprint.contents ?? await read();
			contentHash = hashContents(sourceContents);
			key = calculateCacheKeyForContentHash(contentHash, identity, { remderPath: backend.cacheIdentity });
			hit = !force && await this.cache.hasValidEntry(key);
		}
		log(hit ? 'cache hit' : 'cache miss');
		const pdfPath = await this.cache.getOrRender(key, async temporaryPath => {
			const snapshot = sourceContents ?? await read();
			await this.enqueueRender(backend.instanceKey, async () => {
				log('renderer started');
				await this.render(backend.executable, snapshot, temporaryPath);
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
