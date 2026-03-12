'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createBackupManager(opts = {}) {
  const dataDir = path.resolve(opts.dataDir || './data');
  const backupsDir = path.join(dataDir, 'backups');

  // Ensure backups directory exists
  fs.mkdirSync(backupsDir, { recursive: true });

  // Directories to back up (relative to dataDir)
  const BACKUP_DIRS = ['events', 'snapshots', 'audit', 'receipts', 'fleet', 'intents', 'users'];

  function createBackup() {
    const backupId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
    const backupPath = path.join(backupsDir, backupId);
    fs.mkdirSync(backupPath, { recursive: true });

    const manifest = {
      id: backupId,
      createdAt: new Date().toISOString(),
      dataDir: dataDir,
      files: [],
      totalSize: 0
    };

    for (const dir of BACKUP_DIRS) {
      const srcDir = path.join(dataDir, dir);
      const destDir = path.join(backupPath, dir);
      try {
        if (!fs.existsSync(srcDir)) continue;
        copyDirRecursive(srcDir, destDir, manifest);
      } catch { /* skip dirs that can't be copied */ }
    }

    // Write manifest
    fs.writeFileSync(path.join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2));

    return {
      id: backupId,
      createdAt: manifest.createdAt,
      fileCount: manifest.files.length,
      totalSize: manifest.totalSize
    };
  }

  const MAX_COPY_DEPTH = 10;

  function copyDirRecursive(src, dest, manifest, depth) {
    if (depth === undefined) depth = 0;
    if (depth > MAX_COPY_DEPTH) return; // Prevent unbounded recursion
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      // Skip symlinks to prevent loops
      if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        copyDirRecursive(srcPath, destPath, manifest, depth + 1);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(srcPath);
        fs.writeFileSync(destPath, content);
        const relativePath = path.relative(path.join(backupsDir, manifest.id), destPath);
        manifest.files.push(relativePath);
        manifest.totalSize += content.length;
      }
    }
  }

  function listBackups() {
    try {
      const entries = fs.readdirSync(backupsDir, { withFileTypes: true });
      const backups = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(backupsDir, entry.name, 'manifest.json');
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          backups.push({
            id: manifest.id,
            createdAt: manifest.createdAt,
            fileCount: manifest.files.length,
            totalSize: manifest.totalSize
          });
        } catch {
          // Directory exists but no valid manifest — skip
        }
      }
      // Sort by creation date descending
      backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return backups;
    } catch {
      return [];
    }
  }

  function restoreBackup(backupId) {
    // Validate backup ID to prevent path traversal
    if (!backupId || /[/\\]/.test(backupId)) {
      return { success: false, message: 'Invalid backup ID' };
    }
    const backupPath = path.join(backupsDir, backupId);
    const manifestPath = path.join(backupPath, 'manifest.json');

    try {
      fs.accessSync(manifestPath, fs.constants.R_OK);
    } catch {
      return { success: false, message: 'Backup not found: ' + backupId };
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return { success: false, message: 'Invalid backup manifest' };
    }

    let restoredFiles = 0;
    let errors = 0;

    for (const dir of BACKUP_DIRS) {
      const srcDir = path.join(backupPath, dir);
      const destDir = path.join(dataDir, dir);
      try {
        if (!fs.existsSync(srcDir)) continue;
        restoreDirRecursive(srcDir, destDir);
        const files = countFiles(srcDir);
        restoredFiles += files;
      } catch {
        errors++;
      }
    }

    return {
      success: errors === 0,
      message: 'Restored ' + restoredFiles + ' files from backup ' + backupId + (errors > 0 ? ' (' + errors + ' directory errors)' : ''),
      restoredFiles,
      errors
    };
  }

  function restoreDirRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        restoreDirRecursive(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.writeFileSync(destPath, fs.readFileSync(srcPath));
      }
    }
  }

  function countFiles(dir) {
    let count = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += countFiles(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        count++;
      }
    }
    return count;
  }

  function deleteBackup(backupId) {
    // Validate backup ID to prevent path traversal
    if (!backupId || /[/\\]/.test(backupId)) {
      return { success: false, message: 'Invalid backup ID' };
    }
    const backupPath = path.join(backupsDir, backupId);
    try {
      fs.accessSync(backupPath);
    } catch {
      return { success: false, message: 'Backup not found: ' + backupId };
    }
    try {
      fs.rmSync(backupPath, { recursive: true, force: true });
      return { success: true, message: 'Deleted backup: ' + backupId };
    } catch (err) {
      return { success: false, message: 'Failed to delete backup: ' + err.message };
    }
  }

  return { createBackup, listBackups, restoreBackup, deleteBackup };
}

module.exports = { createBackupManager };
