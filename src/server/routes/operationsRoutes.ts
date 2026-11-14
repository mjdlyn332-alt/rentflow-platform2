import crypto from 'node:crypto';
import { Router } from 'express';
import Decimal from 'decimal.js';
import { D, toFixedMoney } from '../../domain/money';
import { addMonths, calculateDepositBalance, StateMachines } from '../../domain/rules';
import {
  AttachmentType,
  ChargeTo,
  EvictionStatus,
  InstallmentStatus,
  MaintenanceCause,
  RentAgreementStatus,
  Role,
  VoucherReferenceType,
  VoucherType,
} from '../../domain/types';
import { postJournalEntry } from '../accounting';
import {
  AuthenticatedRequest,
  buildDefaultStaffPermissions,
  getTenantDb,
  hashPassword,
  requireAuth,
  requireOrgPermission,
  requireRole,
} from '../auth';
import { HttpError, newId, nowIso, todayIso } from '../db';
import {
  approveAndPostSettlement,
  completeHandoverAndDraftSettlement,
  createVoucherAtomic,
  initiateEvictionAtomic,
  reverseVoucherAtomic,
  runEvictionDailyCheck,
} from '../domainService';

const ATTACHMENT_SIGN_SECRET = process.env.ATTACHMENT_SIGN_SECRET || 'melaak-local-att-secret';

function createAttachmentSignature(id: string, orgId: string, exp: number): string {
  return crypto.createHmac('sha256', ATTACHMENT_SIGN_SECRET).update(`${id}:${orgId}:${exp}`).digest('hex');
}

