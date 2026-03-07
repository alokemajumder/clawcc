'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { buildZip, crc32 } = require('../../control-plane/lib/zip');

describe('buildZip', () => {

  it('produces valid ZIP with correct magic bytes for a single file', () => {
    const zip = buildZip([{ name: 'hello.txt', data: 'Hello, world!' }]);
    assert.ok(Buffer.isBuffer(zip));
    // Local file header magic: PK\x03\x04
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
  });

  it('contains the filename in the local header', () => {
    const zip = buildZip([{ name: 'test.txt', data: 'content' }]);
    assert.ok(zip.includes(Buffer.from('test.txt')));
  });

  it('compressed data can be decompressed back to original', () => {
    const original = 'Hello, world!';
    const zip = buildZip([{ name: 'hello.txt', data: original }]);

    // Parse local file header to extract compressed data
    const filenameLen = zip.readUInt16LE(26);
    const compressedSize = zip.readUInt32LE(18);
    const dataOffset = 30 + filenameLen;
    const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
    const decompressed = zlib.inflateRawSync(compressed);
    assert.equal(decompressed.toString(), original);
  });

  it('builds ZIP with multiple files', () => {
    const files = [
      { name: 'a.txt', data: 'AAA' },
      { name: 'b.txt', data: 'BBB' },
      { name: 'c.txt', data: 'CCC' }
    ];
    const zip = buildZip(files);
    assert.ok(Buffer.isBuffer(zip));

    // Check EOCD entry count
    // Find EOCD signature 0x06054b50
    let eocdOffset = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
      if (zip.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
    }
    assert.ok(eocdOffset >= 0, 'EOCD signature found');
    assert.equal(zip.readUInt16LE(eocdOffset + 10), 3, 'total entries should be 3');

    // All filenames present
    for (const f of files) {
      assert.ok(zip.includes(Buffer.from(f.name)), `filename ${f.name} present in ZIP`);
    }
  });

  it('rejects more than 65535 entries', () => {
    // We cannot actually create 65536 entries, so test the guard directly
    const fakeFiles = new Array(65536).fill(null).map((_, i) => ({ name: `f${i}.txt`, data: '' }));
    assert.throws(() => buildZip(fakeFiles), /65535/);
  });

  it('rejects entries without a name', () => {
    assert.throws(() => buildZip([{ data: 'x' }]), /name and data are required/);
  });

  it('rejects entries with null data', () => {
    assert.throws(() => buildZip([{ name: 'x.txt', data: null }]), /name and data are required/);
  });

  it('handles Buffer data', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
    const zip = buildZip([{ name: 'bin.dat', data: buf }]);
    assert.ok(zip.readUInt32LE(0) === 0x04034b50);
  });
});

describe('crc32', () => {

  it('returns correct CRC-32 for known inputs', () => {
    // CRC-32 of empty string is 0x00000000
    assert.equal(crc32(Buffer.alloc(0)), 0x00000000);

    // CRC-32 of "123456789" is 0xCBF43926
    assert.equal(crc32('123456789'), 0xCBF43926);
  });

  it('accepts string input', () => {
    const fromStr = crc32('hello');
    const fromBuf = crc32(Buffer.from('hello'));
    assert.equal(fromStr, fromBuf);
  });

  it('produces different checksums for different data', () => {
    assert.notEqual(crc32('abc'), crc32('def'));
  });
});
