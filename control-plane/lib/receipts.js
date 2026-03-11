'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hashData, buildHashChain, verifyHashChain, sign, verify, generateKeyPair } = require('./crypto');

function createReceiptStore(opts = {}) {
  const receipts = [];
  const dataDir = opts.dataDir || null;
  let signingKey = opts.privateKey || null;
  let verifyKey = opts.publicKey || null;

  if (!signingKey) {
    // Try to load existing key pair from disk
    const keysLoaded = loadKeys();
    if (!keysLoaded) {
      const kp = generateKeyPair();
      signingKey = kp.privateKey;
      verifyKey = kp.publicKey;
      persistKeys();
    }
  }

  function keysDir() {
    return dataDir ? path.join(dataDir, 'receipts') : null;
  }

  function loadKeys() {
    const dir = keysDir();
    if (!dir) return false;
    try {
      const keyData = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'));
      signingKey = keyData.privateKey;
      verifyKey = keyData.publicKey;
      return true;
    } catch { return false; }
  }

  function persistKeys() {
    const dir = keysDir();
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ privateKey: signingKey, publicKey: verifyKey }));
    } catch { /* ignore */ }
  }

  function loadReceipts() {
    const dir = keysDir();
    if (!dir) return;
    try {
      const files = fs.readdirSync(dir).filter(f => f.startsWith('receipts-') && f.endsWith('.jsonl')).sort();
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf8').trim();
        if (!content) continue;
        for (const line of content.split('\n')) {
          try { receipts.push(JSON.parse(line)); } catch { /* skip bad lines */ }
        }
      }
    } catch { /* no receipts yet */ }
  }

  function appendReceipt(receipt) {
    const dir = keysDir();
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const dateStr = new Date(receipt.timestamp).toISOString().split('T')[0];
      const filePath = path.join(dir, `receipts-${dateStr}.jsonl`);
      fs.appendFileSync(filePath, JSON.stringify(receipt) + '\n');
    } catch { /* ignore */ }
  }

  function persistDailyRoot(root) {
    const dir = keysDir();
    if (!dir) return;
    try {
      fs.mkdirSync(path.join(dir, 'roots'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'roots', `${root.date}.json`), JSON.stringify(root, null, 2));
    } catch { /* ignore */ }
  }

  // Load existing receipts from disk on init
  loadReceipts();

  function createReceipt(data) {
    const hash = hashData(data);
    const prevHash = receipts.length > 0 ? receipts[receipts.length - 1].hash : '0'.repeat(64);
    const chainHash = hashData(prevHash + hash);
    const receipt = {
      index: receipts.length,
      data,
      dataHash: hash,
      prevHash,
      hash: chainHash,
      timestamp: Date.now()
    };
    receipts.push(receipt);
    appendReceipt(receipt);
    return receipt;
  }

  function verifyChain() {
    if (receipts.length === 0) return { valid: true };
    for (let i = 0; i < receipts.length; i++) {
      const r = receipts[i];
      const expectedPrev = i === 0 ? '0'.repeat(64) : receipts[i - 1].hash;
      if (r.prevHash !== expectedPrev) return { valid: false, brokenAt: i, reason: 'prevHash mismatch' };
      const expectedHash = hashData(expectedPrev + hashData(r.data));
      if (r.hash !== expectedHash) return { valid: false, brokenAt: i, reason: 'hash mismatch' };
    }
    return { valid: true };
  }

  function signDailyRoot(date) {
    const dateStr = date || new Date().toISOString().split('T')[0];
    const dayReceipts = receipts.filter(r => {
      const d = new Date(r.timestamp).toISOString().split('T')[0];
      return d === dateStr;
    });
    if (dayReceipts.length === 0) return null;
    const rootHash = hashData(dayReceipts.map(r => r.hash).join(''));
    const signature = sign(rootHash, signingKey);
    const root = { date: dateStr, rootHash, signature, receiptCount: dayReceipts.length };
    persistDailyRoot(root);
    return root;
  }

  function verifyDailyRoot(root) {
    return verify(root.rootHash, root.signature, verifyKey);
  }

  function exportBundle(startIndex = 0, endIndex) {
    const end = endIndex != null ? endIndex : receipts.length;
    const bundle = receipts.slice(startIndex, end);
    const bundleHash = hashData(JSON.stringify(bundle));
    const signature = sign(bundleHash, signingKey);
    return { receipts: bundle, hash: bundleHash, signature };
  }

  function verifyBundle(bundle) {
    const expectedHash = hashData(JSON.stringify(bundle.receipts));
    if (expectedHash !== bundle.hash) return { valid: false, reason: 'Bundle hash mismatch' };
    const sigValid = verify(bundle.hash, bundle.signature, verifyKey);
    if (!sigValid) return { valid: false, reason: 'Signature invalid' };
    // Verify internal chain
    for (let i = 0; i < bundle.receipts.length; i++) {
      const r = bundle.receipts[i];
      const expectedPrev = i === 0 ? (r.index === 0 ? '0'.repeat(64) : r.prevHash) : bundle.receipts[i - 1].hash;
      if (r.prevHash !== expectedPrev) return { valid: false, reason: `Chain broken at ${i}` };
      const expectedEntryHash = hashData(r.prevHash + hashData(r.data));
      if (r.hash !== expectedEntryHash) return { valid: false, reason: `Hash mismatch at ${i}` };
    }
    return { valid: true };
  }

  function getReceipts() { return [...receipts]; }

  function getPublicKey() { return verifyKey; }

  return { createReceipt, verifyChain, signDailyRoot, verifyDailyRoot, exportBundle, verifyBundle, getReceipts, getPublicKey };
}

module.exports = { createReceiptStore };