function verifyAttachmentSignature(id: string, orgId: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = createAttachmentSignature(id, orgId, exp);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createOperationsRouter(): Router {
  const router = Router();

  // --- COLLECTIONS & CASHBOXES (FR-COL-01..10) ---

  router.get('/collections', requireOrgPermission('collections', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const cashboxes = tenant.db
        .prepare(`SELECT * FROM cashboxes WHERE organization_id = ? ORDER BY cashbox_type, name`)
        .all(tenant.organizationId);

      const vouchers = tenant.db
        .prepare(
          `SELECT v.*, cb.name AS cashbox_name, tcb.name AS target_cashbox_name, pa.name AS party_name, pr.name AS property_name
           FROM vouchers v
           JOIN cashboxes cb ON cb.id = v.cashbox_id
           LEFT JOIN cashboxes tcb ON tcb.id = v.target_cashbox_id
           LEFT JOIN parties pa ON pa.id = v.party_id
           LEFT JOIN properties pr ON pr.id = v.property_id
           WHERE v.organization_id = ?
           ORDER BY v.created_at DESC`,
        )
        .all(tenant.organizationId);

      const collectors = tenant.db
        .prepare(
          `SELECT c.*, u.full_name, u.email, u.is_active AS user_is_active, cb.balance AS cashbox_balance, cb.name AS cashbox_name
           FROM collectors c
           JOIN users u ON u.id = c.user_id
           JOIN cashboxes cb ON cb.id = c.cashbox_id
           WHERE c.organization_id = ?`,
        )
        .all(tenant.organizationId) as any[];

      for (const c of collectors) {
        c.assignedProperties = tenant.db
          .prepare(
            `SELECT cp.property_id, p.name FROM collector_properties cp JOIN properties p ON p.id = cp.property_id WHERE cp.collector_id = ? AND cp.organization_id = ?`,
          )
          .all(c.id, tenant.organizationId);
      }

      const unpaidContractExpenses = tenant.db
        .prepare(
          `SELECT cei.*, a.unit_id, u.unit_number, a.property_id, p.name AS property_name, pa.name AS tenant_name
           FROM contract_expense_items cei
           JOIN rent_agreements a ON a.id = cei.agreement_id
           JOIN units u ON u.id = a.unit_id
           JOIN properties p ON p.id = a.property_id
           JOIN parties pa ON pa.id = a.tenant_party_id
           WHERE cei.organization_id = ? AND cei.charge_to = 'TENANT' AND CAST(cei.amount AS REAL) > CAST(cei.paid_amount AS REAL)`,
        )
        .all(tenant.organizationId);

      const unpaidTenantMaintenance = tenant.db
        .prepare(
          `SELECT m.*, u.unit_number, p.name AS property_name, pa.name AS tenant_name
           FROM maintenance_records m
           JOIN properties p ON p.id = m.property_id
           LEFT JOIN units u ON u.id = m.unit_id
           LEFT JOIN rent_agreements a ON a.id = m.agreement_id
           LEFT JOIN parties pa ON pa.id = a.tenant_party_id
           WHERE m.organization_id = ? AND m.charge_to = 'TENANT' AND CAST(m.cost AS REAL) > CAST(m.paid_amount AS REAL)`,
        )
        .all(tenant.organizationId);

      const properties = tenant.db
        .prepare(`SELECT id, name, guard_name, guard_salary FROM properties WHERE organization_id = ? AND deleted_at IS NULL`)
        .all(tenant.organizationId);

      res.json({ cashboxes, vouchers, collectors, unpaidContractExpenses, unpaidTenantMaintenance, properties });
    } catch (err) {
      next(err);
    }
  });

  // FR-COL-01: Create MAIN or BANK cashbox
  router.post('/collections/cashboxes', requireOrgPermission('collections', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { name, cashboxType = 'BANK' } = req.body ?? {};
      if (!name || !['MAIN', 'BANK'].includes(String(cashboxType))) {
        throw new HttpError(400, 'اسم الصندوق ونوعه (MAIN أو BANK) مطلوبان');
      }
      const id = newId('cb');
      const accountCode = cashboxType === 'BANK' ? '1130' : '1110';
      tenant.db
        .prepare(
          `INSERT INTO cashboxes (id, organization_id, name, cashbox_type, account_code, balance, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, '0.00', 1, ?)`,
        )
        .run(id, tenant.organizationId, String(name).trim(), cashboxType, accountCode, nowIso());
      tenant.audit({ entityType: 'Cashbox', entityId: id, action: 'CREATE', newValue: { name, cashboxType, accountCode } });
      res.status(201).json({ cashboxId: id });
    } catch (err) {
      next(err);
    }
  });

  router.post('/collections/vouchers', requireOrgPermission('collections', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const idemKey = req.headers['idempotency-key'] as string | undefined;
      const result = tenant.runAtomic('POST_VOUCHER', idemKey, () => {
        return createVoucherAtomic(tenant, req.body);
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/collections/vouchers/:id/reverse', requireOrgPermission('collections', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { reason } = req.body ?? {};
      if (!reason) throw new HttpError(400, 'يجب توثيق سبب عكس السند');
      const result = tenant.runAtomic('REVERSE_VOUCHER', undefined, () => {
        return reverseVoucherAtomic(tenant, req.params.id, String(reason));
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-COL-10: Pay collector reward or guard salary as property expense
  router.post('/collections/record-operating-expense', requireOrgPermission('collections', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { cashboxId, propertyId, expenseKind, amount, description, voucherDate = todayIso() } = req.body ?? {};
      if (!cashboxId || !propertyId || !expenseKind || !amount) {
        throw new HttpError(400, 'بيانات المصروف غير مكتملة');
      }
      const result = tenant.runAtomic('RECORD_OP_EXPENSE', undefined, () => {
        const cb = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM cashboxes WHERE id = ? AND organization_id = ?`)
            .get(cashboxId, tenant.organizationId) as any,
          'الصندوق',
        );
        const amt = D(amount);
        if (amt.lte(0)) throw new HttpError(400, 'المبلغ يجب أن يكون أكبر من صفر');
        if (D(cb.balance).lt(amt)) throw new HttpError(400, 'رصيد الصندوق غير كافٍ');

        const accountCode = expenseKind === 'COLLECTOR_REWARD' ? '5500' : '5400';
        const seq = tenant.nextSequence('voucher_seq');
        const vNum = `PV-${String(seq).padStart(5, '0')}`;
        const vId = newId('vch');
        const desc = description || (expenseKind === 'COLLECTOR_REWARD' ? 'صرف مكافأة محصل' : 'صرف راتب حارس');

        const jeId = postJournalEntry(tenant, {
          entryDate: voucherDate,
          description: desc,
          sourceType: expenseKind,
          sourceId: vId,
          propertyId,
          lines: [
            { accountCode, debit: amt, propertyId, memo: desc },
            { accountCode: cb.account_code, credit: amt, propertyId, memo: cb.name },
          ],
        });

        const newBal = D(cb.balance).minus(amt);
        tenant.db
          .prepare(
            `INSERT INTO vouchers (id, organization_id, voucher_number, voucher_type, cashbox_id, property_id, reference_type, reference_id, amount, voucher_date, description, status, journal_entry_id, created_by_user_id, created_at)
             VALUES (?, ?, ?, 'PAYMENT', ?, ?, 'EXPENSE', ?, ?, ?, ?, 'POSTED', ?, ?, ?)`,
          )
          .run(vId, tenant.organizationId, vNum, cb.id, propertyId, vId, amt.toFixed(2), voucherDate, desc, jeId, tenant.userId, nowIso());
        tenant.db
          .prepare(`UPDATE cashboxes SET balance = ? WHERE id = ? AND organization_id = ?`)
          .run(newBal.toFixed(2), cb.id, tenant.organizationId);
        tenant.db
          .prepare(
            `INSERT INTO cashbox_transactions (id, organization_id, cashbox_id, voucher_id, direction, amount, balance_after, created_at)
             VALUES (?, ?, ?, ?, 'OUT', ?, ?, ?)`,
          )
          .run(newId('cbt'), tenant.organizationId, cb.id, vId, amt.toFixed(2), newBal.toFixed(2), nowIso());

        return { voucherId: vId, voucherNumber: vNum, journalEntryId: jeId };
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // --- MAINTENANCE (FR-MNT-01..06) ---

  router.get('/maintenance', requireOrgPermission('maintenance', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const records = tenant.db
        .prepare(
          `SELECT m.*, p.name AS property_name, u.unit_number, pa.name AS tenant_name
           FROM maintenance_records m
           JOIN properties p ON p.id = m.property_id
           LEFT JOIN units u ON u.id = m.unit_id
           LEFT JOIN rent_agreements a ON a.id = m.agreement_id
           LEFT JOIN parties pa ON pa.id = a.tenant_party_id
           WHERE m.organization_id = ?
           ORDER BY m.maintenance_date DESC, m.created_at DESC`,
        )
        .all(tenant.organizationId);
      const types = tenant.db
        .prepare(`SELECT * FROM maintenance_types WHERE organization_id = ? ORDER BY name`)
        .all(tenant.organizationId);
      const recurring = tenant.db
        .prepare(
          `SELECT r.*, p.name AS property_name, u.unit_number
           FROM recurring_maintenance_contracts r
           JOIN properties p ON p.id = r.property_id
           LEFT JOIN units u ON u.id = r.unit_id
           WHERE r.organization_id = ?
           ORDER BY r.next_date ASC`,
        )
        .all(tenant.organizationId);
      const requests = tenant.db
        .prepare(
          `SELECT tmr.*, p.name AS property_name, u.unit_number, pa.name AS tenant_name
           FROM tenant_maintenance_requests tmr
           JOIN properties p ON p.id = tmr.property_id
           JOIN units u ON u.id = tmr.unit_id
           JOIN parties pa ON pa.id = tmr.tenant_party_id
           WHERE tmr.organization_id = ?
           ORDER BY tmr.created_at DESC`,
        )
        .all(tenant.organizationId);
      res.json({ records, types, recurring, requests });
    } catch (err) {
      next(err);
    }
  });

  router.post('/maintenance/types', requireOrgPermission('maintenance', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { name, defaultChargeTo = ChargeTo.OWNER, defaultCause = MaintenanceCause.NORMAL } = req.body ?? {};
      if (!name) throw new HttpError(400, 'اسم نوع الصيانة مطلوب');
      const dup = tenant.db
        .prepare(`SELECT id FROM maintenance_types WHERE organization_id = ? AND name = ?`)
        .get(tenant.organizationId, String(name).trim());
      if (dup) throw new HttpError(409, 'نوع الصيانة موجود مسبقاً');
      const id = newId('mt');
      tenant.db
        .prepare(`INSERT INTO maintenance_types (id, organization_id, name, default_charge_to, default_cause) VALUES (?, ?, ?, ?, ?)`)
        .run(id, tenant.organizationId, String(name).trim(), defaultChargeTo, defaultCause);
      res.status(201).json({ id });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/maintenance/types/:id', requireOrgPermission('maintenance', 'delete'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      tenant.assertOwnedRow(
        tenant.db.prepare(`SELECT * FROM maintenance_types WHERE id = ? AND organization_id = ?`).get(req.params.id, tenant.organizationId) as any,
        'نوع الصيانة',
      );
      tenant.db.prepare(`DELETE FROM maintenance_types WHERE id = ? AND organization_id = ?`).run(req.params.id, tenant.organizationId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/maintenance/recurring', requireOrgPermission('maintenance', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { propertyId, unitId, maintenanceType, description, cost, chargeTo = 'OWNER', vendorName, frequency = 'MONTHLY', nextDate = todayIso() } = req.body ?? {};
      if (!propertyId || !maintenanceType || !description || !cost) {
        throw new HttpError(400, 'بيانات عقد الصيانة الدورية غير مكتملة');
      }
      tenant.assertOwnedRow(
        tenant.db.prepare(`SELECT * FROM properties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`).get(propertyId, tenant.organizationId) as any,
        'العقار',
      );
      const id = newId('rmc');
      tenant.db
        .prepare(
          `INSERT INTO recurring_maintenance_contracts
           (id, organization_id, property_id, unit_id, maintenance_type, description, cost, charge_to, vendor_name, frequency, next_date, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(id, tenant.organizationId, propertyId, unitId || null, maintenanceType, description, toFixedMoney(cost), chargeTo, vendorName ?? null, frequency, nextDate, nowIso());
      res.status(201).json({ id });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/maintenance/recurring/:id', requireOrgPermission('maintenance', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const rec = tenant.assertOwnedRow(
        tenant.db.prepare(`SELECT * FROM recurring_maintenance_contracts WHERE id = ? AND organization_id = ?`).get(req.params.id, tenant.organizationId) as any,
        'عقد الصيانة الدورية',
      );
      const isActive = req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : rec.is_active;
      tenant.db.prepare(`UPDATE recurring_maintenance_contracts SET is_active = ? WHERE id = ? AND organization_id = ?`).run(isActive, rec.id, tenant.organizationId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/maintenance/recurring/generate-due', requireOrgPermission('maintenance', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const asOfDate = req.body?.asOfDate ?? todayIso();
      const result = tenant.runAtomic('RUN_RECURRING_MAINT', undefined, () => {
        const due = tenant.db
          .prepare(`SELECT * FROM recurring_maintenance_contracts WHERE organization_id = ? AND is_active = 1 AND next_date <= ?`)
          .all(tenant.organizationId, asOfDate) as any[];
        const createdIds: string[] = [];
        for (const r of due) {
          const maintId = newId('mnt');
          let agreementId: string | null = null;
          let tenantPartyId: string | null = null;
          if (r.unit_id) {
            const ag = tenant.db
              .prepare(`SELECT id, tenant_party_id FROM rent_agreements WHERE organization_id = ? AND unit_id = ? AND status IN ('ACTIVE','NOTICE') LIMIT 1`)
              .get(tenant.organizationId, r.unit_id) as { id: string; tenant_party_id: string } | undefined;
            if (ag) {
              agreementId = ag.id;
              tenantPartyId = ag.tenant_party_id;
            }
          }
          const effectiveChargeTo = r.charge_to === 'TENANT' && tenantPartyId ? 'TENANT' : (r.charge_to === 'TENANT' ? 'OWNER' : r.charge_to);
          const costD = D(r.cost);
          let jeId: string | null = null;
          if (effectiveChargeTo === 'TENANT' && tenantPartyId) {
            jeId = postJournalEntry(tenant, {
              entryDate: r.next_date,
              description: `صيانة دورية محملة على المستأجر (${r.maintenance_type})`,
              sourceType: 'MAINTENANCE_TENANT_RECOVERY',
              sourceId: maintId,
              propertyId: r.property_id,
              lines: [
                { accountCode: '1210', debit: costD, partyId: tenantPartyId, propertyId: r.property_id, memo: r.description },
                { accountCode: '4300', credit: costD, partyId: tenantPartyId, propertyId: r.property_id, memo: 'استرداد صيانة دورية' },
              ],
            });
          }
          tenant.db
            .prepare(
              `INSERT INTO maintenance_records
               (id, organization_id, property_id, unit_id, agreement_id, maintenance_type, cause, description, cost, paid_amount, charge_to, vendor_name, maintenance_date, status, is_periodic, journal_entry_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'NORMAL', ?, ?, '0.00', ?, ?, ?, 'OPEN', 1, ?, ?)`,
            )
            .run(maintId, tenant.organizationId, r.property_id, r.unit_id, agreementId, r.maintenance_type, r.description, costD.toFixed(2), effectiveChargeTo, r.vendor_name, r.next_date, jeId, nowIso());
          createdIds.push(maintId);
          const months = r.frequency === 'ANNUAL' ? 12 : r.frequency === 'SEMI_ANNUAL' ? 6 : r.frequency === 'QUARTERLY' ? 3 : 1;
          const nextDate = addMonths(r.next_date, months);
          tenant.db.prepare(`UPDATE recurring_maintenance_contracts SET next_date = ? WHERE id = ? AND organization_id = ?`).run(nextDate, r.id, tenant.organizationId);
        }
        return { generatedCount: createdIds.length, createdIds };
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-POR-02: Convert or reject tenant maintenance request
  router.post('/maintenance/requests/:id/convert', requireOrgPermission('maintenance', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { action = 'CONVERT', cost = '0.00', chargeTo = ChargeTo.OWNER, cause = MaintenanceCause.NORMAL, vendorName, description } = req.body ?? {};
      const result = tenant.runAtomic('CONVERT_MAINT_REQ', undefined, () => {
        const tm = tenant.assertOwnedRow(
          tenant.db.prepare(`SELECT * FROM tenant_maintenance_requests WHERE id = ? AND organization_id = ?`).get(req.params.id, tenant.organizationId) as any,
          'طلب الصيانة',
        );
        if (tm.status !== 'PENDING') {
          throw new HttpError(400, 'تمت معالجة هذا الطلب مسبقاً');
        }
        if (action === 'REJECT') {
          tenant.db.prepare(`UPDATE tenant_maintenance_requests SET status = 'REJECTED' WHERE id = ? AND organization_id = ?`).run(tm.id, tenant.organizationId);
          return { status: 'REJECTED' };
        }
        const costD = D(cost);
        if (costD.lte(0)) throw new HttpError(400, 'يجب تحديد التكلفة التقديرية/الفعلية لتحويل الطلب');
        const effectiveChargeTo = cause === MaintenanceCause.TENANT_DAMAGE ? ChargeTo.TENANT : chargeTo;
        const maintId = newId('mnt');
        let jeId: string | null = null;
        if (effectiveChargeTo === ChargeTo.TENANT) {
          jeId = postJournalEntry(tenant, {
            entryDate: todayIso(),
            description: `صيانة محملة على المستأجر من طلب صيانة (${tm.maintenance_type})`,
            sourceType: 'MAINTENANCE_TENANT_RECOVERY',
            sourceId: maintId,
            propertyId: tm.property_id,
            lines: [
              { accountCode: '1210', debit: costD, partyId: tm.tenant_party_id, propertyId: tm.property_id, memo: description || tm.description },
              { accountCode: '4300', credit: costD, partyId: tm.tenant_party_id, propertyId: tm.property_id, memo: 'استرداد صيانة' },
            ],
          });
        }
        tenant.db
          .prepare(
            `INSERT INTO maintenance_records
             (id, organization_id, property_id, unit_id, agreement_id, maintenance_type, cause, description, cost, paid_amount, charge_to, vendor_name, maintenance_date, status, is_periodic, journal_entry_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0.00', ?, ?, ?, 'OPEN', 0, ?, ?)`,
          )
          .run(maintId, tenant.organizationId, tm.property_id, tm.unit_id, tm.agreement_id, tm.maintenance_type, cause, description || tm.description, costD.toFixed(2), effectiveChargeTo, vendorName ?? null, todayIso(), jeId, nowIso());
        tenant.db
          .prepare(`UPDATE tenant_maintenance_requests SET status = 'CONVERTED', converted_maintenance_id = ? WHERE id = ? AND organization_id = ?`)
          .run(maintId, tm.id, tenant.organizationId);
        return { status: 'CONVERTED', maintenanceId: maintId };
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/maintenance', requireOrgPermission('maintenance', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const {
        propertyId,
        unitId,
        maintenanceType,
        cause = MaintenanceCause.NORMAL,
        description,
        cost,
        chargeTo = ChargeTo.OWNER,
        vendorName,
        maintenanceDate = todayIso(),
        status = 'OPEN',
        isPeriodic = false,
        payFromCashboxId,
      } = req.body ?? {};

      if (!propertyId || !maintenanceType || !description || !cost) {
        throw new HttpError(400, 'بيانات الصيانة الأساسية مطلوبة');
      }

      const result = tenant.runAtomic('POST_MAINTENANCE', undefined, () => {
        tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM properties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
            .get(propertyId, tenant.organizationId) as any,
          'العقار',
        );

        let agreementId: string | null = null;
        let tenantPartyId: string | null = null;
        if (unitId) {
          tenant.assertOwnedRow(
            tenant.db
              .prepare(`SELECT * FROM units WHERE id = ? AND property_id = ? AND organization_id = ? AND deleted_at IS NULL`)
              .get(unitId, propertyId, tenant.organizationId) as any,
            'الوحدة',
          );
          // FR-MNT-03: Tenant damage auto-links to active contract
          const activeAg = tenant.db
            .prepare(
              `SELECT id, tenant_party_id FROM rent_agreements
               WHERE organization_id = ? AND unit_id = ? AND status IN ('ACTIVE', 'NOTICE')
                 AND start_date <= ? AND end_date >= ?
               LIMIT 1`,
            )
            .get(tenant.organizationId, unitId, maintenanceDate, maintenanceDate) as
            | { id: string; tenant_party_id: string }
            | undefined;
          if (activeAg) {
            agreementId = activeAg.id;
            tenantPartyId = activeAg.tenant_party_id;
          }
        }

        const effectiveChargeTo = cause === MaintenanceCause.TENANT_DAMAGE ? ChargeTo.TENANT : chargeTo;
        if (effectiveChargeTo === ChargeTo.TENANT && !agreementId) {
          throw new HttpError(400, 'الصيانة المحمّلة على المستأجر تتطلب وحدة بعقد نشط');
        }

        const costD = D(cost);
        if (costD.lte(0)) throw new HttpError(400, 'تكلفة الصيانة يجب أن تكون أكبر من صفر');

        const maintId = newId('mnt');
        let journalEntryId: string | null = null;

        // If paid from cashbox now, post expense & cashbox voucher
        if (payFromCashboxId) {
          const cb = tenant.assertOwnedRow(
            tenant.db
              .prepare(`SELECT * FROM cashboxes WHERE id = ? AND organization_id = ?`)
              .get(payFromCashboxId, tenant.organizationId) as any,
            'الصندوق',
          );
          if (D(cb.balance).lt(costD)) {
            throw new HttpError(400, 'رصيد الصندوق غير كافٍ لسداد فاتورة الصيانة');
          }
          const seq = tenant.nextSequence('voucher_seq');
          const vNum = `PV-${String(seq).padStart(5, '0')}`;
          const vId = newId('vch');
          const expJeId = postJournalEntry(tenant, {
            entryDate: maintenanceDate,
            description: `صرف صيانة (${maintenanceType}): ${description}`,
            sourceType: 'MAINTENANCE_PAYMENT',
            sourceId: maintId,
            propertyId,
            lines: [
              { accountCode: '5100', debit: costD, propertyId, memo: description },
              { accountCode: cb.account_code, credit: costD, propertyId, memo: cb.name },
            ],
          });
          const newBal = D(cb.balance).minus(costD);
          tenant.db
            .prepare(
              `INSERT INTO vouchers (id, organization_id, voucher_number, voucher_type, cashbox_id, property_id, reference_type, reference_id, amount, voucher_date, description, status, journal_entry_id, created_by_user_id, created_at)
               VALUES (?, ?, ?, 'PAYMENT', ?, ?, 'MAINTENANCE', ?, ?, ?, ?, 'POSTED', ?, ?, ?)`,
            )
            .run(vId, tenant.organizationId, vNum, cb.id, propertyId, maintId, costD.toFixed(2), maintenanceDate, `صرف صيانة: ${maintenanceType}`, expJeId, tenant.userId, nowIso());
          tenant.db
            .prepare(`UPDATE cashboxes SET balance = ? WHERE id = ? AND organization_id = ?`)
            .run(newBal.toFixed(2), cb.id, tenant.organizationId);
          tenant.db
            .prepare(
              `INSERT INTO cashbox_transactions (id, organization_id, cashbox_id, voucher_id, direction, amount, balance_after, created_at)
               VALUES (?, ?, ?, ?, 'OUT', ?, ?, ?)`,
            )
            .run(newId('cbt'), tenant.organizationId, cb.id, vId, costD.toFixed(2), newBal.toFixed(2), nowIso());
        }

        // If charged to TENANT, book AR recovery entry so GL 1210 matches subledger
        if (effectiveChargeTo === ChargeTo.TENANT && tenantPartyId) {
          journalEntryId = postJournalEntry(tenant, {
            entryDate: maintenanceDate,
            description: `تحميل صيانة على المستأجر (${maintenanceType})`,
            sourceType: 'MAINTENANCE_TENANT_RECOVERY',
            sourceId: maintId,
            propertyId,
            lines: [
              { accountCode: '1210', debit: costD, partyId: tenantPartyId, propertyId, memo: description },
              { accountCode: '4300', credit: costD, partyId: tenantPartyId, propertyId, memo: 'استرداد صيانة من المستأجر' },
            ],
          });
        }

        tenant.db
          .prepare(
            `INSERT INTO maintenance_records
             (id, organization_id, property_id, unit_id, agreement_id, maintenance_type, cause, description, cost, paid_amount, charge_to, vendor_name, maintenance_date, status, is_periodic, journal_entry_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0.00', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            maintId,
            tenant.organizationId,
            propertyId,
            unitId ?? null,
            agreementId,
            maintenanceType,
            cause,
            description,
            costD.toFixed(2),
            effectiveChargeTo,
            vendorName ?? null,
            maintenanceDate,
            status,
            isPeriodic ? 1 : 0,
            journalEntryId,
            nowIso(),
          );

        tenant.audit({
          entityType: 'Maintenance',
          entityId: maintId,
          action: 'CREATE',
          newValue: { maintenanceType, cost: costD.toFixed(2), chargeTo: effectiveChargeTo },
        });
        return { maintenanceId: maintId };
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/maintenance/:id/status', requireOrgPermission('maintenance', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { status } = req.body ?? {};
      const rec = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM maintenance_records WHERE id = ? AND organization_id = ?`)
          .get(req.params.id, tenant.organizationId) as any,
        'سجل الصيانة',
      );
      tenant.db
        .prepare(`UPDATE maintenance_records SET status = ? WHERE id = ? AND organization_id = ?`)
        .run(status, rec.id, tenant.organizationId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- EVICTIONS, HANDOVER, DEPOSITS & SETTLEMENTS (FR-EVC-* & FR-DEP-*) ---

  router.get('/evictions', requireOrgPermission('evictions', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const evictions = tenant.db
        .prepare(
          `SELECT e.*, a.unit_id, a.property_id, a.tenant_party_id, a.total_amount, u.unit_number, p.name AS property_name, pa.name AS tenant_name,
             sd.held_balance AS deposit_held
           FROM eviction_requests e
           JOIN rent_agreements a ON a.id = e.agreement_id
           JOIN units u ON u.id = a.unit_id
           JOIN properties p ON p.id = a.property_id
           JOIN parties pa ON pa.id = a.tenant_party_id
           LEFT JOIN security_deposits sd ON sd.agreement_id = a.id
           WHERE e.organization_id = ?
           ORDER BY e.created_at DESC`,
        )
        .all(tenant.organizationId) as any[];

      for (const ev of evictions) {
        ev.inspection = tenant.db
          .prepare(`SELECT * FROM move_out_inspections WHERE eviction_id = ? AND organization_id = ?`)
          .get(ev.id, tenant.organizationId);
        if (ev.inspection) {
          ev.damages = tenant.db
            .prepare(`SELECT * FROM damage_items WHERE inspection_id = ? AND organization_id = ?`)
            .all(ev.inspection.id, tenant.organizationId);
        } else {
          ev.damages = [];
        }
        ev.settlement = tenant.db
          .prepare(`SELECT * FROM settlement_statements WHERE eviction_id = ? AND organization_id = ?`)
          .get(ev.id, tenant.organizationId);
        ev.meters = tenant.db
          .prepare(
            `SELECT m.*, sd.name AS service_name FROM service_meters m
             JOIN service_definitions sd ON sd.id = m.service_id
             WHERE m.organization_id = ? AND m.unit_id = ?`,
          )
          .all(tenant.organizationId, ev.unit_id);
        ev.entryPhotos = tenant.db
          .prepare(
            `SELECT id, file_name, attachment_type, created_at FROM attachments
             WHERE organization_id = ? AND attachment_type = 'ENTRY_PHOTO'
               AND ((entity_type = 'AGREEMENT' AND entity_id = ?) OR (entity_type = 'UNIT' AND entity_id = ?))`,
          )
          .all(tenant.organizationId, ev.agreement_id, ev.unit_id);
        ev.exitPhotos = tenant.db
          .prepare(
            `SELECT id, file_name, attachment_type, created_at FROM attachments
             WHERE organization_id = ? AND attachment_type = 'EXIT_PHOTO'
               AND ((entity_type = 'EVICTION' AND entity_id = ?) OR (entity_type = 'AGREEMENT' AND entity_id = ?))`,
          )
          .all(tenant.organizationId, ev.id, ev.agreement_id);
      }

      const deposits = tenant.db
        .prepare(
          `SELECT sd.*, a.unit_id, u.unit_number, p.name AS property_name, pa.name AS tenant_name
           FROM security_deposits sd
           JOIN rent_agreements a ON a.id = sd.agreement_id
           JOIN units u ON u.id = a.unit_id
           JOIN properties p ON p.id = a.property_id
           JOIN parties pa ON pa.id = a.tenant_party_id
           WHERE sd.organization_id = ?`,
        )
        .all(tenant.organizationId) as any[];

      for (const dep of deposits) {
        dep.movements = tenant.db
          .prepare(`SELECT * FROM deposit_movements WHERE deposit_id = ? AND organization_id = ? ORDER BY created_at DESC`)
          .all(dep.id, tenant.organizationId);
      }

      res.json({ evictions, deposits });
    } catch (err) {
      next(err);
    }
  });

  router.post('/evictions', requireOrgPermission('evictions', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const idemKey = req.headers['idempotency-key'] as string | undefined;
      const result = tenant.runAtomic('INIT_EVICTION', idemKey, () => {
        return initiateEvictionAtomic(tenant, req.body);
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/evictions/:id/extend', requireOrgPermission('evictions', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { extendedUntil, reason } = req.body ?? {};
      if (!extendedUntil || !reason) throw new HttpError(400, 'تاريخ التمديد والسبب مطلوبان');
      const ev = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM eviction_requests WHERE id = ? AND organization_id = ?`)
          .get(req.params.id, tenant.organizationId) as any,
        'طلب الإخلاء',
      );
      if (!['IN_GRACE', 'OVERDUE'].includes(ev.status)) {
        throw new HttpError(400, 'لا يمكن تمديد المهلة في الحالة الحالية');
      }
      tenant.db
        .prepare(
          `UPDATE eviction_requests SET extended_until = ?, extension_reason = ?, status = 'IN_GRACE' WHERE id = ? AND organization_id = ?`,
        )
        .run(extendedUntil, reason, ev.id, tenant.organizationId);
      tenant.audit({
        entityType: 'EvictionRequest',
        entityId: ev.id,
        action: 'EXTEND_GRACE',
        oldValue: { extendedUntil: ev.extended_until },
        newValue: { extendedUntil, reason },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // FR-EVC-08: Withdraw eviction request before handover
  router.post('/evictions/:id/withdraw', requireOrgPermission('evictions', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { restoreGraceRent = false } = req.body ?? {};
      const result = tenant.runAtomic('WITHDRAW_EVICTION', undefined, () => {
        const ev = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM eviction_requests WHERE id = ? AND organization_id = ?`)
            .get(req.params.id, tenant.organizationId) as any,
          'طلب الإخلاء',
        );
        StateMachines.eviction(ev.status as EvictionStatus, EvictionStatus.CANCELLED);
        const ag = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ?`)
            .get(ev.agreement_id, tenant.organizationId) as any,
          'العقد',
        );
        StateMachines.agreement(ag.status as RentAgreementStatus, RentAgreementStatus.ACTIVE);

        if (restoreGraceRent) {
          const insts = tenant.db
            .prepare(`SELECT * FROM installments WHERE agreement_id = ? AND organization_id = ? AND CAST(waived_amount AS REAL) > 0`)
            .all(ag.id, tenant.organizationId) as any[];
          for (const inst of insts) {
            const waivedD = D(inst.waived_amount);
            if (inst.accrual_journal_id && waivedD.gt(0)) {
              postJournalEntry(tenant, {
                entryDate: todayIso(),
                description: `إعادة استحقاق قسط #${inst.installment_number} بعد سحب طلب الإخلاء`,
                sourceType: 'GRACE_WITHDRAWAL_RESTORE',
                sourceId: ev.id,
                propertyId: ag.property_id,
                lines: [
                  { accountCode: '1210', debit: waivedD, partyId: ag.tenant_party_id, propertyId: ag.property_id },
                  { accountCode: '5300', credit: waivedD, partyId: ag.tenant_party_id, propertyId: ag.property_id },
                ],
              });
            }
            const nextStatus = D(inst.paid_amount).gt(0) ? InstallmentStatus.PARTIAL : InstallmentStatus.PENDING;
            tenant.db
              .prepare(`UPDATE installments SET waived_amount = '0.00', status = ? WHERE id = ? AND organization_id = ?`)
              .run(nextStatus, inst.id, tenant.organizationId);
          }
        }

        tenant.db
          .prepare(`UPDATE eviction_requests SET status = 'CANCELLED' WHERE id = ? AND organization_id = ?`)
          .run(ev.id, tenant.organizationId);
        tenant.db
          .prepare(`UPDATE rent_agreements SET status = 'ACTIVE' WHERE id = ? AND organization_id = ?`)
          .run(ag.id, tenant.organizationId);

        tenant.audit({
          entityType: 'EvictionRequest',
          entityId: ev.id,
          action: 'WITHDRAW',
          newValue: { restoreGraceRent },
        });
        return { ok: true };
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/evictions/:id/handover', requireOrgPermission('evictions', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const idemKey = req.headers['idempotency-key'] as string | undefined;
      const result = tenant.runAtomic('HANDOVER_EVICTION', idemKey, () => {
        return completeHandoverAndDraftSettlement(tenant, {
          evictionId: req.params.id,
          ...req.body,
        });
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/settlements/:id/approve-post', requireRole(Role.OWNER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { cashboxId } = req.body ?? {};
      const defaultMain = tenant.db
        .prepare(`SELECT id FROM cashboxes WHERE organization_id = ? AND cashbox_type = 'MAIN' LIMIT 1`)
        .get(tenant.organizationId) as { id: string } | undefined;
      const targetCb = cashboxId || defaultMain?.id;
      if (!targetCb) throw new HttpError(400, 'يجب تحديد الصندوق');

      const result = tenant.runAtomic('APPROVE_SETTLEMENT', req.headers['idempotency-key'] as string | undefined, () => {
        return approveAndPostSettlement(tenant, req.params.id, targetCb);
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-DEP-06: Forfeit deposit for contract breach (OWNER only)
  router.post('/deposits/:id/forfeit', requireRole(Role.OWNER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { amount, reason } = req.body ?? {};
      if (!amount || !reason) throw new HttpError(400, 'المبلغ والسبب المكتوب مطلوبان لمصادرة التأمين');

      const result = tenant.runAtomic('FORFEIT_DEPOSIT', undefined, () => {
        const dep = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM security_deposits WHERE id = ? AND organization_id = ?`)
            .get(req.params.id, tenant.organizationId) as any,
          'التأمين',
        );
        const ag = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ?`)
            .get(dep.agreement_id, tenant.organizationId) as any,
          'العقد',
        );
        const amtD = D(amount);
        if (amtD.lte(0) || amtD.gt(D(dep.held_balance))) {
          throw new HttpError(400, 'مبلغ المصادرة يتجاوز رصيد التأمين المحتجز');
        }

        tenant.db
          .prepare(
            `INSERT INTO deposit_movements (id, organization_id, deposit_id, movement_type, amount, reference_type, reference_id, notes, created_at)
             VALUES (?, ?, ?, 'FORFEITED', ?, 'BREACH', ?, ?, ?)`,
          )
          .run(newId('dmv'), tenant.organizationId, dep.id, amtD.toFixed(2), ag.id, reason, nowIso());

        const moves = tenant.db
          .prepare(`SELECT movement_type AS type, amount FROM deposit_movements WHERE deposit_id = ? AND organization_id = ?`)
          .all(dep.id, tenant.organizationId) as any[];
        const bal = calculateDepositBalance(moves);

        const nextStatus = D(bal.heldBalance).eq(0) ? 'FORFEITED' : 'PARTIALLY_APPLIED';
        tenant.db
          .prepare(`UPDATE security_deposits SET held_balance = ?, status = ? WHERE id = ? AND organization_id = ?`)
          .run(bal.heldBalance, nextStatus, dep.id, tenant.organizationId);

        postJournalEntry(tenant, {
          entryDate: todayIso(),
          description: `مصادرة تأمين لإخلال بالعقد: ${reason}`,
          sourceType: 'DEPOSIT_FORFEIT',
          sourceId: dep.id,
          propertyId: ag.property_id,
          lines: [
            { accountCode: '2110', debit: amtD, partyId: ag.tenant_party_id, propertyId: ag.property_id, memo: reason },
            { accountCode: '4400', credit: amtD, partyId: ag.tenant_party_id, propertyId: ag.property_id, memo: 'إيراد غرامات وتعويضات' },
          ],
        });

        tenant.audit({
          entityType: 'SecurityDeposit',
          entityId: dep.id,
          action: 'FORFEIT',
          newValue: { amount: amtD.toFixed(2), reason, heldAfter: bal.heldBalance },
        });
        return { heldBalance: bal.heldBalance, status: nextStatus };
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/evictions/check-daily', requireOrgPermission('evictions', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const result = runEvictionDailyCheck(tenant, req.body?.asOfDate ?? todayIso());
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // --- ATTACHMENTS (FR-ATT-01..04) ---

  router.get('/attachments', requireAuth, (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { entityType, entityId } = req.query;
      let rows: any[];
      if (entityType && entityId) {
        rows = tenant.db
          .prepare(
            `SELECT id, attachment_type, file_name, mime_type, size_bytes, entity_type, entity_id, created_at
             FROM attachments WHERE organization_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC`,
          )
          .all(tenant.organizationId, entityType, entityId);
      } else {
        rows = tenant.db
          .prepare(
            `SELECT id, attachment_type, file_name, mime_type, size_bytes, entity_type, entity_id, created_at
             FROM attachments WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100`,
          )
          .all(tenant.organizationId);
      }
      res.json({ attachments: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/attachments', requireAuth, (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      if (tenant.role === Role.RENTER || tenant.role === Role.UNIT_OWNER) {
        throw new HttpError(403, 'غير مصرح برفع المرفقات من بوابة المستأجر/المالك');
      }
      const {
        attachmentType = AttachmentType.OTHER,
        fileName,
        mimeType = 'image/png',
        dataBase64,
        entityType,
        entityId,
      } = req.body ?? {};
      if (!fileName || !dataBase64 || !entityType || !entityId) {
        throw new HttpError(400, 'بيانات المرفق غير مكتملة');
      }
      const allowedMimes = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf'];
      if (!allowedMimes.includes(mimeType)) {
        throw new HttpError(400, 'نوع الملف غير مدعوم');
      }
      const cleanB64 = String(dataBase64).replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(cleanB64, 'base64');
      if (buf.length > 5 * 1024 * 1024) {
        throw new HttpError(400, 'حجم الملف يتجاوز الحد الأقصى (5MB)');
      }
      const id = newId('att');
      tenant.db
        .prepare(
          `INSERT INTO attachments (id, organization_id, attachment_type, file_name, mime_type, size_bytes, data_base64, entity_type, entity_id, uploaded_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, tenant.organizationId, attachmentType, fileName, mimeType, buf.length, cleanB64, entityType, entityId, tenant.userId, nowIso());
      res.status(201).json({ attachmentId: id, fileName, attachmentType });
    } catch (err) {
      next(err);
    }
  });

  // FR-ATT-01: Issue short-lived HMAC signed URL for private attachment viewing
  router.get('/attachments/:id/signed-url', requireAuth, (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const att = tenant.assertOwnedRow(
        tenant.db.prepare(`SELECT * FROM attachments WHERE id = ? AND organization_id = ?`).get(req.params.id, tenant.organizationId) as any,
        'المرفق',
      );
      if (req.actor!.role === Role.RENTER && att.entity_type === 'AGREEMENT') {
        const ownsAgreement = tenant.db
          .prepare(`SELECT id FROM rent_agreements WHERE id = ? AND tenant_party_id = ? AND organization_id = ?`)
          .get(att.entity_id, req.actor!.partyId, tenant.organizationId);
        if (!ownsAgreement) throw new HttpError(403, 'غير مصرح بعرض هذا المرفق');
      }
      if (req.actor!.role === Role.UNIT_OWNER && att.entity_type === 'AGREEMENT') {
        throw new HttpError(403, 'غير مصرح بعرض مرفقات العقود');
      }
      const exp = Date.now() + 3600 * 1000;
      const sig = createAttachmentSignature(att.id, tenant.organizationId, exp);
      res.json({
        url: `/api/attachments/${att.id}/content?org=${encodeURIComponent(tenant.organizationId)}&exp=${exp}&sig=${sig}`,
        expiresAt: new Date(exp).toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // Private attachment view (accepts either valid signed HMAC URL or authenticated session)
  router.get(
    '/attachments/:id/content',
    (req, res, next) => (req.query.sig ? next() : requireAuth(req, res, next)),
    (req: AuthenticatedRequest, res, next) => {
      try {
        let att: any;
        if (req.query.sig) {
          const sig = String(req.query.sig);
          const exp = Number(req.query.exp);
          const org = String(req.query.org || '');
          if (!org || !verifyAttachmentSignature(req.params.id, org, exp, sig)) {
            throw new HttpError(403, 'رابط المرفق الموقع غير صالح أو منتهي الصلاحية');
          }
          att = req.db.prepare(`SELECT * FROM attachments WHERE id = ? AND organization_id = ?`).get(req.params.id, org);
          if (!att) throw new HttpError(404, 'المرفق غير موجود');
        } else {
          const tenant = getTenantDb(req);
          att = tenant.assertOwnedRow(
            tenant.db.prepare(`SELECT * FROM attachments WHERE id = ? AND organization_id = ?`).get(req.params.id, tenant.organizationId) as any,
            'المرفق',
          );
          if (req.actor!.role === Role.RENTER && att.entity_type === 'AGREEMENT') {
            const ownsAgreement = tenant.db
              .prepare(`SELECT id FROM rent_agreements WHERE id = ? AND tenant_party_id = ? AND organization_id = ?`)
              .get(att.entity_id, req.actor!.partyId, tenant.organizationId);
            if (!ownsAgreement) throw new HttpError(403, 'غير مصرح بعرض هذا المرفق');
          }
          if (req.actor!.role === Role.UNIT_OWNER && att.entity_type === 'AGREEMENT') {
            throw new HttpError(403, 'غير مصرح بعرض مرفقات العقود');
          }
        }
        const buf = Buffer.from(att.data_base64, 'base64');
        res.setHeader('Content-Type', att.mime_type);
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(buf);
      } catch (err) {
        next(err);
      }
    },
  );

  // --- NOTIFICATIONS (FR-NTF-01..04) ---

  router.get('/notifications', requireOrgPermission('notifications', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const notifications = tenant.db
        .prepare(
          `SELECT n.*, u.full_name AS sender_name,
            (SELECT COUNT(*) FROM notification_recipients nr WHERE nr.notification_id = n.id) AS recipient_count,
            (SELECT COUNT(*) FROM notification_recipients nr WHERE nr.notification_id = n.id AND nr.read_at IS NOT NULL) AS read_count
           FROM notifications n
           LEFT JOIN users u ON u.id = n.sender_user_id
           WHERE n.organization_id = ?
           ORDER BY n.created_at DESC`,
        )
        .all(tenant.organizationId);
      const templates = tenant.db
        .prepare(`SELECT * FROM notification_templates WHERE organization_id = ? ORDER BY name`)
        .all(tenant.organizationId);
      const scheduled = tenant.db
        .prepare(`SELECT * FROM scheduled_notifications WHERE organization_id = ? ORDER BY scheduled_for DESC`)
        .all(tenant.organizationId);
      const outbox = tenant.db
        .prepare(`SELECT * FROM email_outbox_log WHERE organization_id = ? ORDER BY created_at DESC LIMIT 30`)
        .all(tenant.organizationId);
      res.json({ notifications, templates, scheduled, outbox });
    } catch (err) {
      next(err);
    }
  });

  // FR-NTF-05: Notification Templates & Scheduled Notifications
  router.post('/notifications/templates', requireOrgPermission('notifications', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { code, name, titleTemplate, bodyTemplate, channel = 'IN_APP_EMAIL' } = req.body ?? {};
      if (!code || !name || !titleTemplate || !bodyTemplate) {
        throw new HttpError(400, 'كود القالب واسمه وعنوانه ونصه مطلوبة');
      }
      const id = newId('ntpl');
      tenant.db
        .prepare(
          `INSERT INTO notification_templates (id, organization_id, code, name, title_template, body_template, channel, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, tenant.organizationId, String(code).trim(), String(name).trim(), titleTemplate, bodyTemplate, channel, nowIso());
      res.status(201).json({ id });
    } catch (err) {
      next(err);
    }
  });

  router.put('/notifications/templates/:id', requireOrgPermission('notifications', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const tpl = tenant.assertOwnedRow(
        tenant.db.prepare(`SELECT * FROM notification_templates WHERE id = ? AND organization_id = ?`).get(req.params.id, tenant.organizationId) as any,
        'قالب الإشعار',
      );
      const { name, titleTemplate, bodyTemplate, channel } = req.body ?? {};
      tenant.db
        .prepare(
          `UPDATE notification_templates SET name = COALESCE(?, name), title_template = COALESCE(?, title_template), body_template = COALESCE(?, body_template), channel = COALESCE(?, channel), updated_at = ? WHERE id = ? AND organization_id = ?`,
        )
        .run(name ?? null, titleTemplate ?? null, bodyTemplate ?? null, channel ?? null, nowIso(), tpl.id, tenant.organizationId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/notifications/scheduled', requireOrgPermission('notifications', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { title, body, audienceType = 'ALL', audienceTargetId, scheduledFor } = req.body ?? {};
      if (!title || !body || !scheduledFor) {
        throw new HttpError(400, 'العنوان والنص وتاريخ الإرسال المجدول مطلوبة');
      }
      const id = newId('sntf');
      tenant.db
        .prepare(
          `INSERT INTO scheduled_notifications (id, organization_id, created_by_user_id, title, body, audience_type, audience_target_id, scheduled_for, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?)`,
        )
        .run(id, tenant.organizationId, tenant.userId, title, body, audienceType, audienceTargetId ?? null, scheduledFor, nowIso());
      res.status(201).json({ id });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/notifications/scheduled/:id', requireOrgPermission('notifications', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const row = tenant.assertOwnedRow(
        tenant.db.prepare(`SELECT * FROM scheduled_notifications WHERE id = ? AND organization_id = ?`).get(req.params.id, tenant.organizationId) as any,
        'الإشعار المجدول',
      );
      if (req.body?.status === 'CANCELLED' && row.status === 'SCHEDULED') {
        tenant.db.prepare(`UPDATE scheduled_notifications SET status = 'CANCELLED' WHERE id = ? AND organization_id = ?`).run(row.id, tenant.organizationId);
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/notifications', requireOrgPermission('notifications', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { title, body, audienceType = 'ALL', audienceTargetId } = req.body ?? {};
      if (!title || !body) throw new HttpError(400, 'عنوان الإشعار ونصه مطلوبان');

      const notifId = newId('ntf');
      tenant.db
        .prepare(
          `INSERT INTO notifications (id, organization_id, sender_user_id, title, body, audience_type, audience_target_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(notifId, tenant.organizationId, tenant.userId, title, body, audienceType, audienceTargetId ?? null, nowIso());

      let targetParties: Array<{ party_id: string }> = [];
      if (audienceType === 'ALL') {
        targetParties = tenant.db
          .prepare(`SELECT id AS party_id FROM parties WHERE organization_id = ? AND deleted_at IS NULL`)
          .all(tenant.organizationId) as any[];
      } else if (audienceType === 'PROPERTY' && audienceTargetId) {
        targetParties = tenant.db
          .prepare(
            `SELECT DISTINCT tenant_party_id AS party_id FROM rent_agreements WHERE organization_id = ? AND property_id = ? AND status IN ('ACTIVE','NOTICE')
             UNION
             SELECT DISTINCT unit_owner_party_id AS party_id FROM units WHERE organization_id = ? AND property_id = ? AND tenure_type = 'OWNED' AND unit_owner_party_id IS NOT NULL`,
          )
          .all(tenant.organizationId, audienceTargetId, tenant.organizationId, audienceTargetId) as any[];
      } else if (audienceType === 'UNIT' && audienceTargetId) {
        targetParties = tenant.db
          .prepare(
            `SELECT tenant_party_id AS party_id FROM rent_agreements WHERE organization_id = ? AND unit_id = ? AND status IN ('ACTIVE','NOTICE')
             UNION
             SELECT unit_owner_party_id AS party_id FROM units WHERE organization_id = ? AND id = ? AND tenure_type = 'OWNED' AND unit_owner_party_id IS NOT NULL`,
          )
          .all(tenant.organizationId, audienceTargetId, tenant.organizationId, audienceTargetId) as any[];
      } else if (audienceType === 'PARTY' && audienceTargetId) {
        tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT id, organization_id FROM parties WHERE id = ? AND organization_id = ?`)
            .get(audienceTargetId, tenant.organizationId) as any,
          'الطرف',
        );
        targetParties = [{ party_id: audienceTargetId }];
      }

      const insertRec = tenant.db.prepare(
        `INSERT INTO notification_recipients (id, organization_id, notification_id, user_id, party_id) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const tp of targetParties) {
        const u = tenant.db
          .prepare(`SELECT id FROM users WHERE organization_id = ? AND party_id = ? AND is_active = 1`)
          .get(tenant.organizationId, tp.party_id) as { id: string } | undefined;
        insertRec.run(newId('nrec'), tenant.organizationId, notifId, u?.id ?? null, tp.party_id);
      }

      res.status(201).json({ notificationId: notifId, recipientCount: targetParties.length });
    } catch (err) {
      next(err);
    }
  });

  // --- ORG SETTINGS, USERS, STAFF RBAC & COLLECTORS (FR-IAM-05, P6) ---

  router.get('/settings', requireOrgPermission('settings', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const org = tenant.getOrg();
      const users = tenant.db
        .prepare(
          `SELECT id, role, email, full_name, is_active, party_id, staff_permissions_json, two_factor_enabled, created_at
           FROM users WHERE organization_id = ? ORDER BY created_at DESC`,
        )
        .all(tenant.organizationId) as any[];
      const auditLogs = tenant.db
        .prepare(
          `SELECT a.*, u.full_name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
           WHERE a.organization_id = ? ORDER BY a.created_at DESC LIMIT 100`,
        )
        .all(tenant.organizationId);

      res.json({
        organization: org,
        users: users.map((u) => ({
          ...u,
          staffPermissions: u.staff_permissions_json ? JSON.parse(u.staff_permissions_json) : null,
        })),
        auditLogs,
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/settings', requireRole(Role.OWNER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const {
        name,
        timezone,
        baseCurrency,
        defaultGraceDays,
        postGraceRentEnabled,
        roundingStep,
        contractExpiryAlertDays,
        showHijriDates,
        retentionYears,
      } = req.body ?? {};

      tenant.db
        .prepare(
          `UPDATE organizations SET
            name = COALESCE(?, name),
            timezone = COALESCE(?, timezone),
            base_currency = COALESCE(?, base_currency),
            default_grace_days = COALESCE(?, default_grace_days),
            post_grace_rent_enabled = COALESCE(?, post_grace_rent_enabled),
            rounding_step = ?,
            contract_expiry_alert_days = COALESCE(?, contract_expiry_alert_days),
            show_hijri_dates = COALESCE(?, show_hijri_dates),
            retention_years = COALESCE(?, retention_years)
           WHERE id = ?`,
        )
        .run(
          name ?? null,
          timezone ?? null,
          baseCurrency ?? null,
          defaultGraceDays !== undefined ? Number(defaultGraceDays) : null,
          postGraceRentEnabled !== undefined ? (postGraceRentEnabled ? 1 : 0) : null,
          roundingStep ? String(roundingStep) : null,
          contractExpiryAlertDays !== undefined ? Number(contractExpiryAlertDays) : null,
          showHijriDates !== undefined ? (showHijriDates ? 1 : 0) : null,
          retentionYears !== undefined ? Number(retentionYears) : null,
          tenant.organizationId,
        );

      tenant.audit({
        entityType: 'Organization',
        entityId: tenant.organizationId,
        action: 'UPDATE_SETTINGS',
        newValue: req.body,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // OWNER creates STAFF or COLLECTOR (FR-IAM-05, FR-COL-01)
  router.post('/users', requireRole(Role.OWNER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const {
        role,
        email,
        fullName,
        password,
        staffPermissions,
        collectorFlags,
        assignedPropertyIds = [],
        rewardType = 'NONE',
        rewardValue = '0',
      } = req.body ?? {};

      if (!role || !email || !fullName || !password) {
        throw new HttpError(400, 'الدور والبريد والاسم وكلمة المرور مطلوبة');
      }
      if (role !== Role.STAFF && role !== Role.COLLECTOR) {
        throw new HttpError(400, 'يمكن إنشاء حسابات STAFF أو COLLECTOR فقط من لوحة المالك');
      }

      const settings = tenant.db
        .prepare(`SELECT min_password_length FROM platform_settings WHERE id = 'default'`)
        .get() as { min_password_length: number } | undefined;
      const hash = hashPassword(String(password), settings?.min_password_length ?? 12);
      const normalizedEmail = String(email).trim().toLowerCase();

      const dup = tenant.db.prepare(`SELECT id FROM users WHERE lower(email) = ?`).get(normalizedEmail);
      if (dup) throw new HttpError(409, 'البريد الإلكتروني مستخدم بالفعل');

      const result = tenant.runAtomic('CREATE_ORG_USER', undefined, () => {
        const userId = newId('usr');
        const permsJson =
          role === Role.STAFF
            ? JSON.stringify(staffPermissions ?? buildDefaultStaffPermissions(false))
            : null;

        tenant.db
          .prepare(
            `INSERT INTO users (id, organization_id, role, email, full_name, password_hash, is_active, token_version, staff_permissions_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
          )
          .run(userId, tenant.organizationId, role, normalizedEmail, String(fullName).trim(), hash, permsJson, nowIso());

        let collectorId: string | null = null;
        if (role === Role.COLLECTOR) {
          // FR-COL-01: Auto-create collector cashbox with zero opening balance
          const cbId = newId('cb');
          tenant.db
            .prepare(
              `INSERT INTO cashboxes (id, organization_id, name, cashbox_type, account_code, custodian_user_id, balance, is_active, created_at)
               VALUES (?, ?, ?, 'COLLECTOR', '1120', ?, '0.00', 1, ?)`,
            )
            .run(cbId, tenant.organizationId, `صندوق المحصل - ${String(fullName).trim()}`, userId, nowIso());

          collectorId = newId('col');
          tenant.db
            .prepare(
              `INSERT INTO collectors (id, organization_id, user_id, can_collect_rent, can_collect_services, can_collect_maintenance, can_create_services, reward_type, reward_value, is_active, cashbox_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              collectorId,
              tenant.organizationId,
              userId,
              collectorFlags?.canCollectRent ? 1 : 0,
              collectorFlags?.canCollectServices ? 1 : 0,
              collectorFlags?.canCollectMaintenance ? 1 : 0,
              collectorFlags?.canCreateServices ? 1 : 0,
              rewardType,
              toFixedMoney(rewardValue),
              cbId,
              nowIso(),
            );

          for (const propId of assignedPropertyIds) {
            tenant.assertOwnedRow(
              tenant.db
                .prepare(`SELECT id, organization_id FROM properties WHERE id = ? AND organization_id = ?`)
                .get(propId, tenant.organizationId) as any,
              'العقار',
            );
            tenant.db
              .prepare(
                `INSERT INTO collector_properties (id, organization_id, collector_id, property_id) VALUES (?, ?, ?, ?)`,
              )
              .run(newId('cp'), tenant.organizationId, collectorId, propId);
          }
        }

        tenant.audit({
          entityType: 'User',
          entityId: userId,
          action: 'CREATE',
          newValue: { role, email: normalizedEmail, collectorId },
        });
        return { userId, collectorId };
      });

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Immediate suspension / permission update (increments tokenVersion -> P8)
  router.patch('/users/:id', requireRole(Role.OWNER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const target = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM users WHERE id = ? AND organization_id = ?`)
          .get(req.params.id, tenant.organizationId) as any,
        'المستخدم',
      );
      if (target.role === Role.OWNER) {
        throw new HttpError(403, 'لا يمكن إيقاف حساب المالك من هنا');
      }
      const { isActive, staffPermissions, collectorFlags, assignedPropertyIds, rewardType, rewardValue } = req.body ?? {};
      if (typeof isActive === 'boolean') {
        tenant.db
          .prepare(`UPDATE users SET is_active = ?, token_version = token_version + 1 WHERE id = ? AND organization_id = ?`)
          .run(isActive ? 1 : 0, target.id, tenant.organizationId);
        if (target.role === Role.COLLECTOR) {
          tenant.db
            .prepare(`UPDATE collectors SET is_active = ? WHERE user_id = ? AND organization_id = ?`)
            .run(isActive ? 1 : 0, target.id, tenant.organizationId);
        }
      }
      if (staffPermissions && target.role === Role.STAFF) {
        tenant.db
          .prepare(`UPDATE users SET staff_permissions_json = ?, token_version = token_version + 1 WHERE id = ? AND organization_id = ?`)
          .run(JSON.stringify(staffPermissions), target.id, tenant.organizationId);
      }
      if (target.role === Role.COLLECTOR && (collectorFlags || assignedPropertyIds || rewardType !== undefined || rewardValue !== undefined)) {
        const col = tenant.db
          .prepare(`SELECT * FROM collectors WHERE user_id = ? AND organization_id = ?`)
          .get(target.id, tenant.organizationId) as any;
        if (col && collectorFlags) {
          tenant.db
            .prepare(
              `UPDATE collectors SET can_collect_rent = ?, can_collect_services = ?, can_collect_maintenance = ?, can_create_services = ? WHERE id = ?`,
            )
            .run(
              collectorFlags.canCollectRent ? 1 : 0,
              collectorFlags.canCollectServices ? 1 : 0,
              collectorFlags.canCollectMaintenance ? 1 : 0,
              collectorFlags.canCreateServices ? 1 : 0,
              col.id,
            );
        }
        if (col && (rewardType !== undefined || rewardValue !== undefined)) {
          tenant.db
            .prepare(`UPDATE collectors SET reward_type = COALESCE(?, reward_type), reward_value = COALESCE(?, reward_value) WHERE id = ?`)
            .run(rewardType ?? null, rewardValue !== undefined ? toFixedMoney(rewardValue) : null, col.id);
        }
        if (col && Array.isArray(assignedPropertyIds)) {
          tenant.db.prepare(`DELETE FROM collector_properties WHERE collector_id = ?`).run(col.id);
          for (const pid of assignedPropertyIds) {
            tenant.db
              .prepare(`INSERT INTO collector_properties (id, organization_id, collector_id, property_id) VALUES (?, ?, ?, ?)`)
              .run(newId('cp'), tenant.organizationId, col.id, pid);
          }
        }
      }

      tenant.audit({
        entityType: 'User',
        entityId: target.id,
        action: 'UPDATE',
        newValue: { isActive, rewardType, rewardValue },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
