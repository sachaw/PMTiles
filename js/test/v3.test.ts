import { test } from "node:test";
import { strictEqual, deepEqual, fail, throws, rejects, ok } from "node:assert";
import { readFileSync } from "fs";

import {
	Entry,
	zxyToTileId,
	tileIdToZxy,
	findTile,
	readVarint,
	SharedPromiseCache,
	BufferPosition,
	Source,
	RangeResponse,
	EtagMismatch,
	PMTiles,
	getUint64,
} from "../src/index.js";

test("varint", () => {
	let b: BufferPosition = {
		buf: new Uint8Array([0, 1, 127, 0xe5, 0x8e, 0x26]),
		pos: 0,
	};
	strictEqual(readVarint(b), 0);
	strictEqual(readVarint(b), 1);
	strictEqual(readVarint(b), 127);
	strictEqual(readVarint(b), 624485);
	b = {
		buf: new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f]),
		pos: 0,
	};
	strictEqual(readVarint(b), 9007199254740991);
});

test("zxy to tile id", () => {
	strictEqual(zxyToTileId(0, 0, 0), 0);
	strictEqual(zxyToTileId(1, 0, 0), 1);
	strictEqual(zxyToTileId(1, 0, 1), 2);
	strictEqual(zxyToTileId(1, 1, 1), 3);
	strictEqual(zxyToTileId(1, 1, 0), 4);
	strictEqual(zxyToTileId(2, 0, 0), 5);
});

test("tile id to zxy", () => {
	deepEqual(tileIdToZxy(0), [0, 0, 0]);
	deepEqual(tileIdToZxy(1), [1, 0, 0]);
	deepEqual(tileIdToZxy(2), [1, 0, 1]);
	deepEqual(tileIdToZxy(3), [1, 1, 1]);
	deepEqual(tileIdToZxy(4), [1, 1, 0]);
	deepEqual(tileIdToZxy(5), [2, 0, 0]);
});

test("a lot of tiles", () => {
	for (let z = 0; z < 9; z++) {
		for (let x = 0; x < 1 << z; x++) {
			for (let y = 0; y < 1 << z; y++) {
				const result = tileIdToZxy(zxyToTileId(z, x, y));
				if (result[0] !== z || result[1] !== x || result[2] !== y) {
					fail("roundtrip failed");
				}
			}
		}
	}
});

test("tile extremes", () => {
	for (var z = 0; z < 27; z++) {
		const dim = Math.pow(2, z) - 1;
		const tl = tileIdToZxy(zxyToTileId(z, 0, 0));
		deepEqual([z, 0, 0], tl);
		const tr = tileIdToZxy(zxyToTileId(z, dim, 0));
		deepEqual([z, dim, 0], tr);
		const bl = tileIdToZxy(zxyToTileId(z, 0, dim));
		deepEqual([z, 0, dim], bl);
		const br = tileIdToZxy(zxyToTileId(z, dim, dim));
		deepEqual([z, dim, dim], br);
	}
});

test("invalid tiles", () => {
	throws(() => {
		tileIdToZxy(Number.MAX_SAFE_INTEGER);
	});

	throws(() => {
		zxyToTileId(27, 0, 0);
	});

	throws(() => {
		zxyToTileId(0, 1, 1);
	});
});

test("tile search for missing entry", () => {
	const entries: Entry[] = [];
	strictEqual(findTile(entries, 101), null);
});

test("tile search for first entry == id", () => {
	const entries: Entry[] = [
		{ tileId: 100, offset: 1, length: 1, runLength: 1 },
	];
	const entry = findTile(entries, 100)!;
	strictEqual(entry.offset, 1);
	strictEqual(entry.length, 1);
	strictEqual(findTile(entries, 101), null);
});

test("tile search with runlength", () => {
	const entries: Entry[] = [
		{ tileId: 3, offset: 3, length: 1, runLength: 2 },
		{ tileId: 5, offset: 5, length: 1, runLength: 2 },
	];
	const entry = findTile(entries, 4)!;
	strictEqual(entry.offset, 3);
});

