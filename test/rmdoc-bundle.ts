import { crc32, deflateRawSync } from 'node:zlib';

/** Builds .rmdoc bundles for tests, including the envelope details a tablet or repacking tool varies. */

export const DOCUMENT = '6f3ab2c0-0000-4000-8000-000000000001';

export interface Member {
	name: string;
	data: Buffer | string;
	stored?: boolean;
	/** Packed MS-DOS date/time, so tests can vary the envelope timestamps. */
	time?: number;
}

export function page(strokes: string, id = 'page-1'): Member {
	return { name: `${DOCUMENT}/${id}.rm`, data: strokes };
}

export function content(overrides: Record<string, unknown> = {}): Member {
	return {
		name: `${DOCUMENT}.content`,
		data: JSON.stringify({
			cPages: { pages: [{ id: 'page-1', idx: { timestamp: '1:2', value: 'ba' } }] },
			coverPageNumber: -1,
			fileType: 'notebook',
			formatVersion: 2,
			margins: 125,
			orientation: 'portrait',
			pageCount: 1,
			textScale: 1,
			...overrides,
		}),
	};
}

export function metadata(overrides: Record<string, unknown> = {}): Member {
	return {
		name: `${DOCUMENT}.metadata`,
		data: JSON.stringify({
			createdTime: '1699000000000',
			lastModified: '1700000000000',
			lastOpened: '1700000000000',
			lastOpenedPage: 0,
			parent: '',
			pinned: false,
			type: 'DocumentType',
			visibleName: 'Notes',
			...overrides,
		}),
	};
}

export function bundle(members: readonly Member[], options: { comment?: string } = {}): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const member of members) {
		const name = Buffer.from(member.name, 'utf8');
		const data = Buffer.isBuffer(member.data) ? member.data : Buffer.from(member.data, 'utf8');
		const method = member.stored ? 0 : 8;
		const payload = member.stored ? data : deflateRawSync(data);
		const checksum = crc32(data);
		const time = member.time ?? 0x21002100;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(time, 10);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, payload);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(time, 12);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += local.length + name.length + payload.length;
	}
	const directory = Buffer.concat(centrals);
	const comment = Buffer.from(options.comment ?? '', 'utf8');
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(members.length, 8);
	end.writeUInt16LE(members.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(comment.length, 20);
	return Buffer.concat([...locals, directory, end, comment]);
}
