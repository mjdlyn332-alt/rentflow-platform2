import { Router } from 'express';
import Decimal from 'decimal.js';
import { D, toFixedMoney } from '../../domain/money';
import { calculateManagementCommission } from '../../domain/rules';
import {
  AttachmentType,
  ChargeTo,
  CommissionType,
  Role,
  VoucherReferenceType,
  VoucherType,
} from '../../domain/types';
import { postJournalEntry, reconcileOrganization, reverseJournalEntry } from '../accounting';
import { AuthenticatedRequest, getTenantDb, requireOrgPermission, requireRole } from '../auth';
import { HttpError, newId, nowIso, todayIso } from '../db';
import { createVoucherAtomic, deriveUnitStatus } from '../domainService';
import { issueUnitServiceBill } from './contractsAndServicesRoutes';

export function createAccountingAndReportsRouter(): Router {
  const router = Router();

  // --- ACCOUNTING (FR-ACC-01..11) ---

  router.get('/accounting/overview', requireOrgPermission('accounting', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const accounts = tenant.db
        .prepare(`SELECT * FROM chart_accounts WHERE organization_id = ? ORDER BY code`)
        .all(tenant.organizationId) as any[];

      const lines = tenant.db
        .prepare(`SELECT account_code, debit, credit FROM journal_lines WHERE organization_id = ?`)
        .all(tenant.organizationId) as Array<{ account_code: string; debit: string; credit: string }>;

      const totalsByCode = new Map<string, { debit: Decimal; credit: Decimal }>();
      for (const l of lines) {
        const cur = totalsByCode.get(l.account_code) ?? { debit: new Decimal(0), credit: new Decimal(0) };
        cur.debit = cur.debit.plus(D(l.debit));
        cur.credit = cur.credit.plus(D(l.credit));
        totalsByCode.set(l.account_code, cur);
      }

      const trialBalance = accounts.map((acc) => {
        const t = totalsByCode.get(acc.code) ?? { debit: new Decimal(0), credit: new Decimal(0) };
        const net = t.debit.minus(t.credit);
        return {
          ...acc,
          totalDebit: t.debit.toFixed(2),
          totalCredit: t.credit.toFixed(2),
          netDebit: net.gt(0) ? net.toFixed(2) : '0.00',
          netCredit: net.lt(0) ? net.abs().toFixed(2) : '0.00',
        };
      });

      const entries = tenant.db
        .prepare(
          `SELECT je.*, p.name AS property_name
           FROM journal_entries je
           LEFT JOIN properties p ON p.id = je.property_id
           WHERE je.organization_id = ?
           ORDER BY je.entry_date DESC, je.created_at DESC
           LIMIT 100`,
        )
        .all(tenant.organizationId) as any[];

      for (const je of entries) {
        je.lines = tenant.db
          .prepare(
            `SELECT jl.*, ca.name AS account_name, pa.name AS party_name
             FROM journal_lines jl
             JOIN chart_accounts ca ON ca.code = jl.account_code AND ca.organization_id = jl.organization_id
             LEFT JOIN parties pa ON pa.id = jl.party_id
             WHERE jl.journal_entry_id = ? AND jl.organization_id = ?`,
          )
          .all(je.id, tenant.organizationId);
      }

      const postingRules = tenant.db
        .prepare(`SELECT * FROM posting_rules WHERE organization_id = ?`)
        .all(tenant.organizationId);

      const periods = tenant.db
        .prepare(`SELECT * FROM accounting_periods WHERE organization_id = ? ORDER BY start_date DESC`)
        .all(tenant.organizationId);

      const reconciliation = reconcileOrganization(tenant);

      res.json({ trialBalance, entries, postingRules, periods, reconciliation });
    } catch (err) {
      next(err);
    }
  });

  // FR-ACC-07: Manual Journal Entry (requires OWNER or accounting.create permission)
  router.post('/accounting/journal-entries', requireOrgPermission('accounting', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { entryDate = todayIso(), description, propertyId, lines } = req.body ?? {};
      if (!description || !Array.isArray(lines) || lines.length < 2) {
        throw new HttpError(400, 'الوصف وسطران محاسبيان متوازنان على الأقل مطلوبة');
      }
      const entryId = tenant.runAtomic('MANUAL_JE', undefined, () => {
        const id = postJournalEntry(tenant, {
          entryDate,
          description,
          sourceType: 'MANUAL',
          sourceId: newId('man'),
          propertyId: propertyId ?? null,
          isManual: true,
          lines,
        });
        tenant.audit({
          entityType: 'JournalEntry',
          entityId: id,
          action: 'CREATE_MANUAL',
          newValue: { entryDate, description },
        });
        return id;
      });
      res.status(201).json({ entryId });
    } catch (err) {
      next(err);
    }
  });

  // FR-ACC-01: Add & rename custom account in Chart of Accounts
  router.post('/accounting/accounts', requireRole(Role.OWNER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { code, name, accountType } = req.body ?? {};
      if (!code || !name || !accountType) throw new HttpError(400, 'رمز الحساب والاسم والنوع مطلوبة');
      const dup = tenant.db
        .prepare(`SELECT id FROM chart_accounts WHERE organization_id = ? AND code = ?`)
        .get(tenant.organizationId, String(code).trim());
      if (dup) throw new HttpError(409, 'رمز الحساب مستخدم مسبقاً');
      const id = newId('acc');
      tenant.db
        .prepare(
          `INSERT INTO chart_accounts (id, organization_id, code, name, account_type, is_system) VALUES (?, ?, ?, ?, ?, 0)`,
        )
        .run(id, tenant.organizationId, String(code).trim(), String(name).trim(), accountType);
      res.status(201).json({ id });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/accounting/accounts/:id', requireRole(Role.OWNER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const acc = tenant.assertOwnedRow(
        tenant.db.prepare(`SELECT * FROM chart_accounts WHERE id = ? AND organization_id = ?`).get(req.params.id, tenant.organizationId) as any,
        'الحساب المحاسبي',
      );
      const { name } = req.body ?? {};
      if (!name || !String(name).trim()) throw new HttpError(400, 'اسم الحساب مطلوب');
      tenant.db
        .prepare(`UPDATE chart_accounts SET name = ? WHERE id = ? AND organization_id = ?`)
        .run(String(name).trim(), acc.id, tenant.organizationId);
      tenant.audit({ entityType: 'ChartAccount', entityId: acc.id, action: 'UPDATE', oldValue: { name: acc.name }, newValue: { name } });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // FR-ACC-03: Edit posting rule accounts
  router.patch('/accounting/posting-rules/:id', requireRole(Role.OWNER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const rule = tenant.assertOwnedRow(
        tenant.db.prepare(`SELECT * FROM posting_rules WHERE id = ? AND organization_id = ?`).get(req.params.id, tenant.organizationId) as any,
        'قاعدة الترحيل',
      );
      const { debitAccountCode, creditAccountCode, description } = req.body ?? {};
      if (debitAccountCode) {
        tenant.assertOwnedRow(
          tenant.db.prepare(`SELECT * FROM chart_accounts WHERE organization_id = ? AND code = ?`).get(tenant.organizationId, debitAccountCode) as any,
          'حساب المدين',
        );
      }
      if (creditAccountCode) {
        tenant.assertOwnedRow(
          tenant.db.prepare(`SELECT * FROM chart_accounts WHERE organization_id = ? AND code = ?`).get(tenant.organizationId, creditAccountCode) as any,
          'حساب الدائن',
        );
      }
      tenant.db
        .prepare(
          `UPDATE posting_rules SET debit_account_code = COALESCE(?, debit_account_code), credit_account_code = COALESCE(?, credit_account_code), description = COALESCE(?, description) WHERE id = ? AND organization_id = ?`,
        )
        .run(debitAccountCode ?? null, creditAccountCode ?? null, description ?? null, rule.id, tenant.organizationId);
      tenant.audit({ entityType: 'PostingRule', entityId: rule.id, action: 'UPDATE', newValue: req.body });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // FR-ACC-07: Reverse Journal Entry
  router.post('/accounting/journal-entries/:id/reverse', requireOrgPermission('accounting', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const reason = String(req.body?.reason || 'قيد عكسي يدوي').trim();
      const reversedEntryId = tenant.runAtomic('REVERSE_JE', undefined, () => {
        const jeId = reverseJournalEntry(tenant, req.params.id, req.body?.reversalDate ?? todayIso(), reason, 'MANUAL_REVERSAL', req.params.id);
        tenant.audit({ entityType: 'JournalEntry', entityId: req.params.id, action: 'REVERSE', newValue: { reversedEntryId: jeId, reason } });
        return jeId;
      });
      res.status(201).json({ reversedEntryId });
    } catch (err) {
      next(err);
    }
  });

  // FR-ACC-08: General Ledger (كشف حساب تفصيلي) for a specific account
  router.get('/accounting/ledger', requireOrgPermission('accounting', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const accountCode = String(req.query.accountCode || '1210');
      const from = req.query.from ? String(req.query.from) : null;
      const to = req.query.to ? String(req.query.to) : null;

      const account = tenant.assertOwnedRow(
        tenant.db.prepare(`SELECT * FROM chart_accounts WHERE organization_id = ? AND code = ?`).get(tenant.organizationId, accountCode) as any,
        'الحساب',
      );
      const isDebitNormal = account.account_type === 'ASSET' || account.account_type === 'EXPENSE';

      const allLines = tenant.db
        .prepare(
          `SELECT jl.*, je.entry_number, je.entry_date, je.description AS entry_description, je.source_type, pa.name AS party_name, pr.name AS property_name
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.journal_entry_id
           LEFT JOIN parties pa ON pa.id = jl.party_id
           LEFT JOIN properties pr ON pr.id = jl.property_id
           WHERE jl.organization_id = ? AND jl.account_code = ?
           ORDER BY je.entry_date ASC, je.created_at ASC`,
        )
        .all(tenant.organizationId, accountCode) as any[];

      let opening = new Decimal(0);
      let running = new Decimal(0);
      const filteredLines: any[] = [];

      for (const l of allLines) {
        const delta = isDebitNormal ? D(l.debit).minus(D(l.credit)) : D(l.credit).minus(D(l.debit));
        if (from && l.entry_date < from) {
          opening = opening.plus(delta);
          running = running.plus(delta);
          continue;
        }
        if (to && l.entry_date > to) continue;
        running = running.plus(delta);
        filteredLines.push({
          ...l,
          runningBalance: running.toFixed(2),
        });
      }

      res.json({
        account,
        isDebitNormal,
        openingBalance: opening.toFixed(2),
        closingBalance: running.toFixed(2),
        lines: filteredLines,
      });
    } catch (err) {
      next(err);
    }
  });

  // FR-ACC-06: Close/Reopen accounting period
  router.patch('/accounting/periods/:id', requireRole(Role.OWNER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const period = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM accounting_periods WHERE id = ? AND organization_id = ?`)
          .get(req.params.id, tenant.organizationId) as any,
        'الفترة المحاسبية',
      );
      const isClosed = Boolean(req.body?.isClosed);
      tenant.db
        .prepare(`UPDATE accounting_periods SET is_closed = ?, closed_at = ? WHERE id = ? AND organization_id = ?`)
        .run(isClosed ? 1 : 0, isClosed ? nowIso() : null, period.id, tenant.organizationId);
      tenant.audit({
        entityType: 'AccountingPeriod',
        entityId: period.id,
        action: isClosed ? 'CLOSE' : 'REOPEN',
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // FR-ACC-08: Property Income Statement
  router.get('/accounting/property-income', requireOrgPermission('accounting', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const properties = tenant.db
        .prepare(`SELECT id, code, name FROM properties WHERE organization_id = ? AND deleted_at IS NULL`)
        .all(tenant.organizationId) as any[];

      const results = properties.map((p) => {
        const rows = tenant.db
          .prepare(
            `SELECT ca.account_type, jl.account_code, ca.name AS account_name, jl.debit, jl.credit
             FROM journal_lines jl
             JOIN chart_accounts ca ON ca.code = jl.account_code AND ca.organization_id = jl.organization_id
             WHERE jl.organization_id = ? AND jl.property_id = ? AND ca.account_type IN ('REVENUE', 'EXPENSE')`,
          )
          .all(tenant.organizationId, p.id) as any[];

        let revenue = new Decimal(0);
        let expense = new Decimal(0);
        for (const r of rows) {
          if (r.account_type === 'REVENUE') {
            revenue = revenue.plus(D(r.credit)).minus(D(r.debit));
          } else {
            expense = expense.plus(D(r.debit)).minus(D(r.credit));
          }
        }
        return {
          propertyId: p.id,
          code: p.code,
          name: p.name,
          revenue: revenue.toFixed(2),
          expense: expense.toFixed(2),
          netIncome: revenue.minus(expense).toFixed(2),
        };
      });

      res.json({ propertyIncome: results });
    } catch (err) {
      next(err);
    }
  });

  // --- REPORTS (FR-RPT-01..08) ---

  router.get('/reports/summary', requireOrgPermission('reports', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const org = tenant.getOrg();

      const props = tenant.db
        .prepare(`SELECT * FROM properties WHERE organization_id = ? AND deleted_at IS NULL`)
        .all(tenant.organizationId) as any[];

      const units = tenant.db
        .prepare(`SELECT * FROM units WHERE organization_id = ? AND deleted_at IS NULL`)
        .all(tenant.organizationId) as any[];

      let vacantCount = 0;
      let rentedCount = 0;
      let ownedCount = 0;
      let maintCount = 0;

      for (const u of units) {
        const st = deriveUnitStatus(tenant, u.id, u.tenure_type);
        if (st === 'OWNED') ownedCount += 1;
        else if (st === 'RENTED') rentedCount += 1;
        else if (st === 'MAINTENANCE') maintCount += 1;
        else vacantCount += 1;
      }

      // FR-RPT-01: Charge-To breakdown (Tenant vs Owner) across Maintenance, Services, Contract Expenses
      const maintChargeRows = tenant.db
        .prepare(`SELECT m.*, p.name AS property_name, u.unit_number FROM maintenance_records m JOIN properties p ON p.id = m.property_id LEFT JOIN units u ON u.id = m.unit_id WHERE m.organization_id = ?`)
        .all(tenant.organizationId) as any[];
      const billChargeRows = tenant.db
        .prepare(`SELECT b.*, sd.name AS service_name, p.name AS property_name, u.unit_number FROM service_bills b JOIN service_definitions sd ON sd.id = b.service_id JOIN properties p ON p.id = b.property_id JOIN units u ON u.id = b.unit_id WHERE b.organization_id = ? AND b.status != 'VOID'`)
        .all(tenant.organizationId) as any[];
      const ceChargeRows = tenant.db
        .prepare(
          `SELECT cei.*, a.start_date, p.name AS property_name, u.unit_number
           FROM contract_expense_items cei
           JOIN rent_agreements a ON a.id = cei.agreement_id
           JOIN properties p ON p.id = a.property_id
           JOIN units u ON u.id = a.unit_id
           WHERE cei.organization_id = ?`,
        )
        .all(tenant.organizationId) as any[];

      let tenantMaintTotal = new Decimal(0);
      let ownerMaintTotal = new Decimal(0);
      const chargeToDetails: any[] = [];
      for (const m of maintChargeRows) {
        if (m.charge_to === 'TENANT') tenantMaintTotal = tenantMaintTotal.plus(D(m.cost));
        else ownerMaintTotal = ownerMaintTotal.plus(D(m.cost));
        chargeToDetails.push({
          source: 'صيانة',
          description: `${m.maintenance_type} — ${m.description}`,
          propertyName: m.property_name,
          unitNumber: m.unit_number ?? 'عام',
          chargeTo: m.charge_to,
          amount: m.cost,
          paidAmount: m.paid_amount,
          date: m.maintenance_date,
        });
      }
      let tenantBillTotal = new Decimal(0);
      let ownerBillTotal = new Decimal(0);
      for (const b of billChargeRows) {
        if (b.payer_role === 'OWNER') ownerBillTotal = ownerBillTotal.plus(D(b.amount));
        else tenantBillTotal = tenantBillTotal.plus(D(b.amount));
        chargeToDetails.push({
          source: 'خدمة',
          description: `${b.service_name} (${b.bill_number})`,
          propertyName: b.property_name,
          unitNumber: b.unit_number,
          chargeTo: b.payer_role === 'OWNER' ? 'OWNER' : 'TENANT',
          amount: b.amount,
          paidAmount: b.paid_amount,
          date: b.period_end,
        });
      }
      let tenantCeTotal = new Decimal(0);
      let ownerCeTotal = new Decimal(0);
      for (const ce of ceChargeRows) {
        if (ce.charge_to === 'TENANT') tenantCeTotal = tenantCeTotal.plus(D(ce.amount));
        else ownerCeTotal = ownerCeTotal.plus(D(ce.amount));
        chargeToDetails.push({
          source: 'رسوم عقد',
          description: ce.name,
          propertyName: ce.property_name,
          unitNumber: ce.unit_number,
          chargeTo: ce.charge_to,
          amount: ce.amount,
          paidAmount: ce.paid_amount,
          date: ce.start_date,
        });
      }

      // FR-RPT-04: Property management commission from Property settings (never hardcoded 3%)
      const commissions = props.map((p) => {
        const rentCollectedRows = tenant.db
          .prepare(
            `SELECT amount FROM vouchers WHERE organization_id = ? AND property_id = ? AND voucher_type = 'RECEIPT' AND reference_type = 'INSTALLMENT' AND status = 'POSTED'`,
          )
          .all(tenant.organizationId, p.id) as Array<{ amount: string }>;
        const collected = rentCollectedRows.reduce((s, r) => s.plus(D(r.amount)), new Decimal(0));
        const commAmt = calculateManagementCommission({
          commissionType: p.commission_type as CommissionType,
          commissionValue: p.commission_value,
          collectedRentalRevenue: collected.toFixed(2),
        });
        return {
          propertyId: p.id,
          propertyName: p.name,
          commissionType: p.commission_type,
          commissionValue: p.commission_value,
          collectedRent: collected.toFixed(2),
          commissionAmount: commAmt,
        };
      });

      // FR-RPT-02: Overdue installments & expiring contracts
      const today = todayIso();
      const expiryHorizon = new Date(Date.now() + Number(org.contract_expiry_alert_days ?? 30) * 86400000)
        .toISOString()
        .slice(0, 10);

      const overdueInstallments = tenant.db
        .prepare(
          `SELECT i.*, u.unit_number, p.name AS property_name, pa.name AS tenant_name
           FROM installments i
           JOIN rent_agreements a ON a.id = i.agreement_id
           JOIN units u ON u.id = a.unit_id
           JOIN properties p ON p.id = a.property_id
           JOIN parties pa ON pa.id = a.tenant_party_id
           WHERE i.organization_id = ? AND a.status IN ('ACTIVE','NOTICE') AND i.status IN ('PENDING','PARTIAL') AND i.due_date < ?
           ORDER BY i.due_date ASC`,
        )
        .all(tenant.organizationId, today);

      const expiringContracts = tenant.db
        .prepare(
          `SELECT a.*, u.unit_number, p.name AS property_name, pa.name AS tenant_name
           FROM rent_agreements a
           JOIN units u ON u.id = a.unit_id
           JOIN properties p ON p.id = a.property_id
           JOIN parties pa ON pa.id = a.tenant_party_id
           WHERE a.organization_id = ? AND a.status = 'ACTIVE' AND a.end_date <= ?
           ORDER BY a.end_date ASC`,
        )
        .all(tenant.organizationId, expiryHorizon);

      const pendingMaintenance = maintChargeRows
        .filter((m) => m.status === 'OPEN' || m.status === 'IN_PROGRESS')
        .sort((a, b) => String(a.maintenance_date).localeCompare(String(b.maintenance_date)))
        .map((m) => ({
          id: m.id,
          maintenance_type: m.maintenance_type,
          description: m.description,
          property_name: m.property_name,
          unit_number: m.unit_number ?? null,
          status: m.status,
          maintenance_date: m.maintenance_date,
          cost: m.cost,
          charge_to: m.charge_to,
        }));

      const pendingMaintenanceRequests = tenant.db
        .prepare(
          `SELECT tmr.id, tmr.maintenance_type, tmr.description, tmr.created_at, tmr.status,
                  p.name AS property_name, u.unit_number, pa.name AS tenant_name
           FROM tenant_maintenance_requests tmr
           JOIN properties p ON p.id = tmr.property_id
           JOIN units u ON u.id = tmr.unit_id
           JOIN parties pa ON pa.id = tmr.tenant_party_id
           WHERE tmr.organization_id = ? AND tmr.status = 'PENDING'
           ORDER BY tmr.created_at DESC`,
        )
        .all(tenant.organizationId);

      // FR-RPT-05: Unified expenses (maintenance + guard salaries + collector rewards)
      const guardSalaries = props.reduce((s, p) => s.plus(D(p.guard_salary ?? 0)), new Decimal(0));
      const collectorRewardVouchers = tenant.db
        .prepare(
          `SELECT COALESCE(SUM(CAST(debit AS REAL)), 0) AS total FROM journal_lines WHERE organization_id = ? AND account_code = '5500'`,
        )
        .get(tenant.organizationId) as { total: number };

      // FR-RPT-06: Utility consumption by unit & property
      const utilityConsumption = tenant.db
        .prepare(
          `SELECT p.name AS property_name, u.unit_number, sd.name AS service_name, SUM(CAST(r.consumption AS REAL)) AS total_consumption
           FROM service_readings r
           JOIN service_meters m ON m.id = r.meter_id
           JOIN service_definitions sd ON sd.id = m.service_id
           JOIN properties p ON p.id = m.property_id
           LEFT JOIN units u ON u.id = m.unit_id
           WHERE r.organization_id = ?
           GROUP BY p.id, u.id, sd.id`,
        )
        .all(tenant.organizationId);

      const reconciliation = reconcileOrganization(tenant);

      res.json({
        today,
        occupancy: {
          totalUnits: units.length,
          rentalUnits: units.length - ownedCount,
          vacantCount,
          rentedCount,
          maintenanceCount: maintCount,
          ownedCount,
        },
        chargeToSummary: {
          onTenantTotal: tenantMaintTotal.plus(tenantBillTotal).plus(tenantCeTotal).toFixed(2),
          onOwnerTotal: ownerMaintTotal.plus(ownerBillTotal).plus(ownerCeTotal).toFixed(2),
          tenantMaintenance: tenantMaintTotal.toFixed(2),
          ownerMaintenance: ownerMaintTotal.toFixed(2),
          tenantServices: tenantBillTotal.toFixed(2),
          ownerServices: ownerBillTotal.toFixed(2),
          tenantContractExpenses: tenantCeTotal.toFixed(2),
          ownerContractExpenses: ownerCeTotal.toFixed(2),
        },
        chargeToDetails,
        commissions,
        overdueInstallments,
        expiringContracts,
        pendingMaintenance,
        pendingMaintenanceRequests,
        unifiedExpenses: {
          maintenanceTotal: tenantMaintTotal.plus(ownerMaintTotal).toFixed(2),
          monthlyGuardSalariesTotal: guardSalaries.toFixed(2),
          collectorRewardsPaid: toFixedMoney(collectorRewardVouchers.total),
        },
        utilityConsumption,
        reconciliation,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- DEDICATED PORTALS (FR-POR-01..05) — Always derive identity from session ---

  // 1. COLLECTOR PORTAL (FR-POR-03, FR-COL-04)
  router.get('/portal/collector', requireRole(Role.COLLECTOR), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const col = req.actor!.collector!;
      const propIds = col.assignedPropertyIds;
      if (propIds.length === 0) {
        return res.json({
          collector: col,
          cashbox: null,
          assignedProperties: [],
          dueInstallments: [],
          dueBills: [],
          dueMaintenance: [],
          meters: [],
          services: [],
          units: [],
        });
      }
      const placeholders = propIds.map(() => '?').join(',');
      const cashbox = tenant.db
        .prepare(`SELECT * FROM cashboxes WHERE id = ? AND organization_id = ?`)
        .get(col.cashboxId, tenant.organizationId);
      const mainCashbox = tenant.db
        .prepare(`SELECT id, name FROM cashboxes WHERE organization_id = ? AND cashbox_type = 'MAIN' LIMIT 1`)
        .get(tenant.organizationId);
      const assignedProperties = tenant.db
        .prepare(`SELECT * FROM properties WHERE organization_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`)
        .all(tenant.organizationId, ...propIds);
      const dueInstallments = col.flags.canCollectRent
        ? tenant.db
            .prepare(
              `SELECT i.*, u.unit_number, p.name AS property_name, pa.name AS tenant_name
               FROM installments i
               JOIN rent_agreements a ON a.id = i.agreement_id
               JOIN units u ON u.id = a.unit_id
               JOIN properties p ON p.id = a.property_id
               JOIN parties pa ON pa.id = a.tenant_party_id
               WHERE i.organization_id = ? AND a.property_id IN (${placeholders}) AND a.status IN ('ACTIVE','NOTICE') AND i.status IN ('PENDING','PARTIAL')
               ORDER BY i.due_date ASC`,
            )
            .all(tenant.organizationId, ...propIds)
        : [];
      const dueBills = col.flags.canCollectServices
        ? tenant.db
            .prepare(
              `SELECT b.*, sd.name AS service_name, u.unit_number, p.name AS property_name, pa.name AS payer_name
               FROM service_bills b
               JOIN service_definitions sd ON sd.id = b.service_id
               JOIN units u ON u.id = b.unit_id
               JOIN properties p ON p.id = b.property_id
               JOIN parties pa ON pa.id = b.payer_party_id
               WHERE b.organization_id = ? AND b.property_id IN (${placeholders}) AND b.status IN ('ISSUED','PARTIAL')
               ORDER BY b.due_date ASC`,
            )
            .all(tenant.organizationId, ...propIds)
        : [];
      const dueMaintenance = col.flags.canCollectMaintenance
        ? tenant.db
            .prepare(
              `SELECT m.*, u.unit_number, p.name AS property_name
               FROM maintenance_records m
               JOIN properties p ON p.id = m.property_id
               LEFT JOIN units u ON u.id = m.unit_id
               WHERE m.organization_id = ? AND m.property_id IN (${placeholders}) AND m.charge_to = 'TENANT' AND CAST(m.cost AS REAL) > CAST(m.paid_amount AS REAL)`,
            )
            .all(tenant.organizationId, ...propIds)
        : [];
      const meters = tenant.db
        .prepare(
          `SELECT m.*, sd.name AS service_name, p.name AS property_name, u.unit_number
           FROM service_meters m
           JOIN service_definitions sd ON sd.id = m.service_id
           JOIN properties p ON p.id = m.property_id
           LEFT JOIN units u ON u.id = m.unit_id
           WHERE m.organization_id = ? AND m.property_id IN (${placeholders})`,
        )
        .all(tenant.organizationId, ...propIds);
      const services = tenant.db
        .prepare(`SELECT * FROM service_definitions WHERE organization_id = ?`)
        .all(tenant.organizationId);
      const units = tenant.db
        .prepare(`SELECT id, property_id, unit_number FROM units WHERE organization_id = ? AND property_id IN (${placeholders}) AND deleted_at IS NULL`)
        .all(tenant.organizationId, ...propIds);

      const recentVouchers = tenant.db
        .prepare(
          `SELECT v.*, pa.name AS party_name, pr.name AS property_name
           FROM vouchers v
           LEFT JOIN parties pa ON pa.id = v.party_id
           LEFT JOIN properties pr ON pr.id = v.property_id
           WHERE v.organization_id = ? AND v.created_by_user_id = ?
           ORDER BY v.created_at DESC LIMIT 30`,
        )
        .all(tenant.organizationId, tenant.userId);

      res.json({
        collector: col,
        cashbox,
        mainCashbox,
        assignedProperties,
        dueInstallments,
        dueBills,
        dueMaintenance,
        meters,
        services,
        units,
        recentVouchers,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/portal/collector/collect', requireRole(Role.COLLECTOR), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const col = req.actor!.collector!;
      const { referenceType, referenceId, amount, voucherDate = todayIso() } = req.body ?? {};
      if (!referenceType || !referenceId || !amount) {
        throw new HttpError(400, 'بيانات التحصيل غير مكتملة');
      }

      // Verify Collector flag & assigned property scope on server
      let targetPropertyId: string | null = null;
      if (referenceType === VoucherReferenceType.INSTALLMENT) {
        if (!col.flags.canCollectRent) throw new HttpError(403, 'لا تملك صلاحية تحصيل الإيجار');
        const row = tenant.db
          .prepare(`SELECT a.property_id FROM installments i JOIN rent_agreements a ON a.id = i.agreement_id WHERE i.id = ? AND i.organization_id = ?`)
          .get(referenceId, tenant.organizationId) as { property_id: string } | undefined;
        targetPropertyId = row?.property_id ?? null;
      } else if (referenceType === VoucherReferenceType.SERVICE_BILL) {
        if (!col.flags.canCollectServices) throw new HttpError(403, 'لا تملك صلاحية تحصيل الخدمات');
        const row = tenant.db
          .prepare(`SELECT property_id FROM service_bills WHERE id = ? AND organization_id = ?`)
          .get(referenceId, tenant.organizationId) as { property_id: string } | undefined;
        targetPropertyId = row?.property_id ?? null;
      } else if (referenceType === VoucherReferenceType.MAINTENANCE) {
        if (!col.flags.canCollectMaintenance) throw new HttpError(403, 'لا تملك صلاحية تحصيل الصيانة');
        const row = tenant.db
          .prepare(`SELECT property_id FROM maintenance_records WHERE id = ? AND organization_id = ?`)
          .get(referenceId, tenant.organizationId) as { property_id: string } | undefined;
        targetPropertyId = row?.property_id ?? null;
      } else {
        throw new HttpError(403, 'نوع تحصيل غير مدعوم للمحصل');
      }

      if (!targetPropertyId || !col.assignedPropertyIds.includes(targetPropertyId)) {
        throw new HttpError(403, 'العقار غير مسند إلى هذا المحصل');
      }

      const result = tenant.runAtomic('COLLECTOR_COLLECT', req.headers['idempotency-key'] as string | undefined, () => {
        return createVoucherAtomic(tenant, {
          voucherType: VoucherType.RECEIPT,
          cashboxId: col.cashboxId,
          referenceType,
          referenceId,
          amount,
          voucherDate,
        });
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-COL-07: Collector handover to Main cashbox
  router.post('/portal/collector/handover', requireRole(Role.COLLECTOR), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const col = req.actor!.collector!;
      const { amount } = req.body ?? {};
      const mainCb = tenant.db
        .prepare(`SELECT id FROM cashboxes WHERE organization_id = ? AND cashbox_type = 'MAIN' LIMIT 1`)
        .get(tenant.organizationId) as { id: string } | undefined;
      if (!mainCb) throw new HttpError(400, 'الصندوق الرئيسي غير موجود');

      const result = tenant.runAtomic('COLLECTOR_HANDOVER', req.headers['idempotency-key'] as string | undefined, () => {
        return createVoucherAtomic(tenant, {
          voucherType: VoucherType.TRANSFER,
          cashboxId: col.cashboxId,
          targetCashboxId: mainCb.id,
          referenceType: VoucherReferenceType.CASHBOX_TRANSFER,
          referenceId: col.cashboxId,
          amount,
          description: 'تسليم عهدة المحصل إلى الصندوق الرئيسي',
        });
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/portal/collector/reading', requireRole(Role.COLLECTOR), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const col = req.actor!.collector!;
      const { meterId, periodStart, periodEnd, currentReading } = req.body ?? {};
      const meter = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM service_meters WHERE id = ? AND organization_id = ?`)
          .get(meterId, tenant.organizationId) as any,
        'العداد',
      );
      if (!col.assignedPropertyIds.includes(meter.property_id)) {
        throw new HttpError(403, 'هذا العداد يتبع لعقار غير مسند إليك');
      }
      if (meter.scope !== 'UNIT') {
        throw new HttpError(400, 'تسجيل قراءة العداد المشترك يتم من لوحة الإدارة');
      }

      const result = tenant.runAtomic('COLLECTOR_READING', undefined, () => {
        const svc = tenant.assertOwnedRow(
          tenant.db.prepare(`SELECT * FROM service_definitions WHERE id = ? AND organization_id = ?`).get(meter.service_id, tenant.organizationId) as any,
          'الخدمة',
        );
        const prevD = D(meter.last_reading);
        const currD = D(currentReading);
        if (currD.lt(prevD)) throw new HttpError(400, 'القراءة الحالية أقل من السابقة');
        const cons = currD.minus(prevD);
        const readingId = newId('rdg');
        tenant.db
          .prepare(
            `INSERT INTO service_readings (id, organization_id, meter_id, period_start, period_end, previous_reading, current_reading, consumption, recorded_by_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(readingId, tenant.organizationId, meter.id, periodStart, periodEnd, prevD.toFixed(2), currD.toFixed(2), cons.toFixed(2), tenant.userId, nowIso());
        tenant.db
          .prepare(`UPDATE service_meters SET last_reading = ?, last_reading_date = ? WHERE id = ? AND organization_id = ?`)
          .run(currD.toFixed(2), periodEnd, meter.id, tenant.organizationId);

        const totalAmt = cons.mul(D(svc.unit_price)).plus(D(svc.fixed_fee)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        const billId = issueUnitServiceBill(tenant, {
          serviceId: svc.id,
          serviceName: svc.name,
          propertyId: meter.property_id,
          unitId: meter.unit_id,
          readingId,
          periodStart,
          periodEnd,
          amount: totalAmt.toFixed(2),
          chargeTo: svc.default_charge_to as ChargeTo,
        });
        return { readingId, billId, amount: totalAmt.toFixed(2) };
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Collector creates service bill if permitted (canCreateServices flag)
  router.post('/portal/collector/create-service-bill', requireRole(Role.COLLECTOR), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const col = req.actor!.collector!;
      if (!col.flags.canCreateServices) {
        throw new HttpError(403, 'لا تملك صلاحية إنشاء فواتير خدمات');
      }
      const { serviceId, unitId, amount, periodStart = todayIso(), periodEnd = todayIso() } = req.body ?? {};
      const unit = tenant.assertOwnedRow(
        tenant.db.prepare(`SELECT * FROM units WHERE id = ? AND organization_id = ?`).get(unitId, tenant.organizationId) as any,
        'الوحدة',
      );
      if (!col.assignedPropertyIds.includes(unit.property_id)) {
        throw new HttpError(403, 'الوحدة خارج العقارات المسندة إليك');
      }
      const svc = tenant.assertOwnedRow(
        tenant.db.prepare(`SELECT * FROM service_definitions WHERE id = ? AND organization_id = ?`).get(serviceId, tenant.organizationId) as any,
        'الخدمة',
      );
      const billId = tenant.runAtomic('COLLECTOR_SVC_BILL', undefined, () => {
        return issueUnitServiceBill(tenant, {
          serviceId: svc.id,
          serviceName: svc.name,
          propertyId: unit.property_id,
          unitId: unit.id,
          readingId: null,
          periodStart,
          periodEnd,
          amount: toFixedMoney(amount),
          chargeTo: svc.default_charge_to as ChargeTo,
        });
      });
      res.status(201).json({ billId });
    } catch (err) {
      next(err);
    }
  });

  // 2. RENTER PORTAL (FR-POR-01)
  router.get('/portal/renter', requireRole(Role.RENTER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const partyId = req.actor!.partyId;
      if (!partyId) throw new HttpError(403, 'الحساب غير مرتبط بطرف مستأجر');

      const agreements = tenant.db
        .prepare(
          `SELECT a.*, u.unit_number, p.name AS property_name, p.address AS property_address, sd.held_balance AS deposit_held
           FROM rent_agreements a
           JOIN units u ON u.id = a.unit_id
           JOIN properties p ON p.id = a.property_id
           LEFT JOIN security_deposits sd ON sd.agreement_id = a.id
           WHERE a.organization_id = ? AND a.tenant_party_id = ?
           ORDER BY a.start_date DESC`,
        )
        .all(tenant.organizationId, partyId) as any[];

      const agIds = agreements.map((a) => a.id);
      const installments = agIds.length
        ? tenant.db
            .prepare(
              `SELECT * FROM installments WHERE organization_id = ? AND agreement_id IN (${agIds.map(() => '?').join(',')}) ORDER BY installment_number`,
            )
            .all(tenant.organizationId, ...agIds)
        : [];

      const bills = tenant.db
        .prepare(
          `SELECT b.*, sd.name AS service_name, u.unit_number
           FROM service_bills b
           JOIN service_definitions sd ON sd.id = b.service_id
           JOIN units u ON u.id = b.unit_id
           WHERE b.organization_id = ? AND b.payer_party_id = ?
           ORDER BY b.created_at DESC`,
        )
        .all(tenant.organizationId, partyId);

      const payments = tenant.db
        .prepare(
          `SELECT * FROM vouchers WHERE organization_id = ? AND party_id = ? AND status = 'POSTED' ORDER BY voucher_date DESC`,
        )
        .all(tenant.organizationId, partyId);

      const maintenance = agIds.length
        ? tenant.db
            .prepare(
              `SELECT * FROM maintenance_records WHERE organization_id = ? AND agreement_id IN (${agIds.map(() => '?').join(',')}) ORDER BY maintenance_date DESC`,
            )
            .all(tenant.organizationId, ...agIds)
        : [];

      const settlements = agIds.length
        ? tenant.db
            .prepare(
              `SELECT * FROM settlement_statements WHERE organization_id = ? AND agreement_id IN (${agIds.map(() => '?').join(',')}) AND status = 'POSTED'`,
            )
            .all(tenant.organizationId, ...agIds)
        : [];

      const entryPhotos = agIds.length
        ? tenant.db
            .prepare(
              `SELECT id, file_name, attachment_type, entity_id, created_at FROM attachments
               WHERE organization_id = ? AND attachment_type = 'ENTRY_PHOTO' AND entity_type = 'AGREEMENT' AND entity_id IN (${agIds.map(() => '?').join(',')})`,
            )
            .all(tenant.organizationId, ...agIds)
        : [];

      const maintenanceRequests = tenant.db
        .prepare(
          `SELECT tmr.*, p.name AS property_name, u.unit_number
           FROM tenant_maintenance_requests tmr
           JOIN properties p ON p.id = tmr.property_id
           JOIN units u ON u.id = tmr.unit_id
           WHERE tmr.organization_id = ? AND tmr.tenant_party_id = ?
           ORDER BY tmr.created_at DESC`,
        )
        .all(tenant.organizationId, partyId);

      const contractExpenses = tenant.db
        .prepare(
          `SELECT cei.*
           FROM contract_expense_items cei
           JOIN rent_agreements a ON a.id = cei.agreement_id
           WHERE cei.organization_id = ? AND a.tenant_party_id = ? AND cei.charge_to = 'TENANT'`,
        )
        .all(tenant.organizationId, partyId);

      const notifications = tenant.db
        .prepare(
          `SELECT n.*, nr.id AS recipient_id, nr.read_at
           FROM notification_recipients nr
           JOIN notifications n ON n.id = nr.notification_id
           WHERE nr.organization_id = ? AND nr.party_id = ?
           ORDER BY n.created_at DESC`,
        )
        .all(tenant.organizationId, partyId);

      res.json({
        agreements,
        installments,
        bills,
        payments,
        maintenance,
        maintenanceRequests,
        contractExpenses,
        settlements,
        entryPhotos,
        notifications,
      });
    } catch (err) {
      next(err);
    }
  });

  // FR-POR-02: Renter submits maintenance request (with optional photo attachment)
  router.post('/portal/renter/maintenance-requests', requireRole(Role.RENTER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const partyId = req.actor!.partyId;
      if (!partyId) throw new HttpError(403, 'الحساب غير مرتبط بطرف مستأجر');
      const { agreementId, maintenanceType, description, photo } = req.body ?? {};
      if (!agreementId || !maintenanceType || !description) {
        throw new HttpError(400, 'العقد ونوع الصيانة والوصف مطلوبة');
      }
      const ag = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ? AND tenant_party_id = ?`)
          .get(agreementId, tenant.organizationId, partyId) as any,
        'العقد',
      );
      if (!['ACTIVE', 'NOTICE'].includes(ag.status)) {
        throw new HttpError(400, 'يمكن تقديم طلبات الصيانة للعقود النشطة فقط');
      }
      const reqId = newId('tmr');
      tenant.db
        .prepare(
          `INSERT INTO tenant_maintenance_requests (id, organization_id, property_id, unit_id, agreement_id, tenant_party_id, maintenance_type, description, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
        )
        .run(reqId, tenant.organizationId, ag.property_id, ag.unit_id, ag.id, partyId, String(maintenanceType).trim(), String(description).trim(), nowIso());

      if (photo?.dataBase64 && photo?.fileName) {
        const cleanB64 = String(photo.dataBase64).replace(/^data:[^;]+;base64,/, '');
        const buf = Buffer.from(cleanB64, 'base64');
        if (buf.length <= 5 * 1024 * 1024) {
          tenant.db
            .prepare(
              `INSERT INTO attachments (id, organization_id, attachment_type, file_name, mime_type, size_bytes, data_base64, entity_type, entity_id, uploaded_by_user_id, created_at)
               VALUES (?, ?, 'BEFORE_PHOTO', ?, ?, ?, ?, 'MAINTENANCE_REQUEST', ?, ?, ?)`,
            )
            .run(newId('att'), tenant.organizationId, photo.fileName, photo.mimeType || 'image/png', buf.length, cleanB64, reqId, tenant.userId, nowIso());
        }
      }
      res.status(201).json({ requestId: reqId });
    } catch (err) {
      next(err);
    }
  });

  // 3. UNIT_OWNER PORTAL (FR-POR-04) — Only service bills & notifications, NO rental contracts
  router.get('/portal/unit-owner', requireRole(Role.UNIT_OWNER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const partyId = req.actor!.partyId;
      if (!partyId) throw new HttpError(403, 'الحساب غير مرتبط بمالك وحدة');

      const ownedUnits = tenant.db
        .prepare(
          `SELECT u.id, u.unit_number, u.unit_type, u.floor_number, u.area_sqm, p.name AS property_name, p.address AS property_address
           FROM units u
           JOIN properties p ON p.id = u.property_id
           WHERE u.organization_id = ? AND u.tenure_type = 'OWNED' AND u.unit_owner_party_id = ? AND u.deleted_at IS NULL`,
        )
        .all(tenant.organizationId, partyId);

      const bills = tenant.db
        .prepare(
          `SELECT b.*, sd.name AS service_name, u.unit_number, p.name AS property_name
           FROM service_bills b
           JOIN service_definitions sd ON sd.id = b.service_id
           JOIN units u ON u.id = b.unit_id
           JOIN properties p ON p.id = b.property_id
           WHERE b.organization_id = ? AND b.payer_party_id = ? AND b.payer_role = 'UNIT_OWNER'
           ORDER BY b.created_at DESC`,
        )
        .all(tenant.organizationId, partyId);

      const notifications = tenant.db
        .prepare(
          `SELECT n.*, nr.id AS recipient_id, nr.read_at
           FROM notification_recipients nr
           JOIN notifications n ON n.id = nr.notification_id
           WHERE nr.organization_id = ? AND nr.party_id = ?
           ORDER BY n.created_at DESC`,
        )
        .all(tenant.organizationId, partyId);

      res.json({ ownedUnits, bills, notifications });
    } catch (err) {
      next(err);
    }
  });

  // Mark notification as read (for RENTER / UNIT_OWNER)
  router.post('/portal/notifications/:recipientId/read', requireRole(Role.RENTER, Role.UNIT_OWNER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const rec = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM notification_recipients WHERE id = ? AND organization_id = ?`)
          .get(req.params.recipientId, tenant.organizationId) as any,
        'الإشعار',
      );
      if (rec.party_id !== req.actor!.partyId) {
        throw new HttpError(403, 'غير مصرح');
      }
      tenant.db
        .prepare(`UPDATE notification_recipients SET read_at = COALESCE(read_at, ?) WHERE id = ? AND organization_id = ?`)
        .run(nowIso(), rec.id, tenant.organizationId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
