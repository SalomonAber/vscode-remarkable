import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashDocumentContents } from '../src/rmdoc';
import { bundle, content, DOCUMENT, Member, metadata, page } from './rmdoc-bundle';

test('a scrolled or zoomed document keeps its content hash', () => {
	const read = bundle([
		page('%RM-strokes-page-1'),
		content({ customZoomCenterY: 936, customZoomScale: 1, zoomMode: 'bestFit' }),
		metadata({ lastOpened: '1700000000000', lastOpenedPage: 0 }),
	]);
	const scrolled = bundle([
		page('%RM-strokes-page-1'),
		content({ customZoomCenterY: 2481, customZoomScale: 2.5, zoomMode: 'customFit' }),
		metadata({ lastOpened: '1700000900000', lastOpenedPage: 4 }),
	]);

	assert.notEqual(Buffer.compare(read, scrolled), 0);
	assert.equal(hashDocumentContents(read), hashDocumentContents(scrolled));
});

test('switching pens and re-saving keeps the content hash', () => {
	const before = bundle([page('%RM-strokes'), content({ extraMetadata: { LastPen: 'Ballpointv2' }, sizeInBytes: '430763' })]);
	const after = bundle([page('%RM-strokes'), content({ extraMetadata: { LastPen: 'Highlighterv2' }, sizeInBytes: '430999' })]);

	assert.equal(hashDocumentContents(before), hashDocumentContents(after));
});

test('edited strokes change the content hash', () => {
	const before = bundle([page('%RM-strokes'), content()]);
	const after = bundle([page('%RM-strokes-plus-one-line'), content()]);

	assert.notEqual(hashDocumentContents(before), hashDocumentContents(after));
});

test('render-relevant content settings still change the hash', () => {
	const portrait = bundle([page('%RM-strokes'), content({ orientation: 'portrait', margins: 125 })]);
	const landscape = bundle([page('%RM-strokes'), content({ orientation: 'landscape', margins: 125 })]);
	const narrow = bundle([page('%RM-strokes'), content({ orientation: 'portrait', margins: 50 })]);
	const renamed = bundle([page('%RM-strokes'), content(), metadata({ visibleName: 'Renamed' })]);
	const original = bundle([page('%RM-strokes'), content(), metadata({ visibleName: 'Notes' })]);

	assert.notEqual(hashDocumentContents(portrait), hashDocumentContents(landscape));
	assert.notEqual(hashDocumentContents(portrait), hashDocumentContents(narrow));
	assert.notEqual(hashDocumentContents(renamed), hashDocumentContents(original));
});

test('an added page changes the hash', () => {
	const single = bundle([page('%RM-page-1', 'page-1'), content({ pageCount: 1 })]);
	const added = bundle([page('%RM-page-1', 'page-1'), page('%RM-page-2', 'page-2'), content({ pageCount: 2 })]);

	assert.notEqual(hashDocumentContents(single), hashDocumentContents(added));
});

test('zip envelope differences are ignored', () => {
	const members: Member[] = [page('%RM-strokes'), content(), metadata()];
	const packed = bundle(members);
	const repacked = bundle(
		[...members].reverse().map(member => ({ ...member, stored: true, time: 0x4a5b6c7d })),
		{ comment: 'repacked by a different tool' },
	);

	assert.notEqual(Buffer.compare(packed, repacked), 0);
	assert.equal(hashDocumentContents(packed), hashDocumentContents(repacked));
});

test('reformatted JSON members are ignored', () => {
	const compact = bundle([page('%RM-strokes'), { name: `${DOCUMENT}.content`, data: '{"fileType":"notebook","pageCount":1}' }]);
	const pretty = bundle([page('%RM-strokes'), { name: `${DOCUMENT}.content`, data: '\n\t{\n\t  "pageCount": 1,\n\t  "fileType": "notebook"\n\t}\n' }]);

	assert.equal(hashDocumentContents(compact), hashDocumentContents(pretty));
});

test('regenerated thumbnails and sync markers are ignored', () => {
	const before = bundle([
		page('%RM-strokes'),
		content(),
		{ name: `${DOCUMENT}.thumbnails/page-1.jpg`, data: Buffer.from([0xff, 0xd8, 0x01]) },
		{ name: `${DOCUMENT}.local`, data: '{}' },
	]);
	const after = bundle([
		page('%RM-strokes'),
		content(),
		{ name: `${DOCUMENT}.thumbnails/page-1.jpg`, data: Buffer.from([0xff, 0xd8, 0x02, 0x03]) },
		{ name: `${DOCUMENT}.local`, data: '{ }' },
	]);

	assert.equal(hashDocumentContents(before), hashDocumentContents(after));
});

test('an embedded PDF is part of the content', () => {
	const before = bundle([page('%RM-annotations'), content({ fileType: 'pdf' }), { name: `${DOCUMENT}.pdf`, data: '%PDF-original' }]);
	const after = bundle([page('%RM-annotations'), content({ fileType: 'pdf' }), { name: `${DOCUMENT}.pdf`, data: '%PDF-replaced' }]);

	assert.notEqual(hashDocumentContents(before), hashDocumentContents(after));
});

test('a damaged or non-archive source is hashed opaquely', () => {
	assert.equal(hashDocumentContents(Buffer.from('not a zip')), hashDocumentContents(Buffer.from('not a zip')));
	assert.notEqual(hashDocumentContents(Buffer.from('not a zip')), hashDocumentContents(Buffer.from('also not a zip')));

	const truncated = bundle([page('%RM-strokes'), content()]).subarray(0, 40);
	assert.equal(hashDocumentContents(truncated), hashDocumentContents(truncated));
	assert.notEqual(hashDocumentContents(truncated), hashDocumentContents(Buffer.from('not a zip')));
});

test('an unparseable JSON member falls back to its bytes', () => {
	const before = bundle([page('%RM-strokes'), { name: `${DOCUMENT}.content`, data: 'truncated{' }]);
	const after = bundle([page('%RM-strokes'), { name: `${DOCUMENT}.content`, data: 'truncated{{' }]);

	assert.equal(hashDocumentContents(before), hashDocumentContents(before));
	assert.notEqual(hashDocumentContents(before), hashDocumentContents(after));
});