test("tile search with multiple tile entries", () => {
	let entries: Entry[] = [{ tileId: 100, offset: 1, length: 1, runLength: 2 }];
	let entry = findTile(entries, 101)!;
	strictEqual(entry.offset, 1);
	strictEqual(entry.length, 1);

	entries = [
		{ tileId: 100, offset: 1, length: 1, runLength: 1 },
		{ tileId: 150, offset: 2, length: 2, runLength: 2 },
	];
	entry = findTile(entries, 151)!;
	strictEqual(entry.offset, 2);
	strictEqual(entry.length, 2);

	entries = [
		{ tileId: 50, offset: 1, length: 1, runLength: 2 },
		{ tileId: 100, offset: 2, length: 2, runLength: 1 },
		{ tileId: 150, offset: 3, length: 3, runLength: 1 },
	];
	entry = findTile(entries, 51)!;
	strictEqual(entry.offset, 1);
	strictEqual(entry.length, 1);
});

test("leaf search", () => {
	const entries: Entry[] = [
		{ tileId: 100, offset: 1, length: 1, runLength: 0 },
	];
	const entry = findTile(entries, 150);
	strictEqual(entry!.offset, 1);
	strictEqual(entry!.length, 1);
});

// inefficient method only for testing
class TestNodeFileSource implements Source {
	buffer: ArrayBuffer;
	path: string;
	key: string;
	etag?: string;

	constructor(path: string, key: string) {
		this.path = path;
		this.buffer = readFileSync(path);
		this.key = key;
	}

	getKey() {
		return this.key;
	}

	replaceData(path: string) {
		this.path = path;
		this.buffer = readFileSync(path);
	}

	async getBytes(offset: number, length: number): Promise<RangeResponse> {
		const slice = new Uint8Array(this.buffer.slice(offset, offset + length))
			.buffer;
		return { data: slice, etag: this.etag };
	}
}

// echo '{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,1],[1,0],[0,0]]]}' | ./tippecanoe -zg -o test_fixture_1.pmtiles
test("cache getHeader", async () => {
	const source = new TestNodeFileSource(
		"test/data/test_fixture_1.pmtiles",
		"1",
	);
	const cache = new SharedPromiseCache();
	const header = await cache.getHeader(source);
	strictEqual(header.rootDirectoryOffset, 127);
	strictEqual(header.rootDirectoryLength, 25);
	strictEqual(header.jsonMetadataOffset, 152);
	strictEqual(header.jsonMetadataLength, 247);
	strictEqual(header.leafDirectoryOffset, 0);
	strictEqual(header.leafDirectoryLength, 0);
	strictEqual(header.tileDataOffset, 399);
	strictEqual(header.tileDataLength, 69);
	strictEqual(header.numAddressedTiles, 1);
	strictEqual(header.numTileEntries, 1);
	strictEqual(header.numTileContents, 1);
	strictEqual(header.clustered, false);
	strictEqual(header.internalCompression, 2);
	strictEqual(header.tileCompression, 2);
	strictEqual(header.tileType, 1);
	strictEqual(header.minZoom, 0);
	strictEqual(header.maxZoom, 0);
	strictEqual(header.minLon, 0);
	strictEqual(header.minLat, 0);
	// strictEqual(header.maxLon,1); // TODO fix me
	strictEqual(header.maxLat, 1);
});

test("getUint64", async () => {
	const view = new DataView(new ArrayBuffer(8));
	view.setBigUint64(0, 0n, true);
	strictEqual(getUint64(view, 0), 0);
	view.setBigUint64(0, 1n, true);
	strictEqual(getUint64(view, 0), 1);
	view.setBigUint64(0, 9007199254740991n, true);
	strictEqual(getUint64(view, 0), 9007199254740991);
});

test("cache check against empty", async () => {
	const source = new TestNodeFileSource("test/data/empty.pmtiles", "1");
	const cache = new SharedPromiseCache();
	rejects(async () => {
		await cache.getHeader(source);
	});
});

test("cache check magic number", async () => {
	const source = new TestNodeFileSource("test/data/invalid.pmtiles", "1");
	const cache = new SharedPromiseCache();
	rejects(async () => {
		await cache.getHeader(source);
	});
});

test("cache check future spec version", async () => {
	const source = new TestNodeFileSource("test/data/invalid_v4.pmtiles", "1");
	const cache = new SharedPromiseCache();
	rejects(async () => {
		await cache.getHeader(source);
	});
});

