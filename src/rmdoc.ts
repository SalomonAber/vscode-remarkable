import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

/**
 * A .rmdoc is a zip bundle of a reMarkable document: the page strokes and any
 * imported PDF/EPUB, alongside bookkeeping the tablet rewrites as you simply
 * read. Hashing the archive bytes therefore fingerprints the *file* rather than
 * the drawing — scrolling, zooming, picking a different pen, or re-exporting the
 * same notebook all produce new bytes for a document that renders identically,
 * and every one of those was costing us a render.
 *
 * So we hash a canonical view of the bundle instead: members sorted by name,
 * zip envelope noise (member order, per-member timestamps, compression method,
 * archive comment) dropped, generated and sync-only members skipped, and the
 * two JSON members reduced to the fields that can actually reach a page.
 */
const CONTENT_HASH_SCHEME = 'rmdoc-canonical-v1';

/**
 * `.content` keys the tablet rewrites while you read: the saved zoom/scroll
 * viewport, the last-used tool, and a size it derives from the rest of the
 * bundle. Deny-listed rather than allow-listed so that an unrecognised key is
 * treated as render-relevant — a needless miss is much cheaper than a stale
 * preview.
 */
export const IGNORED_CONTENT_KEYS: readonly string[] = [
	'customZoomCenterX',
	'customZoomCenterY',
	'customZoomOrientation',
	'customZoomPageHeight',
	'customZoomPageWidth',
	'customZoomScale',
	'zoomMode',
	'extraMetadata',
	'lastOpenedPage',
	'sizeInBytes',
];

/**
 * `.metadata` is almost entirely sync bookkeeping — timestamps, pin and trash
 * state, cloud version counters — so it is allow-listed the other way round:
 * only the title can plausibly show up in a render.
 */
export const RENDERED_METADATA_KEYS: readonly string[] = ['visibleName'];

/** Hash what the renderer will draw, ignoring how the bundle was packed. */
export function hashDocumentContents(contents: Uint8Array): string {
	const hash = createHash('sha256');
	const members = readMembers(contents);
	if (!members) {
		// Not a readable bundle (a bare .rm file, or a truncated copy): the whole
		// file is the content, so fall back to hashing it opaquely.
		return hash.update(`${CONTENT_HASH_SCHEME}\0opaque\0`).update(contents).digest('hex');
	}
	hash.update(`${CONTENT_HASH_SCHEME}\0bundle\0`);
	for (const member of [...members].sort((left, right) => compare(left.name, right.name))) {
		const role = classify(member.name);
		if (role === 'ignored') { continue; }
		const canonical = role === 'json' ? canonicalJsonMember(member, contents) : undefined;
		hash.update(`\0member\0${member.name}\0`);
		if (canonical !== undefined) {
			hash.update(`json\0${canonical}`);
		} else {
			// The central directory already carries a CRC-32 of the member's
			// uncompressed bytes, so we can describe strokes and embedded PDFs
			// without inflating them and keep rehashing a big bundle cheap.
			hash.update(`bytes\0${member.size}\0${member.crc32}`);
		}
	}
	return hash.digest('hex');
}

type MemberRole = 'ignored' | 'json' | 'bytes';

/** Members the renderer never reads: device sync markers and generated previews. */
const IGNORED_SUFFIXES = ['.local', '.tombstone', '.ds_store'];

function classify(name: string): MemberRole {
	const lower = name.toLowerCase();
	if (name.endsWith('/') || lower.includes('.thumbnails/') || lower.startsWith('__macosx/')) { return 'ignored'; }
	if (IGNORED_SUFFIXES.some(suffix => lower.endsWith(suffix))) { return 'ignored'; }
	if (lower.endsWith('.content') || lower.endsWith('.metadata')) { return 'json'; }
	return 'bytes';
}

/** Returns undefined when the member cannot be read as JSON, so the caller hashes its bytes. */
function canonicalJsonMember(member: ArchiveMember, contents: Uint8Array): string | undefined {
	const bytes = readMemberBytes(contents, member);
	if (!bytes) { return undefined; }
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return canonicalJson(parsed); }
	const metadata = member.name.toLowerCase().endsWith('.metadata');
	const retained = Object.entries(parsed as Record<string, unknown>).filter(([key]) => metadata
		? RENDERED_METADATA_KEYS.includes(key)
		: !IGNORED_CONTENT_KEYS.includes(key));
	return canonicalJson(Object.fromEntries(retained));
}

