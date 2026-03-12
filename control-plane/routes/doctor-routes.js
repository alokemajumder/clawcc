'use strict';

const { authenticate, requireStepUp } = require('../middleware/auth-middleware');

function registerDoctorRoutes(router, config, modules) {
  const { auth, audit, doctor, backupManager } = modules;

  // GET /api/ops/doctor - Run all diagnostic checks
  router.get('/api/ops/doctor', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const results = doctor.runAll();
    audit.log({ actor: authResult.user.username, action: 'doctor.run', target: 'all', detail: JSON.stringify({ checks: results.length }) });
    res.json(200, { success: true, checks: results });
  });

  // POST /api/ops/doctor/fix/:checkId - Run a fix (admin + step-up required)
  router.post('/api/ops/doctor/fix/:checkId', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    const stepUp = requireStepUp(req, auth, config);
    if (!stepUp.authorized) return res.error(403, stepUp.reason);
    const checkId = req.params.checkId;
    const result = doctor.applyFix(checkId);
    audit.log({ actor: authResult.user.username, action: 'doctor.fix', target: checkId, detail: JSON.stringify(result) });
    if (result.success) {
      res.json(200, { success: true, fix: result });
    } else {
      res.json(400, { success: false, error: result.message });
    }
  });

  // GET /api/ops/backups - List backups
  router.get('/api/ops/backups', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    const backups = backupManager.listBackups();
    res.json(200, { success: true, backups });
  });

  // POST /api/ops/backup - Create a backup (admin only)
  router.post('/api/ops/backup', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    try {
      const backup = backupManager.createBackup();
      audit.log({ actor: authResult.user.username, action: 'backup.created', target: backup.id, detail: JSON.stringify({ fileCount: backup.fileCount, totalSize: backup.totalSize }) });
      res.json(200, { success: true, backup });
    } catch (err) {
      res.json(500, { success: false, error: 'Backup creation failed: ' + err.message });
    }
  });

  // POST /api/ops/restore/:backupId - Restore from backup (admin + step-up required)
  router.post('/api/ops/restore/:backupId', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    const stepUp = requireStepUp(req, auth, config);
    if (!stepUp.authorized) return res.error(403, stepUp.reason);
    const backupId = req.params.backupId;
    const result = backupManager.restoreBackup(backupId);
    audit.log({ actor: authResult.user.username, action: 'backup.restored', target: backupId, detail: JSON.stringify(result) });
    if (result.success) {
      res.json(200, { success: true, restore: result });
    } else {
      res.json(500, { success: false, error: result.message });
    }
  });

  // DELETE /api/ops/backup/:backupId - Delete a backup (admin only)
  router.delete('/api/ops/backup/:backupId', async (req, res) => {
    const authResult = authenticate(req, auth);
    if (!authResult.authenticated) return res.error(401, 'Not authenticated');
    if ((authResult.user.role || '').toLowerCase() !== 'admin') return res.error(403, 'Admin required');
    const backupId = req.params.backupId;
    const result = backupManager.deleteBackup(backupId);
    audit.log({ actor: authResult.user.username, action: 'backup.deleted', target: backupId });
    if (result.success) {
      res.json(200, { success: true, message: result.message });
    } else {
      res.json(500, { success: false, error: result.message });
    }
  });
}

module.exports = { registerDoctorRoutes };
