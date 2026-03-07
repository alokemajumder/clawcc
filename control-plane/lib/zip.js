'use strict';

const zlib = require('zlib');

// CRC-32 lookup table
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[i] = c;
}

function crc32(buf) {
  if (typeof buf === 'string') buf = Buffer.from(buf);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files) {
  if (files.length > 65535) throw new Error('ZIP format supports at most 65535 entries');

  const localHeaders = [];
  const centralEntries = [];
  let offset = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file.name || file.data == null) throw new Error(`ZIP entry ${i}: name and data are required`);
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data));
    if (data.length > 0xFFFFFFFF) throw new Error(`ZIP entry "${file.name}": data exceeds 4GB limit`);
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    // Local file header (30 bytes + name + compressed data)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4);         // version needed (2.0)
    local.writeUInt16LE(0, 6);          // flags
    local.writeUInt16LE(8, 8);          // compression: deflate
    local.writeUInt16LE(0, 10);         // mod time
    local.writeUInt16LE(0, 12);         // mod date
    local.writeUInt32LE(crc, 14);       // crc-32
    local.writeUInt32LE(compressed.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22);       // uncompressed size
    local.writeUInt16LE(name.length, 26);       // filename length
    local.writeUInt16LE(0, 28);                 // extra field length

    localHeaders.push(Buffer.concat([local, name, compressed]));

    // Central directory entry (46 bytes + name)
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0, 8);          // flags
    central.writeUInt16LE(8, 10);         // compression
    central.writeUInt16LE(0, 12);         // mod time
    central.writeUInt16LE(0, 14);         // mod date
    central.writeUInt32LE(crc, 16);       // crc-32
    central.writeUInt32LE(compressed.length, 20); // compressed
    central.writeUInt32LE(data.length, 24);       // uncompressed
    central.writeUInt16LE(name.length, 28);       // filename length
    central.writeUInt16LE(0, 30);                 // extra field length
    central.writeUInt16LE(0, 32);                 // comment length
    central.writeUInt16LE(0, 34);                 // disk number
    central.writeUInt16LE(0, 36);                 // internal attrs
    central.writeUInt32LE(0, 38);                 // external attrs
    central.writeUInt32LE(offset, 42);            // local header offset

    centralEntries.push(Buffer.concat([central, name]));
    offset += 30 + name.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralEntries);
  const centralDirOffset = offset;

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);    // signature
  eocd.writeUInt16LE(0, 4);             // disk number
  eocd.writeUInt16LE(0, 6);             // central dir start disk
  eocd.writeUInt16LE(files.length, 8);  // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central dir size
  eocd.writeUInt32LE(centralDirOffset, 16);  // central dir offset
  eocd.writeUInt16LE(0, 20);            // comment length

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

module.exports = { buildZip, crc32 };
