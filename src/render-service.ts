import { RenderCache, calculateCacheKeyForContentHash } from './cache';
import { hashContents, SourceFingerprintCache, SourceMetadata } from './fingerprint';
import { RendererIdentityCache, renderSnapshot } from './renderer';

export interface CachedRenderResult {
	contentHash: string;
	pdfPath: string;
}

export type SourceReader = () => Promise<Uint8Array>;
export type SnapshotRenderer = (executable: string, contents: Uint8Array, outputPath: string) => Promise<unknown>;

export class RenderService {
	public constructor(
		private readonly cache: RenderCache,
		private readonly fingerprints: SourceFingerprintCache,
		private readonly identities: RendererIdentityCache,
		private readonly render: SnapshotRenderer = renderSnapshot,
	) {}

	public invalidate(source: string): void {
		this.fingerprints.forget(source);
	}

	public async getOrRender(
		source: string,
		metadata: SourceMetadata,
		read: SourceReader,
		executable: string,
		force = false,
		log: (message: string) => void = () => {},
	): Promise<CachedRenderResult> {
		if (force) {
			this.invalidate(source);
		}
		const fingerprint = await this.fingerprints.get(source, metadata, read);
		log(fingerprint.reused ? 'content hash reused from fingerprint' : 'content rehashed');
		const identity = await this.identities.get(executable);
		let contentHash = fingerprint.contentHash;
		let key = calculateCacheKeyForContentHash(contentHash, identity, { remderPath: executable });
		let hit = !force && await this.cache.hasValidEntry(key);
		let sourceContents: Uint8Array | undefined;
		if (!hit) {
			sourceContents = fingerprint.contents ?? await read();
			contentHash = hashContents(sourceContents);
			key = calculateCacheKeyForContentHash(contentHash, identity, { remderPath: executable });
			hit = !force && await this.cache.hasValidEntry(key);
		}
		log(hit ? 'cache hit' : 'cache miss');
		const pdfPath = await this.cache.getOrRender(key, async temporaryPath => {
			const snapshot = sourceContents ?? await read();
			log('renderer started');
			await this.render(executable, snapshot, temporaryPath);
			log('renderer completed');
		}, force);
		return { contentHash, pdfPath };
	}
}
