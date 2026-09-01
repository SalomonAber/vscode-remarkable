import { createHash } from 'node:crypto';

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

export function hashContents(contents: Uint8Array): string {
	return createHash('sha256').update(contents).digest('hex');
}
