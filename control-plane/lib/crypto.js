'use strict';

const crypto = require('node:crypto');

// ── PBKDF2 password hashing ──

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, storedHash] = stored.split(':');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

// ── TOTP ──

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let result = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    result += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return result;
}

function base32Decode(str) {
  let bits = '';
  for (const ch of str.toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTOTPSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function generateTOTPCode(secret, timeStep = null) {
  const time = timeStep != null ? timeStep : Math.floor(Date.now() / 30000);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(0, 0);
  timeBuffer.writeUInt32BE(time, 4);
  const key = base32Decode(secret);
  const hmac = crypto.createHmac('sha1', key).update(timeBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
  return code.toString().padStart(6, '0');
}

function verifyTOTPCode(secret, code, window = 1) {
  const now = Math.floor(Date.now() / 30000);
  for (let i = -window; i <= window; i++) {
    if (generateTOTPCode(secret, now + i) === code) return true;
  }
  return false;
}

// ── HMAC request signing ──

function signRequest(secret, method, path, timestamp, body = '') {
  const payload = `${method}\n${path}\n${timestamp}\n${body}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function verifyRequest(secret, method, path, timestamp, body, signature, maxAgeMs = 300000) {
  const age = Date.now() - timestamp;
  if (age > maxAgeMs || age < -maxAgeMs) return false;
  const expected = signRequest(secret, method, path, timestamp, body);
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

// ── Ed25519 ──

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKey, privateKey };
}

function sign(data, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(data), key).toString('hex');
}

function verify(data, signature, publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  return crypto.verify(null, Buffer.from(data), key, Buffer.from(signature, 'hex'));
}

// ── Hash chain ──

function hashData(data) {
  return crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex');
}

function buildHashChain(items) {
  const chain = [];
  let prevHash = '0'.repeat(64);
  for (const item of items) {
    const entry = { data: item, prevHash };
    entry.hash = hashData(prevHash + hashData(item));
    prevHash = entry.hash;
    chain.push(entry);
  }
  return chain;
}

function verifyHashChain(chain) {
  let prevHash = '0'.repeat(64);
  for (let i = 0; i < chain.length; i++) {
    const expected = hashData(prevHash + hashData(chain[i].data));
    if (chain[i].hash !== expected) return { valid: false, brokenAt: i };
    prevHash = chain[i].hash;
  }
  return { valid: true };
}

// ── Recovery codes ──

function generateRecoveryCodes(count = 10) {
  const codes = new Set();
  while (codes.size < count) {
    codes.add(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return [...codes];
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function verifyRecoveryCode(code, hash) {
  const computed = hashRecoveryCode(code);
  if (computed.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
}

// ── Nonce tracker ──

function createNonceTracker(maxAgeMs = 300000) {
  const nonces = new Map();
  return {
    accept(nonce) {
      // Clean expired
      const now = Date.now();
      for (const [n, ts] of nonces) {
        if (now - ts > maxAgeMs) nonces.delete(n);
      }
      if (nonces.has(nonce)) return false;
      nonces.set(nonce, now);
      return true;
    },
    size() { return nonces.size; }
  };
}

module.exports = {
  hashPassword, verifyPassword,
  generateTOTPSecret, generateTOTPCode, verifyTOTPCode,
  base32Encode, base32Decode,
  signRequest, verifyRequest,
  generateKeyPair, sign, verify,
  hashData, buildHashChain, verifyHashChain,
  generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode,
  createNonceTracker
};