/** JSON with object keys in code-point order, so whitespace and key order stop mattering. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => compare(left, right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const STORED = 0;
const DEFLATED = 8;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const END_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const OVERFLOW = 0xffffffff;

interface ArchiveMember {
	name: string;
	crc32: number;
	size: number;
	compressedSize: number;
	compressionMethod: number;
	localHeaderOffset: number;
}

/** Minimal zip central-directory reader; undefined for anything that is not a zip we understand. */
function readMembers(contents: Uint8Array): ArchiveMember[] | undefined {
	const view = new DataView(contents.buffer, contents.byteOffset, contents.byteLength);
	const end = findEnd(view);
	if (!end) { return undefined; }
	const members: ArchiveMember[] = [];
	let offset = end.centralDirectoryOffset;
	for (let index = 0; index < end.entryCount; index += 1) {
		if (offset + CENTRAL_HEADER_SIZE > view.byteLength || view.getUint32(offset, true) !== CENTRAL_FILE_HEADER) { return undefined; }
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const nameStart = offset + CENTRAL_HEADER_SIZE;
		if (nameStart + nameLength + extraLength + commentLength > view.byteLength) { return undefined; }
		const member: ArchiveMember = {
			name: Buffer.from(contents.subarray(nameStart, nameStart + nameLength)).toString('utf8'),
			compressionMethod: view.getUint16(offset + 10, true),
			crc32: view.getUint32(offset + 16, true),
			compressedSize: view.getUint32(offset + 20, true),
			size: view.getUint32(offset + 24, true),
			localHeaderOffset: view.getUint32(offset + 42, true),
		};
		applyZip64Extra(view, nameStart + nameLength, extraLength, member);
		members.push(member);
		offset = nameStart + nameLength + extraLength + commentLength;
	}
	return members;
}

function findEnd(view: DataView): { entryCount: number; centralDirectoryOffset: number } | undefined {
	const earliest = Math.max(0, view.byteLength - MAX_COMMENT_SIZE - END_SIZE);
	for (let offset = view.byteLength - END_SIZE; offset >= earliest; offset -= 1) {
		if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY) { continue; }
		// The declared comment length must account for the rest of the file, which
		// keeps us from latching onto the signature inside compressed data.
		if (view.getUint16(offset + 20, true) !== view.byteLength - offset - END_SIZE) { continue; }
		let entryCount = view.getUint16(offset + 10, true);
		let centralDirectoryOffset = view.getUint32(offset + 16, true);
		// Only a saturated field means the real value lives in the zip64 record;
		// looking unconditionally would let central-directory bytes that happen to
		// match the locator signature send us somewhere arbitrary.
		if (entryCount === 0xffff || centralDirectoryOffset === OVERFLOW) {
			const zip64 = readZip64End(view, offset);
			if (!zip64) { return undefined; }
			entryCount = zip64.entryCount;
			centralDirectoryOffset = zip64.centralDirectoryOffset;
		}
		return centralDirectoryOffset <= view.byteLength ? { entryCount, centralDirectoryOffset } : undefined;
	}
	return undefined;
}

function readZip64End(view: DataView, endOffset: number): { entryCount: number; centralDirectoryOffset: number } | undefined {
	const locator = endOffset - 20;
	if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR) { return undefined; }
	const record = Number(view.getBigUint64(locator + 8, true));
	if (record < 0 || record + 56 > view.byteLength || view.getUint32(record, true) !== ZIP64_END_OF_CENTRAL_DIRECTORY) { return undefined; }
	return {
		entryCount: Number(view.getBigUint64(record + 32, true)),
		centralDirectoryOffset: Number(view.getBigUint64(record + 48, true)),
	};
}

function applyZip64Extra(view: DataView, start: number, length: number, member: ArchiveMember): void {
	const end = start + length;
	for (let offset = start; offset + 4 <= end;) {
		const id = view.getUint16(offset, true);
		const size = view.getUint16(offset + 2, true);
		let field = offset + 4;
		if (id === ZIP64_EXTRA_FIELD) {
			// Zip64 only restates the values that overflowed, in this fixed order.
			if (member.size === OVERFLOW && field + 8 <= end) { member.size = Number(view.getBigUint64(field, true)); field += 8; }
			if (member.compressedSize === OVERFLOW && field + 8 <= end) { member.compressedSize = Number(view.getBigUint64(field, true)); field += 8; }
			if (member.localHeaderOffset === OVERFLOW && field + 8 <= end) { member.localHeaderOffset = Number(view.getBigUint64(field, true)); }
		}
		offset += 4 + size;
	}
}

function readMemberBytes(contents: Uint8Array, member: ArchiveMember): Uint8Array | undefined {
	const view = new DataView(contents.buffer, contents.byteOffset, contents.byteLength);
	const header = member.localHeaderOffset;
	if (header < 0 || header + LOCAL_HEADER_SIZE > view.byteLength || view.getUint32(header, true) !== LOCAL_FILE_HEADER) { return undefined; }
	const start = header + LOCAL_HEADER_SIZE + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
	const data = contents.subarray(start, start + member.compressedSize);
	if (data.byteLength !== member.compressedSize) { return undefined; }
	if (member.compressionMethod === STORED) { return data; }
	if (member.compressionMethod !== DEFLATED) { return undefined; }
	try {
		return inflateRawSync(data);
	} catch {
		return undefined;
	}
}
