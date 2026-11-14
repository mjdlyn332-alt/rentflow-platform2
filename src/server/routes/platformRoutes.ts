import { Router } from 'express';
import { OrgStatus, Role } from '../../domain/types';
import { seedOrganizationAccounting } from '../accounting';
import { AuthenticatedRequest, getPlatformDb, hashPassword, requireRole } from '../auth';
import { HttpError, newId, nowIso } from '../db';

export function createPlatformRouter(): Router {
  const router = Router();
  router.use(requireRole(Role.SUPER_ADMIN));

  // FR-PLT-04: Aggregated usage counters only — NO operational names or rows
  router.get('/organizations', (req: AuthenticatedRequest, res, next) => {
    try {
      const pdb = getPlatformDb(req);
      const orgs = pdb.db
        .prepare(
          `SELECT o.id, o.name, o.status, o.timezone, o.base_currency, o.created_at,
            (SELECT COUNT(*) FROM property_slots ps WHERE ps.organization_id = o.id) AS total_slots,
            (SELECT COUNT(*) FROM property_slots ps WHERE ps.organization_id = o.id AND ps.property_id IS NOT NULL) AS used_slots,
            (SELECT COUNT(*) FROM units u WHERE u.organization_id = o.id AND u.deleted_at IS NULL) AS total_units,
            (SELECT COALESCE(SUM(ps.max_units), 0) FROM property_slots ps WHERE ps.organization_id = o.id) AS max_units_capacity
           FROM organizations o
           ORDER BY o.created_at DESC`,
        )
        .all();

      const slots = pdb.db
        .prepare(`SELECT id, organization_id, max_units, (property_id IS NOT NULL) AS is_used, created_at FROM property_slots`)
        .all();

      const owners = pdb.db
        .prepare(
          `SELECT id, organization_id, email, full_name, is_active, two_factor_enabled, created_at
           FROM users WHERE role = 'OWNER'`,
        )
        .all();

      res.json({ organizations: orgs, slots, owners });
    } catch (err) {
      next(err);
    }
  });

  // FR-PLT-01, FR-PLT-02, FR-PLT-03, FR-PLT-07: Create Organization + Slots + Owner + Default Accounting
  router.post('/organizations', (req: AuthenticatedRequest, res, next) => {
    try {
      const pdb = getPlatformDb(req);
      const {
        name,
        timezone = 'Asia/Riyadh',
        baseCurrency = 'SAR',
        propertySlotCount = 2,
        maxUnitsPerSlot = 10,
        ownerName,
        ownerEmail,
        ownerPassword,
      } = req.body ?? {};

      if (!name || !ownerName || !ownerEmail || !ownerPassword) {
        throw new HttpError(400, 'اسم المنشأة وبيانات حساب المالك مطلوبة');
      }
      const slotCount = Number(propertySlotCount);
      const unitsCap = Number(maxUnitsPerSlot);
      if (slotCount < 1 || unitsCap < 1) {
        throw new HttpError(400, 'عدد الحصص وسقف الوحدات يجب أن يكون 1 على الأقل');
      }

      const settings = pdb.db
        .prepare(`SELECT min_password_length FROM platform_settings WHERE id = 'default'`)
        .get() as { min_password_length: number } | undefined;

      const pwdHash = hashPassword(String(ownerPassword), settings?.min_password_length ?? 12);
      const normalizedEmail = String(ownerEmail).trim().toLowerCase();

      const existing = pdb.db.prepare(`SELECT id FROM users WHERE lower(email) = ?`).get(normalizedEmail);
      if (existing) {
        throw new HttpError(409, 'البريد الإلكتروني مستخدم بالفعل');
      }

      const orgId = newId('org');
      const ownerId = newId('usr');
      const now = nowIso();

      const tx = pdb.db.transaction(() => {
        pdb.db
          .prepare(
            `INSERT INTO organizations (id, name, status, timezone, base_currency, created_at)
             VALUES (?, ?, 'ACTIVE', ?, ?, ?)`,
          )
          .run(orgId, String(name).trim(), timezone, baseCurrency, now);

        for (let i = 0; i < slotCount; i++) {
          pdb.db
            .prepare(
              `INSERT INTO property_slots (id, organization_id, max_units, property_id, created_at)
               VALUES (?, ?, ?, NULL, ?)`,
            )
            .run(newId('slot'), orgId, unitsCap, now);
        }

        pdb.db
          .prepare(
            `INSERT INTO users (id, organization_id, role, email, full_name, password_hash, is_active, token_version, created_at)
             VALUES (?, ?, 'OWNER', ?, ?, ?, 1, 1, ?)`,
          )
          .run(ownerId, orgId, normalizedEmail, String(ownerName).trim(), pwdHash, now);

        seedOrganizationAccounting(pdb.db, orgId, new Date().getUTCFullYear());

        pdb.audit('Organization', orgId, 'CREATE', undefined, {
          name,
          slotCount,
          unitsCap,
          ownerEmail: normalizedEmail,
        });
      });

      tx();
      res.status(201).json({ organizationId: orgId, ownerId });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/organizations/:id/status', (req: AuthenticatedRequest, res, next) => {
    try {
      const pdb = getPlatformDb(req);
      const { status } = req.body ?? {};
      if (status !== OrgStatus.ACTIVE && status !== OrgStatus.SUSPENDED) {
        throw new HttpError(400, 'الحالة غير صالحة');
      }
      const org = pdb.db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(req.params.id) as any;
      if (!org) throw new HttpError(404, 'المنشأة غير موجودة');

      pdb.db.prepare(`UPDATE organizations SET status = ? WHERE id = ?`).run(status, org.id);
      pdb.audit('Organization', org.id, 'UPDATE_STATUS', { status: org.status }, { status });
      res.json({ ok: true, status });
    } catch (err) {
      next(err);
    }
  });

  // FR-PLT-03: Adjust plan limits (add slots or update unit caps)
  router.post('/organizations/:id/slots', (req: AuthenticatedRequest, res, next) => {
    try {
      const pdb = getPlatformDb(req);
      const { addSlots = 1, maxUnitsPerSlot = 10, slotId, newMaxUnits } = req.body ?? {};
      const org = pdb.db.prepare(`SELECT id FROM organizations WHERE id = ?`).get(req.params.id);
      if (!org) throw new HttpError(404, 'المنشأة غير موجودة');

      if (slotId && newMaxUnits !== undefined) {
        const cap = Number(newMaxUnits);
        if (cap < 1) throw new HttpError(400, 'سقف الوحدات يجب أن يكون 1 فأكثر');
        pdb.db
          .prepare(`UPDATE property_slots SET max_units = ? WHERE id = ? AND organization_id = ?`)
          .run(cap, slotId, req.params.id);
        pdb.audit('PropertySlot', slotId, 'UPDATE_CAP', undefined, { newMaxUnits: cap });
        return res.json({ ok: true });
      }

      const count = Number(addSlots);
      const cap = Number(maxUnitsPerSlot);
      if (count < 1 || cap < 1) throw new HttpError(400, 'القيم غير صالحة');

      for (let i = 0; i < count; i++) {
        pdb.db
          .prepare(
            `INSERT INTO property_slots (id, organization_id, max_units, property_id, created_at)
             VALUES (?, ?, ?, NULL, ?)`,
          )
          .run(newId('slot'), req.params.id, cap, nowIso());
      }
      pdb.audit('Organization', req.params.id, 'ADD_SLOTS', undefined, { addSlots: count, maxUnitsPerSlot: cap });
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // FR-PLT-02: Toggle or reset OWNER password
  router.patch('/owners/:id', (req: AuthenticatedRequest, res, next) => {
    try {
      const pdb = getPlatformDb(req);
      const owner = pdb.db
        .prepare(`SELECT * FROM users WHERE id = ? AND role = 'OWNER'`)
        .get(req.params.id) as any;
      if (!owner) throw new HttpError(404, 'حساب المالك غير موجود');

      const { isActive, newPassword } = req.body ?? {};
      if (typeof isActive === 'boolean') {
        pdb.db
          .prepare(`UPDATE users SET is_active = ?, token_version = token_version + 1 WHERE id = ?`)
          .run(isActive ? 1 : 0, owner.id);
        pdb.audit('User', owner.id, 'TOGGLE_ACTIVE', { isActive: Boolean(owner.is_active) }, { isActive });
      }
      if (newPassword) {
        const settings = pdb.db
          .prepare(`SELECT min_password_length FROM platform_settings WHERE id = 'default'`)
          .get() as { min_password_length: number } | undefined;
        const hash = hashPassword(String(newPassword), settings?.min_password_length ?? 12);
        pdb.db
          .prepare(`UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?`)
          .run(hash, owner.id);
        pdb.audit('User', owner.id, 'RESET_PASSWORD');
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // FR-PLT-05 & FR-PLT-08: Platform settings & audit log
  router.get('/settings', (req: AuthenticatedRequest, res, next) => {
    try {
      const pdb = getPlatformDb(req);
      const settings = pdb.db.prepare(`SELECT * FROM platform_settings WHERE id = 'default'`).get();
      const logs = pdb.db
        .prepare(`SELECT * FROM audit_logs WHERE organization_id IS NULL ORDER BY created_at DESC LIMIT 100`)
        .all();
      res.json({ settings, auditLogs: logs });
    } catch (err) {
      next(err);
    }
  });

  router.put('/settings', (req: AuthenticatedRequest, res, next) => {
    try {
      const pdb = getPlatformDb(req);
      const {
        minPasswordLength,
        sessionTtlHours,
        emailFrom,
        emailResetSubject,
        emailResetTemplate,
        emailNotifTemplate,
        email2faTemplate,
      } = req.body ?? {};
      const minLen = Math.max(8, Number(minPasswordLength ?? 12));
      const ttl = Math.max(1, Number(sessionTtlHours ?? 8));
      pdb.db
        .prepare(
          `UPDATE platform_settings SET
             min_password_length = ?,
             session_ttl_hours = ?,
             email_from = ?,
             email_reset_subject = COALESCE(?, email_reset_subject),
             email_reset_template = COALESCE(?, email_reset_template),
             email_notif_template = COALESCE(?, email_notif_template),
             email_2fa_template = COALESCE(?, email_2fa_template),
             updated_at = ?
           WHERE id = 'default'`,
        )
        .run(
          minLen,
          ttl,
          String(emailFrom ?? 'noreply@melaak.sa'),
          emailResetSubject ?? null,
          emailResetTemplate ?? null,
          emailNotifTemplate ?? null,
          email2faTemplate ?? null,
          nowIso(),
        );
      pdb.audit('PlatformSettings', 'default', 'UPDATE', undefined, { minLen, ttl, emailFrom });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