test("cache getDirectory", async () => {
	const source = new TestNodeFileSource(
		"test/data/test_fixture_1.pmtiles",
		"1",
	);

	let cache = new SharedPromiseCache(6400, false);
	let header = await cache.getHeader(source);
	strictEqual(cache.cache.size, 1);

	cache = new SharedPromiseCache(6400, true);
	header = await cache.getHeader(source);

	// prepopulates the root directory
	strictEqual(cache.cache.size, 2);

	const directory = await cache.getDirectory(
		source,
		header.rootDirectoryOffset,
		header.rootDirectoryLength,
		header,
	);
	strictEqual(directory.length, 1);
	strictEqual(directory[0].tileId, 0);
	strictEqual(directory[0].offset, 0);
	strictEqual(directory[0].length, 69);
	strictEqual(directory[0].runLength, 1);

	for (const v of cache.cache.values()) {
		ok(v.lastUsed > 0);
	}
});

test("multiple sources in a single cache", async () => {
	const cache = new SharedPromiseCache();
	const source1 = new TestNodeFileSource(
		"test/data/test_fixture_1.pmtiles",
		"1",
	);
	const source2 = new TestNodeFileSource(
		"test/data/test_fixture_1.pmtiles",
		"2",
	);
	await cache.getHeader(source1);
	strictEqual(cache.cache.size, 2);
	await cache.getHeader(source2);
	strictEqual(cache.cache.size, 4);
});

test("etags are part of key", async () => {
	const cache = new SharedPromiseCache(6400, false);
	const source = new TestNodeFileSource(
		"test/data/test_fixture_1.pmtiles",
		"1",
	);
	source.etag = "etag_1";
	let header = await cache.getHeader(source);
	strictEqual(header.etag, "etag_1");

	source.etag = "etag_2";

	rejects(async () => {
		await cache.getDirectory(
			source,
			header.rootDirectoryOffset,
			header.rootDirectoryLength,
			header,
		);
	});

	cache.invalidate(source, "etag_2");
	header = await cache.getHeader(source);
	ok(
		await cache.getDirectory(
			source,
			header.rootDirectoryOffset,
			header.rootDirectoryLength,
			header,
		),
	);
});

test("soft failure on etag weirdness", async () => {
	const cache = new SharedPromiseCache(6400, false);
	const source = new TestNodeFileSource(
		"test/data/test_fixture_1.pmtiles",
		"1",
	);
	source.etag = "etag_1";
	let header = await cache.getHeader(source);
	strictEqual(header.etag, "etag_1");

	source.etag = "etag_2";

	rejects(async () => {
		await cache.getDirectory(
			source,
			header.rootDirectoryOffset,
			header.rootDirectoryLength,
			header,
		);
	});

	source.etag = "etag_1";
	cache.invalidate(source, "etag_2");

	header = await cache.getHeader(source);
	strictEqual(header.etag, undefined);
});

test("cache pruning by byte size", async () => {
	const cache = new SharedPromiseCache(2, false);
	cache.cache.set("0", { lastUsed: 0, data: Promise.resolve([]) });
	cache.cache.set("1", { lastUsed: 1, data: Promise.resolve([]) });
	cache.cache.set("2", { lastUsed: 2, data: Promise.resolve([]) });
	cache.prune();
	strictEqual(cache.cache.size, 2);
	ok(cache.cache.get("2"));
	ok(cache.cache.get("1"));
	ok(!cache.cache.get("0"));
});

test("pmtiles get metadata", async () => {
	const source = new TestNodeFileSource(
		"test/data/test_fixture_1.pmtiles",
		"1",
	);
	const p = new PMTiles(source);
	const metadata = await p.getMetadata();
	ok(metadata.name);
});

// echo '{"type":"Polygon","coordinates":[[[0,0],[0,1],[1,0],[0,0]]]}' | ./tippecanoe -zg -o test_fixture_2.pmtiles
test("pmtiles handle retries", async () => {
	const source = new TestNodeFileSource(
		"test/data/test_fixture_1.pmtiles",
		"1",
	);
	source.etag = "1";
	const p = new PMTiles(source);
	const metadata = await p.getMetadata();
	ok(metadata.name);
	source.etag = "2";
	source.replaceData("test/data/test_fixture_2.pmtiles");
	ok(await p.getZxy(0, 0, 0));
});
