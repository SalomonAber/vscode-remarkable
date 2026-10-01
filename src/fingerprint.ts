import { hashDocumentContents } from './rmdoc';

export interface SourceMetadata {
	size: number;
	mtime: number;
}

export interface SourceFingerprint extends SourceMetadata {
	contentHash: string;
}

export interface FingerprintResult extends SourceFingerprint {
	reused: boolean;
	contents?: Uint8Array;
}

export class SourceFingerprintCache {
	private readonly fingerprints = new Map<string, SourceFingerprint>();

	public async get(uri: string, metadata: SourceMetadata, read: () => Promise<Uint8Array>): Promise<FingerprintResult> {
		const previous = this.fingerprints.get(uri);
		if (previous && previous.size === metadata.size && previous.mtime === metadata.mtime) {
			return { ...previous, reused: true };
		}
		const contents = await read();
		const contentHash = hashContents(contents);
		const fingerprint = { ...metadata, contentHash };
		this.fingerprints.set(uri, fingerprint);
		return { ...fingerprint, reused: false, contents };
	}

	public forget(uri: string): void {
		this.fingerprints.delete(uri);
	}
}

/**
 * Size and mtime only tell us the file moved; the hash tells us whether the
 * document did. It describes the bundle's content rather than its bytes, so a
 * scroll, a zoom or a re-export on the tablet keeps the same render.
 */
export function hashContents(contents: Uint8Array): string {
	return hashDocumentContents(contents);
}
