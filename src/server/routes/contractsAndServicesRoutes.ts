import { Router } from 'express';
import Decimal from 'decimal.js';
import { D, toFixedMoney } from '../../domain/money';
import {
  addMonths,
  calculateTieredServiceCost,
  distributeSharedCost,
  generateInstallmentSchedule,
  renderContractTemplate,
  StateMachines,
} from '../../domain/rules';
import {
  ChargeTo,
  CollectionFrequency,
  DistributionMethod,
  InstallmentStatus,
  MeterScope,
  RentAgreementStatus,
  ServiceBillStatus,
  ServiceType,
} from '../../domain/types';
import { postJournalEntry, reverseJournalEntry } from '../accounting';
import { AuthenticatedRequest, getTenantDb, requireOrgPermission } from '../auth';
import { HttpError, newId, nowIso, todayIso } from '../db';
import { createAgreementWithSchedule, runDueInstallmentsAccrualJob } from '../domainService';

export function createContractsAndServicesRouter(): Router {
  const router = Router();

  // --- CONTRACTS & INSTALLMENTS (FR-CTR-01..10) ---

  router.get('/contracts', requireOrgPermission('contracts', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const agreements = tenant.db
        .prepare(
          `SELECT a.*, u.unit_number, p.name AS property_name, pa.name AS tenant_name, pa.phone AS tenant_phone,
             sd.id AS deposit_id, sd.expected_amount AS deposit_expected, sd.received_amount AS deposit_received, sd.held_balance AS deposit_held, sd.status AS deposit_status
           FROM rent_agreements a
           JOIN units u ON u.id = a.unit_id
           JOIN properties p ON p.id = a.property_id
           JOIN parties pa ON pa.id = a.tenant_party_id
           LEFT JOIN security_deposits sd ON sd.agreement_id = a.id
           WHERE a.organization_id = ?
           ORDER BY a.created_at DESC`,
        )
        .all(tenant.organizationId) as any[];

      const installments = tenant.db
        .prepare(
          `SELECT i.*, a.unit_id, u.unit_number, p.name AS property_name, pa.name AS tenant_name
           FROM installments i
           JOIN rent_agreements a ON a.id = i.agreement_id
           JOIN units u ON u.id = a.unit_id
           JOIN properties p ON p.id = a.property_id
           JOIN parties pa ON pa.id = a.tenant_party_id
           WHERE i.organization_id = ?
           ORDER BY i.due_date ASC, i.installment_number ASC`,
        )
        .all(tenant.organizationId);

      const expenseTypes = tenant.db
        .prepare(`SELECT * FROM contract_expense_types WHERE organization_id = ?`)
        .all(tenant.organizationId);

      const expenseItems = tenant.db
        .prepare(
          `SELECT cei.*, p.name AS property_name, u.unit_number, pa.name AS tenant_name
           FROM contract_expense_items cei
           JOIN rent_agreements a ON a.id = cei.agreement_id
           JOIN properties p ON p.id = a.property_id
           JOIN units u ON u.id = a.unit_id
           JOIN parties pa ON pa.id = a.tenant_party_id
           WHERE cei.organization_id = ?`,
        )
        .all(tenant.organizationId);

      const template = tenant.db
        .prepare(`SELECT * FROM contract_templates WHERE organization_id = ? AND is_default = 1 LIMIT 1`)
        .get(tenant.organizationId);

      res.json({ agreements, installments, expenseTypes, expenseItems, template });
    } catch (err) {
      next(err);
    }
  });

  // FR-CTR-04: Manage contract expense types
  router.post('/contracts/expense-types', requireOrgPermission('contracts', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { name, calcMode = 'FIXED', defaultValue = '0', defaultChargeTo = ChargeTo.TENANT, isMandatory = false, accountCode = '4400' } =
        req.body ?? {};
      if (!name) throw new HttpError(400, 'اسم نوع المصروف مطلوب');
      const id = newId('cet');
      tenant.db
        .prepare(
          `INSERT INTO contract_expense_types (id, organization_id, name, calc_mode, default_value, default_charge_to, is_mandatory, account_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, tenant.organizationId, String(name).trim(), calcMode, toFixedMoney(defaultValue), defaultChargeTo, isMandatory ? 1 : 0, accountCode);
      res.status(201).json({ id });
    } catch (err) {
      next(err);
    }
  });

  // FR-CTR-11: Update org contract print template & render agreement document
  router.put('/contracts/template', requireOrgPermission('contracts', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { name = 'قالب عقد الإيجار القياسي', bodyTemplate } = req.body ?? {};
      if (!bodyTemplate) throw new HttpError(400, 'نص القالب مطلوب');
      const existing = tenant.db
        .prepare(`SELECT id FROM contract_templates WHERE organization_id = ? AND is_default = 1 LIMIT 1`)
        .get(tenant.organizationId) as { id: string } | undefined;
      if (existing) {
        tenant.db
          .prepare(`UPDATE contract_templates SET name = ?, body_template = ?, updated_at = ? WHERE id = ?`)
          .run(name, bodyTemplate, nowIso(), existing.id);
      } else {
        tenant.db
          .prepare(`INSERT INTO contract_templates (id, organization_id, name, body_template, is_default, updated_at) VALUES (?, ?, ?, ?, 1, ?)`)
          .run(newId('ctpl'), tenant.organizationId, name, bodyTemplate, nowIso());
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/contracts/:id/document', requireOrgPermission('contracts', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const org = tenant.getOrg();
      const ag = tenant.assertOwnedRow(
        tenant.db
          .prepare(
            `SELECT a.*, u.unit_number, u.unit_type, u.area_sqm, p.name AS property_name, p.address AS property_address,
                    pa.name AS tenant_name, pa.national_id AS tenant_national_id, pa.phone AS tenant_phone
             FROM rent_agreements a
             JOIN units u ON u.id = a.unit_id
             JOIN properties p ON p.id = a.property_id
             JOIN parties pa ON pa.id = a.tenant_party_id
             WHERE a.id = ? AND a.organization_id = ?`,
          )
          .get(req.params.id, tenant.organizationId) as any,
        'العقد',
      );
      const tpl = tenant.db
        .prepare(`SELECT * FROM contract_templates WHERE organization_id = ? AND is_default = 1 LIMIT 1`)
        .get(tenant.organizationId) as any;

      const netTotal = D(ag.total_amount).minus(ag.discount_amount ?? 0).toFixed(2);
      const freqLabels: Record<string, string> = {
        MONTHLY: 'شهري',
        QUARTERLY: 'ربع سنوي',
        SEMI_ANNUAL: 'نصف سنوي',
        ANNUAL: 'سنوي',
        CUSTOM: 'مخصص',
      };
      const renderedText = renderContractTemplate(tpl?.body_template || 'عقد إيجار وحدة {{unitNumber}} للمستأجر {{tenantName}}', {
        orgName: org.name,
        createdDate: ag.created_at.slice(0, 10),
        propertyName: ag.property_name,
        propertyAddress: ag.property_address,
        unitNumber: ag.unit_number,
        unitType: ag.unit_type,
        areaSqm: ag.area_sqm,
        tenantName: ag.tenant_name,
        tenantNationalId: ag.tenant_national_id,
        tenantPhone: ag.tenant_phone,
        startDate: ag.start_date,
        endDate: ag.end_date,
        totalAmount: `${ag.total_amount} ${org.base_currency}`,
        discountAmount: `${ag.discount_amount} ${org.base_currency}`,
        netTotal: `${netTotal} ${org.base_currency}`,
        frequencyLabel: freqLabels[ag.frequency] || ag.frequency,
        depositAmount: `${ag.deposit_amount} ${org.base_currency}`,
        graceDays: ag.grace_days,
      });

      const installments = tenant.db
        .prepare(`SELECT * FROM installments WHERE agreement_id = ? AND organization_id = ? ORDER BY installment_number`)
        .all(ag.id, tenant.organizationId);
      const expenseItems = tenant.db
        .prepare(`SELECT * FROM contract_expense_items WHERE agreement_id = ? AND organization_id = ?`)
        .all(ag.id, tenant.organizationId);

      res.json({ agreement: ag, renderedText, installments, expenseItems, orgName: org.name, currency: org.base_currency });
    } catch (err) {
      next(err);
    }
  });

  router.post('/contracts', requireOrgPermission('contracts', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const idemKey = req.headers['idempotency-key'] as string | undefined;
      const result = tenant.runAtomic('POST_CONTRACT', idemKey, () => {
        return createAgreementWithSchedule(tenant, req.body);
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-CTR-08: Renew contract (creates new linked contract, never modifies old)
  router.post('/contracts/:id/renew', requireOrgPermission('contracts', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const result = tenant.runAtomic('RENEW_CONTRACT', undefined, () => {
        const oldAg = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ?`)
            .get(req.params.id, tenant.organizationId) as any,
          'العقد',
        );
        const {
          startDate,
          endDate,
          totalAmount,
          discountAmount = '0',
          frequency = oldAg.frequency,
          depositAmount = '0',
        } = req.body ?? {};
        if (!startDate || !endDate || !totalAmount) {
          throw new HttpError(400, 'تاريخ البداية والنهاية والإجمالي مطلوبة للتجديد');
        }
        return createAgreementWithSchedule(tenant, {
          unitId: oldAg.unit_id,
          tenantPartyId: oldAg.tenant_party_id,
          startDate,
          endDate,
          totalAmount,
          discountAmount,
          frequency,
          depositAmount,
          renewedFromId: oldAg.id,
          notes: `تجديد للعقد السابق`,
        });
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-CTR-09: Amend active contract (leaves posted/accrued/paid installments untouched)
  router.post('/contracts/:id/amend', requireOrgPermission('contracts', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { newRemainingTotal, reason } = req.body ?? {};
      if (!newRemainingTotal || !reason) {
        throw new HttpError(400, 'المبلغ المتبقي الجديد والسبب مطلوبان للتعديل');
      }
      const result = tenant.runAtomic('AMEND_CONTRACT', undefined, () => {
        const ag = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ?`)
            .get(req.params.id, tenant.organizationId) as any,
          'العقد',
        );
        if (ag.status !== RentAgreementStatus.ACTIVE) {
          throw new HttpError(400, 'يمكن تعديل العقود النشطة فقط');
        }

        const unposted = tenant.db
          .prepare(
            `SELECT * FROM installments
             WHERE agreement_id = ? AND organization_id = ? AND accrual_journal_id IS NULL AND paid_amount = '0.00' AND status = 'PENDING'
             ORDER BY installment_number ASC`,
          )
          .all(ag.id, tenant.organizationId) as any[];

        if (unposted.length === 0) {
          throw new HttpError(400, 'لا توجد أقساط غير مرحّلة لتعديلها');
        }

        const startPeriod = unposted[0].period_start;
        const endPeriod = unposted[unposted.length - 1].period_end;
        const newSchedule = generateInstallmentSchedule({
          startDate: startPeriod,
          endDate: endPeriod,
          totalAmount: String(newRemainingTotal),
          frequency: CollectionFrequency.CUSTOM,
          customCount: unposted.length,
          roundingStep: tenant.getOrg().rounding_step,
        });

        for (let i = 0; i < unposted.length; i++) {
          tenant.db
            .prepare(`UPDATE installments SET amount = ? WHERE id = ? AND organization_id = ?`)
            .run(newSchedule[i].amount, unposted[i].id, tenant.organizationId);
        }

        tenant.audit({
          entityType: 'RentAgreement',
          entityId: ag.id,
          action: 'AMEND',
          newValue: { newRemainingTotal, reason, updatedInstallments: unposted.length },
        });
        return { updatedInstallments: unposted.length };
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-EVC-09: Direct contract cancellation ONLY when zero financial movements exist
  router.post('/contracts/:id/cancel', requireOrgPermission('contracts', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const ag = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ?`)
          .get(req.params.id, tenant.organizationId) as any,
        'العقد',
      );
      StateMachines.agreement(ag.status as RentAgreementStatus, RentAgreementStatus.CANCELED);

      const hasFinance =
        tenant.db
          .prepare(
            `SELECT id FROM installments WHERE agreement_id = ? AND organization_id = ? AND (accrual_journal_id IS NOT NULL OR CAST(paid_amount AS REAL) > 0) LIMIT 1`,
          )
          .get(ag.id, tenant.organizationId) ||
        tenant.db
          .prepare(
            `SELECT id FROM security_deposits WHERE agreement_id = ? AND organization_id = ? AND CAST(received_amount AS REAL) > 0 LIMIT 1`,
          )
          .get(ag.id, tenant.organizationId) ||
        tenant.db
          .prepare(
            `SELECT id FROM contract_expense_items WHERE agreement_id = ? AND organization_id = ? AND CAST(paid_amount AS REAL) > 0 LIMIT 1`,
          )
          .get(ag.id, tenant.organizationId);

      if (hasFinance) {
        throw new HttpError(409, 'لا يمكن الإلغاء المباشر لعقد عليه حركات مالية؛ يجب إنهاؤه عبر طلب إخلاء');
      }

      tenant.db
        .prepare(`UPDATE installments SET status = 'WAIVED' WHERE agreement_id = ? AND organization_id = ?`)
        .run(ag.id, tenant.organizationId);
      tenant.db
        .prepare(`UPDATE rent_agreements SET status = 'CANCELED' WHERE id = ? AND organization_id = ?`)
        .run(ag.id, tenant.organizationId);

      tenant.audit({
        entityType: 'RentAgreement',
        entityId: ag.id,
        action: 'DIRECT_CANCEL',
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // FR-ACC-05: Trigger daily due installments accrual job
  router.post('/contracts/accrue-due', requireOrgPermission('accounting', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const asOfDate = req.body?.asOfDate ?? todayIso();
      const result = runDueInstallmentsAccrualJob(tenant, asOfDate);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // --- SERVICES, METERS, READINGS, BILLS & SHARED COSTS (FR-SVC-01..08) ---

  router.get('/services', requireOrgPermission('services', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const definitions = tenant.db
        .prepare(`SELECT * FROM service_definitions WHERE organization_id = ? ORDER BY created_at DESC`)
        .all(tenant.organizationId) as any[];

      for (const def of definitions) {
        def.tiers = tenant.db
          .prepare(`SELECT id, tier_order, from_qty AS fromQty, to_qty AS toQty, unit_price AS unitPrice FROM service_tariff_tiers WHERE service_id = ? AND organization_id = ? ORDER BY tier_order ASC`)
          .all(def.id, tenant.organizationId);
      }

      const meters = tenant.db
        .prepare(
          `SELECT m.*, sd.name AS service_name, sd.service_type, sd.unit_price, sd.fixed_fee, p.name AS property_name, u.unit_number
           FROM service_meters m
           JOIN service_definitions sd ON sd.id = m.service_id
           JOIN properties p ON p.id = m.property_id
           LEFT JOIN units u ON u.id = m.unit_id
           WHERE m.organization_id = ?
           ORDER BY p.name, u.unit_number`,
        )
        .all(tenant.organizationId);

      const readings = tenant.db
        .prepare(
          `SELECT r.*, m.meter_number, sd.name AS service_name, p.name AS property_name, u.unit_number
           FROM service_readings r
           JOIN service_meters m ON m.id = r.meter_id
           JOIN service_definitions sd ON sd.id = m.service_id
           JOIN properties p ON p.id = m.property_id
           LEFT JOIN units u ON u.id = m.unit_id
           WHERE r.organization_id = ?
           ORDER BY r.period_end DESC, r.created_at DESC LIMIT 100`,
        )
        .all(tenant.organizationId);

      const bills = tenant.db
        .prepare(
          `SELECT b.*, sd.name AS service_name, p.name AS property_name, u.unit_number, pa.name AS payer_name
           FROM service_bills b
           JOIN service_definitions sd ON sd.id = b.service_id
           JOIN properties p ON p.id = b.property_id
           JOIN units u ON u.id = b.unit_id
           JOIN parties pa ON pa.id = b.payer_party_id
           WHERE b.organization_id = ?
           ORDER BY b.created_at DESC`,
        )
        .all(tenant.organizationId);

      const policies = tenant.db
        .prepare(
          `SELECT sp.*, p.name AS property_name, sd.name AS service_name
           FROM shared_cost_policies sp
           JOIN properties p ON p.id = sp.property_id
           JOIN service_definitions sd ON sd.id = sp.service_id
           WHERE sp.organization_id = ? ORDER BY sp.created_at DESC`,
        )
        .all(tenant.organizationId);

      const recurring = tenant.db
        .prepare(
          `SELECT rc.*, sd.name AS service_name, p.name AS property_name, u.unit_number
           FROM recurring_service_contracts rc
           JOIN service_definitions sd ON sd.id = rc.service_id
           JOIN properties p ON p.id = rc.property_id
           JOIN units u ON u.id = rc.unit_id
           WHERE rc.organization_id = ? ORDER BY rc.created_at DESC`,
        )
        .all(tenant.organizationId);

      res.json({ definitions, meters, readings, bills, policies, recurring });
    } catch (err) {
      next(err);
    }
  });

  router.post('/services/definitions', requireOrgPermission('services', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { code, name, serviceType, unitPrice = '0', fixedFee = '0', frequency = 'MONTHLY', defaultChargeTo = ChargeTo.TENANT, tiers = [] } =
        req.body ?? {};
      if (!code || !name || !serviceType) {
        throw new HttpError(400, 'الرمز والاسم ونوع الخدمة مطلوبة');
      }
      const dup = tenant.db
        .prepare(`SELECT id FROM service_definitions WHERE organization_id = ? AND code = ?`)
        .get(tenant.organizationId, String(code).trim().toUpperCase());
      if (dup) throw new HttpError(409, 'رمز الخدمة مستخدم مسبقاً في المنشأة');

      const id = newId('svc');
      tenant.db
        .prepare(
          `INSERT INTO service_definitions (id, organization_id, code, name, service_type, unit_price, fixed_fee, frequency, default_charge_to, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          tenant.organizationId,
          String(code).trim().toUpperCase(),
          String(name).trim(),
          serviceType === ServiceType.FIXED ? ServiceType.FIXED : ServiceType.METERED,
          toFixedMoney(unitPrice),
          toFixedMoney(fixedFee),
          frequency,
          defaultChargeTo,
          nowIso(),
        );

      if (Array.isArray(tiers) && tiers.length > 0) {
        const insTier = tenant.db.prepare(
          `INSERT INTO service_tariff_tiers (id, organization_id, service_id, tier_order, from_qty, to_qty, unit_price)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        tiers.forEach((t: any, idx: number) => {
          insTier.run(
            newId('stt'),
            tenant.organizationId,
            id,
            idx + 1,
            toFixedMoney(t.fromQty ?? '0'),
            t.toQty !== null && t.toQty !== '' && t.toQty !== undefined ? toFixedMoney(t.toQty) : null,
            toFixedMoney(t.unitPrice ?? '0'),
          );
        });
      }

      res.status(201).json({ id });
    } catch (err) {
      next(err);
    }
  });

  // Update service definition + tariff tiers (FR-SVC-01 & FR-SVC-10)
  router.patch('/services/definitions/:id', requireOrgPermission('services', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const svc = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM service_definitions WHERE id = ? AND organization_id = ?`)
          .get(req.params.id, tenant.organizationId) as any,
        'تعريف الخدمة',
      );
      const { name, unitPrice, fixedFee, frequency, defaultChargeTo, tiers } = req.body ?? {};
      tenant.db
        .prepare(
          `UPDATE service_definitions SET
             name = COALESCE(?, name),
             unit_price = COALESCE(?, unit_price),
             fixed_fee = COALESCE(?, fixed_fee),
             frequency = COALESCE(?, frequency),
             default_charge_to = COALESCE(?, default_charge_to)
           WHERE id = ? AND organization_id = ?`,
        )
        .run(
          name ?? null,
          unitPrice !== undefined ? toFixedMoney(unitPrice) : null,
          fixedFee !== undefined ? toFixedMoney(fixedFee) : null,
          frequency ?? null,
          defaultChargeTo ?? null,
          svc.id,
          tenant.organizationId,
        );

      if (Array.isArray(tiers)) {
        tenant.db
          .prepare(`DELETE FROM service_tariff_tiers WHERE service_id = ? AND organization_id = ?`)
          .run(svc.id, tenant.organizationId);
        const insTier = tenant.db.prepare(
          `INSERT INTO service_tariff_tiers (id, organization_id, service_id, tier_order, from_qty, to_qty, unit_price)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        tiers.forEach((t: any, idx: number) => {
          insTier.run(
            newId('stt'),
            tenant.organizationId,
            svc.id,
            idx + 1,
            toFixedMoney(t.fromQty ?? '0'),
            t.toQty !== null && t.toQty !== '' && t.toQty !== undefined ? toFixedMoney(t.toQty) : null,
            toFixedMoney(t.unitPrice ?? '0'),
          );
        });
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/services/meters', requireOrgPermission('services', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { serviceId, scope, propertyId, unitId, meterNumber, initialReading = '0' } = req.body ?? {};
      if (!serviceId || !scope || !propertyId || !meterNumber) {
        throw new HttpError(400, 'جميع بيانات العداد مطلوبة');
      }
      tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM service_definitions WHERE id = ? AND organization_id = ?`)
          .get(serviceId, tenant.organizationId) as any,
        'الخدمة',
      );
      tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM properties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
          .get(propertyId, tenant.organizationId) as any,
        'العقار',
      );
      if (scope === MeterScope.UNIT) {
        if (!unitId) throw new HttpError(400, 'عداد الوحدة يتطلب تحديد الوحدة');
        tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM units WHERE id = ? AND property_id = ? AND organization_id = ? AND deleted_at IS NULL`)
            .get(unitId, propertyId, tenant.organizationId) as any,
          'الوحدة',
        );
      }

      const id = newId('mtr');
      tenant.db
        .prepare(
          `INSERT INTO service_meters (id, organization_id, service_id, scope, property_id, unit_id, meter_number, last_reading, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          tenant.organizationId,
          serviceId,
          scope,
          propertyId,
          scope === MeterScope.UNIT ? unitId : null,
          String(meterNumber).trim(),
          toFixedMoney(initialReading),
          nowIso(),
        );
      res.status(201).json({ id });
    } catch (err) {
      next(err);
    }
  });

  // FR-SVC-03, FR-SVC-04, FR-SVC-05: Record Reading & Issue Bill (Unit or Shared Property Meter)
  router.post('/services/readings', requireOrgPermission('services', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const {
        meterId,
        periodStart,
        periodEnd,
        currentReading,
        isReset = false,
        resetNote,
        chargeToOverride,
        distributionMethod = DistributionMethod.EQUAL,
        includeOwnedUnits = true,
      } = req.body ?? {};

      if (!meterId || !periodStart || !periodEnd || currentReading === undefined) {
        throw new HttpError(400, 'العداد والفترة والقراءة الحالية مطلوبة');
      }
      if (periodEnd < periodStart) {
        throw new HttpError(400, 'تاريخ نهاية الفترة يجب أن يكون بعد البداية');
      }

      const result = tenant.runAtomic('POST_READING', undefined, () => {
        const meter = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM service_meters WHERE id = ? AND organization_id = ?`)
            .get(meterId, tenant.organizationId) as any,
          'العداد',
        );
        const svc = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM service_definitions WHERE id = ? AND organization_id = ?`)
            .get(meter.service_id, tenant.organizationId) as any,
          'الخدمة',
        );

        // No overlapping reading periods
        const overlap = tenant.db
          .prepare(
            `SELECT id FROM service_readings
             WHERE organization_id = ? AND meter_id = ? AND NOT (period_end < ? OR period_start > ?)`,
          )
          .get(tenant.organizationId, meter.id, periodStart, periodEnd);
        if (overlap) {
          throw new HttpError(409, 'توجد قراءة متداخلة لهذا العداد في نفس الفترة');
        }

        const prevD = D(meter.last_reading);
        const currD = D(currentReading);
        if (!isReset && currD.lt(prevD)) {
          throw new HttpError(400, `القراءة الحالية (${currD.toFixed(2)}) أقل من السابقة (${prevD.toFixed(2)})؛ فعّل خيار إعادة ضبط العداد مع توثيق السبب`);
        }
        if (isReset && !resetNote) {
          throw new HttpError(400, 'إعادة ضبط العداد تتطلب كتابة السبب');
        }

        const consumption = isReset ? currD : currD.minus(prevD);
        const readingId = newId('rdg');
        tenant.db
          .prepare(
            `INSERT INTO service_readings (id, organization_id, meter_id, period_start, period_end, previous_reading, current_reading, consumption, is_reset, reset_note, recorded_by_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            readingId,
            tenant.organizationId,
            meter.id,
            periodStart,
            periodEnd,
            prevD.toFixed(2),
            currD.toFixed(2),
            consumption.toFixed(2),
            isReset ? 1 : 0,
            resetNote ?? null,
            tenant.userId,
            nowIso(),
          );

        tenant.db
          .prepare(`UPDATE service_meters SET last_reading = ?, last_reading_date = ? WHERE id = ? AND organization_id = ?`)
          .run(currD.toFixed(2), periodEnd, meter.id, tenant.organizationId);

        const svcTiers = tenant.db
          .prepare(
            `SELECT from_qty AS fromQty, to_qty AS toQty, unit_price AS unitPrice
             FROM service_tariff_tiers WHERE service_id = ? AND organization_id = ? ORDER BY tier_order ASC`,
          )
          .all(svc.id, tenant.organizationId) as any[];

        const costCalc = calculateTieredServiceCost({
          consumption: consumption.toFixed(2),
          fixedFee: svc.fixed_fee,
          defaultUnitPrice: svc.unit_price,
          tiers: svcTiers,
        });
        const totalBillAmt = D(costCalc.totalAmount);
        const effectiveChargeTo = (chargeToOverride ?? svc.default_charge_to) as ChargeTo;
        const issuedBillIds: string[] = [];

        if (meter.scope === MeterScope.UNIT) {
          const billId = issueUnitServiceBill(tenant, {
            serviceId: svc.id,
            serviceName: svc.name,
            propertyId: meter.property_id,
            unitId: meter.unit_id,
            readingId,
            periodStart,
            periodEnd,
            amount: totalBillAmt.toFixed(2),
            chargeTo: effectiveChargeTo,
          });
          issuedBillIds.push(billId);
        } else {
          // FR-SVC-05 & BR-07: Shared meter distributed across property units
          const units = tenant.db
            .prepare(
              `SELECT * FROM units WHERE property_id = ? AND organization_id = ? AND deleted_at IS NULL
               ${includeOwnedUnits ? '' : "AND tenure_type != 'OWNED'"}`,
            )
            .all(meter.property_id, tenant.organizationId) as any[];

          const activeUnits = units.filter((u) => {
            if (u.tenure_type === 'OWNED') return Boolean(u.unit_owner_party_id);
            const ag = tenant.db
              .prepare(
                `SELECT id FROM rent_agreements WHERE organization_id = ? AND unit_id = ? AND status IN ('ACTIVE', 'NOTICE')
                 AND start_date <= ? AND end_date >= ?`,
              )
              .get(tenant.organizationId, u.id, periodEnd, periodStart);
            return Boolean(ag) || effectiveChargeTo === ChargeTo.OWNER;
          });

          if (activeUnits.length === 0) {
            throw new HttpError(400, 'لا توجد وحدات مشاركة صالحة (بها مستأجر أو مالك وحدة) لتوزيع الفاتورة المشتركة');
          }

          // Real unit consumption lookup for CONSUMPTION method
          const unitInputs = activeUnits.map((u) => {
            const consRow = tenant.db
              .prepare(
                `SELECT COALESCE(SUM(CAST(r.consumption AS REAL)), 0) AS total
                 FROM service_readings r
                 JOIN service_meters um ON um.id = r.meter_id
                 WHERE r.organization_id = ? AND um.unit_id = ? AND NOT (r.period_end < ? OR r.period_start > ?)`,
              )
              .get(tenant.organizationId, u.id, periodStart, periodEnd) as { total: number };
            return {
              unitId: u.id,
              areaSqm: u.area_sqm,
              consumption: consRow?.total ?? 0,
            };
          });

          const shares = distributeSharedCost({
            totalCost: totalBillAmt.toFixed(2),
            method: distributionMethod,
            units: unitInputs,
          });

          for (const sh of shares) {
            if (D(sh.amount).lte(0)) continue;
            const billId = issueUnitServiceBill(tenant, {
              serviceId: svc.id,
              serviceName: `${svc.name} (مشترك)`,
              propertyId: meter.property_id,
              unitId: sh.unitId,
              readingId,
              periodStart,
              periodEnd,
              amount: sh.amount,
              chargeTo: effectiveChargeTo === ChargeTo.SHARED ? ChargeTo.TENANT : effectiveChargeTo,
            });
            issuedBillIds.push(billId);
          }
        }

        return { readingId, consumption: consumption.toFixed(2), totalAmount: totalBillAmt.toFixed(2), issuedBillIds };
      });

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-SVC-06: Shared cost policy & manual shared expense distribution
  router.post('/services/shared-distribute', requireOrgPermission('services', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { propertyId, serviceId, totalCost, method = DistributionMethod.EQUAL, includeOwnedUnits = true, excludedUnitIds = [], periodStart, periodEnd } =
        req.body ?? {};
      if (!propertyId || !serviceId || !totalCost || !periodStart || !periodEnd) {
        throw new HttpError(400, 'بيانات التوزيع المشترك غير مكتملة');
      }

      const result = tenant.runAtomic('SHARED_DISTRIBUTE', undefined, () => {
        const svc = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM service_definitions WHERE id = ? AND organization_id = ?`)
            .get(serviceId, tenant.organizationId) as any,
          'الخدمة',
        );
        const units = tenant.db
          .prepare(`SELECT * FROM units WHERE property_id = ? AND organization_id = ? AND deleted_at IS NULL`)
          .all(propertyId, tenant.organizationId) as any[];

        const excluded = new Set<string>(Array.isArray(excludedUnitIds) ? excludedUnitIds : []);
        const eligible = units.filter((u) => {
          if (excluded.has(u.id)) return false;
          if (u.tenure_type === 'OWNED' && !includeOwnedUnits) return false;
          return true;
        });

        if (eligible.length === 0) {
          throw new HttpError(400, 'لا توجد وحدات مشاركة بعد الاستثناءات');
        }

        const unitInputs = eligible.map((u) => {
          const consRow = tenant.db
            .prepare(
              `SELECT COALESCE(SUM(CAST(r.consumption AS REAL)), 0) AS total
               FROM service_readings r
               JOIN service_meters um ON um.id = r.meter_id
               WHERE r.organization_id = ? AND um.unit_id = ? AND NOT (r.period_end < ? OR r.period_start > ?)`,
            )
            .get(tenant.organizationId, u.id, periodStart, periodEnd) as { total: number };
          return {
            unitId: u.id,
            areaSqm: u.area_sqm,
            consumption: consRow?.total ?? 0,
          };
        });

        const shares = distributeSharedCost({
          totalCost,
          method,
          units: unitInputs,
        });

        const policyId = newId('scp');
        tenant.db
          .prepare(
            `INSERT INTO shared_cost_policies (id, organization_id, property_id, service_id, method, include_owned_units, excluded_unit_ids_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            policyId,
            tenant.organizationId,
            propertyId,
            serviceId,
            method,
            includeOwnedUnits ? 1 : 0,
            JSON.stringify([...excluded]),
            nowIso(),
          );

        const billIds: string[] = [];
        for (const sh of shares) {
          if (D(sh.amount).lte(0)) continue;
          const bId = issueUnitServiceBill(tenant, {
            serviceId: svc.id,
            serviceName: `${svc.name} (توزيع مشترك)`,
            propertyId,
            unitId: sh.unitId,
            readingId: null,
            periodStart,
            periodEnd,
            amount: sh.amount,
            chargeTo: ChargeTo.TENANT,
          });
          billIds.push(bId);
        }

        return { policyId, billIds };
      });

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Void an uncollected ISSUED service bill (Sec 6.1)
  router.post('/services/bills/:id/void', requireOrgPermission('services', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { reason = 'إلغاء فاتورة خدمة' } = req.body ?? {};
      const result = tenant.runAtomic('VOID_SERVICE_BILL', undefined, () => {
        const bill = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM service_bills WHERE id = ? AND organization_id = ?`)
            .get(req.params.id, tenant.organizationId) as any,
          'فاتورة الخدمة',
        );
        StateMachines.serviceBill(bill.status as ServiceBillStatus, ServiceBillStatus.VOID);
        if (D(bill.paid_amount).gt(0)) {
          throw new HttpError(400, 'لا يمكن إلغاء فاتورة خدمة مسدّدة جزئياً أو كلياً؛ اعكس السند أولاً');
        }
        if (bill.journal_entry_id) {
          reverseJournalEntry(tenant, bill.journal_entry_id, todayIso(), String(reason), 'SERVICE_BILL_VOID', bill.id);
        }
        tenant.db
          .prepare(`UPDATE service_bills SET status = 'VOID' WHERE id = ? AND organization_id = ?`)
          .run(bill.id, tenant.organizationId);
        tenant.audit({
          entityType: 'ServiceBill',
          entityId: bill.id,
          action: 'VOID',
          oldValue: { status: bill.status },
          newValue: { status: 'VOID', reason },
        });
        return { ok: true };
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-SVC-08: Create recurring service contract & generate next bill
  router.post('/services/recurring', requireOrgPermission('services', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { serviceId, unitId, amount, chargeTo = ChargeTo.TENANT, frequency = 'MONTHLY', startDate = todayIso() } =
        req.body ?? {};
      if (!serviceId || !unitId || !amount) {
        throw new HttpError(400, 'الخدمة والوحدة والمبلغ مطلوبة');
      }

      const result = tenant.runAtomic('CREATE_RECURRING_SVC', undefined, () => {
        const unit = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM units WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
            .get(unitId, tenant.organizationId) as any,
          'الوحدة',
        );
        const svc = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM service_definitions WHERE id = ? AND organization_id = ?`)
            .get(serviceId, tenant.organizationId) as any,
          'الخدمة',
        );

        const recId = newId('rsc');
        const nextDate = addMonths(startDate, frequency === 'QUARTERLY' ? 3 : 1);
        tenant.db
          .prepare(
            `INSERT INTO recurring_service_contracts (id, organization_id, service_id, property_id, unit_id, amount, charge_to, frequency, next_bill_date, is_active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          )
          .run(recId, tenant.organizationId, svc.id, unit.property_id, unit.id, toFixedMoney(amount), chargeTo, frequency, nextDate, nowIso());

        const billId = issueUnitServiceBill(tenant, {
          serviceId: svc.id,
          serviceName: svc.name,
          propertyId: unit.property_id,
          unitId: unit.id,
          readingId: null,
          periodStart: startDate,
          periodEnd: nextDate,
          amount: toFixedMoney(amount),
          chargeTo,
        });

        return { recurringId: recId, initialBillId: billId };
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Toggle active flag on recurring service contract
  router.patch('/services/recurring/:id', requireOrgPermission('services', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const rc = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM recurring_service_contracts WHERE id = ? AND organization_id = ?`)
          .get(req.params.id, tenant.organizationId) as any,
        'عقد الخدمة المتكرر',
      );
      const isActive = req.body?.isActive !== undefined ? Boolean(req.body.isActive) : !Boolean(rc.is_active);
      tenant.db
        .prepare(`UPDATE recurring_service_contracts SET is_active = ? WHERE id = ? AND organization_id = ?`)
        .run(isActive ? 1 : 0, rc.id, tenant.organizationId);
      res.json({ ok: true, isActive });
    } catch (err) {
      next(err);
    }
  });

  // Generate due bills from active recurring service contracts (idempotent by next_bill_date)
  router.post('/services/recurring/generate-due', requireOrgPermission('services', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const asOfDate = req.body?.asOfDate ?? todayIso();
      const result = tenant.runAtomic('GEN_DUE_RECURRING_SVC', undefined, () => {
        const dueContracts = tenant.db
          .prepare(
            `SELECT rc.*, sd.name AS service_name
             FROM recurring_service_contracts rc
             JOIN service_definitions sd ON sd.id = rc.service_id
             WHERE rc.organization_id = ? AND rc.is_active = 1 AND rc.next_bill_date <= ?`,
          )
          .all(tenant.organizationId, asOfDate) as any[];
        let generatedCount = 0;
        for (const rc of dueContracts) {
          const nextDate = addMonths(rc.next_bill_date, rc.frequency === 'QUARTERLY' ? 3 : 1);
          issueUnitServiceBill(tenant, {
            serviceId: rc.service_id,
            serviceName: rc.service_name,
            propertyId: rc.property_id,
            unitId: rc.unit_id,
            readingId: null,
            periodStart: rc.next_bill_date,
            periodEnd: nextDate,
            amount: rc.amount,
            chargeTo: rc.charge_to as ChargeTo,
          });
          tenant.db
            .prepare(`UPDATE recurring_service_contracts SET next_bill_date = ? WHERE id = ? AND organization_id = ?`)
            .run(nextDate, rc.id, tenant.organizationId);
          generatedCount += 1;
        }
        return { generatedCount };
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// Helper: BR-05 & BR-06 Payer Determination + Journal Posting
export function issueUnitServiceBill(
  tenant: ReturnType<typeof getTenantDb>,
  params: {
    serviceId: string;
    serviceName: string;
    propertyId: string;
    unitId: string;
    readingId: string | null;
    periodStart: string;
    periodEnd: string;
    amount: string;
    chargeTo: ChargeTo;
  },
): string {
  const unit = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM units WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
      .get(params.unitId, tenant.organizationId) as any,
    'الوحدة',
  );

  let payerPartyId: string | null = null;
  let payerRole: 'RENTER' | 'UNIT_OWNER' | 'OWNER' = 'RENTER';
  let agreementId: string | null = null;

  if (params.chargeTo === ChargeTo.OWNER) {
    const primaryOwner = tenant.db
      .prepare(
        `SELECT party_id FROM property_owners WHERE property_id = ? AND organization_id = ? ORDER BY is_primary DESC LIMIT 1`,
      )
      .get(params.propertyId, tenant.organizationId) as { party_id: string } | undefined;
    if (!primaryOwner) throw new HttpError(400, 'لا يوجد مالك للعقار لتحميل الفاتورة');
    payerPartyId = primaryOwner.party_id;
    payerRole = 'OWNER';
  } else if (unit.tenure_type === 'OWNED') {
    // BR-05 & BR-06: On OWNED unit, "TENANT" chargeTo bills the UNIT_OWNER
    if (!unit.unit_owner_party_id) {
      throw new HttpError(400, `وحدة التمليك ${unit.unit_number} ليس لها مالك وحدة مسجل`);
    }
    payerPartyId = unit.unit_owner_party_id;
    payerRole = 'UNIT_OWNER';
  } else {
    // RENTAL unit: must have exactly 1 active/notice agreement covering the period
    const ags = tenant.db
      .prepare(
        `SELECT * FROM rent_agreements
         WHERE organization_id = ? AND unit_id = ? AND status IN ('ACTIVE', 'NOTICE')
           AND start_date <= ? AND end_date >= ?`,
      )
      .all(tenant.organizationId, unit.id, params.periodEnd, params.periodStart) as any[];

    if (ags.length === 0) {
      throw new HttpError(
        400,
        `لا يوجد مستأجر بعقد نشط للوحدة ${unit.unit_number} في الفترة ${params.periodStart}..${params.periodEnd} — يُرفض إصدار الفاتورة دون دافع محدد`,
      );
    }
    if (ags.length > 1) {
      throw new HttpError(409, `يوجد أكثر من عقد نشط متداخل للوحدة ${unit.unit_number}`);
    }
    payerPartyId = ags[0].tenant_party_id;
    payerRole = 'RENTER';
    agreementId = ags[0].id;
  }

  const billId = newId('bill');
  const seq = tenant.nextSequence('bill_seq');
  const billNumber = `BILL-${String(seq).padStart(5, '0')}`;
  const amtD = D(params.amount);

  let journalEntryId: string | null = null;
  if (amtD.gt(0)) {
    if (payerRole === 'OWNER') {
      journalEntryId = postJournalEntry(tenant, {
        entryDate: params.periodEnd,
        description: `فاتورة خدمة على المالك (${params.serviceName}) - وحدة ${unit.unit_number}`,
        sourceType: 'SERVICE_BILL',
        sourceId: billId,
        propertyId: params.propertyId,
        lines: [
          { accountCode: '5200', debit: amtD, partyId: payerPartyId, propertyId: params.propertyId, memo: params.serviceName },
          { accountCode: '2120', credit: amtD, partyId: payerPartyId, propertyId: params.propertyId, memo: 'مستحقات خدمات على المالك' },
        ],
      });
    } else {
      const arCode = payerRole === 'UNIT_OWNER' ? '1220' : '1210';
      journalEntryId = postJournalEntry(tenant, {
        entryDate: params.periodEnd,
        description: `فاتورة خدمة (${params.serviceName}) - وحدة ${unit.unit_number}`,
        sourceType: 'SERVICE_BILL',
        sourceId: billId,
        propertyId: params.propertyId,
        lines: [
          { accountCode: arCode, debit: amtD, partyId: payerPartyId, propertyId: params.propertyId, memo: params.serviceName },
          { accountCode: '4200', credit: amtD, partyId: payerPartyId, propertyId: params.propertyId, memo: 'إيراد خدمات مستردة' },
        ],
      });
    }
  }

  tenant.db
    .prepare(
      `INSERT INTO service_bills
       (id, organization_id, bill_number, service_id, property_id, unit_id, reading_id, payer_party_id, payer_role, agreement_id, period_start, period_end, due_date, amount, paid_amount, charge_to, status, journal_entry_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0.00', ?, 'ISSUED', ?, ?)`,
    )
    .run(
      billId,
      tenant.organizationId,
      billNumber,
      params.serviceId,
      params.propertyId,
      unit.id,
      params.readingId,
      payerPartyId,
      payerRole,
      agreementId,
      params.periodStart,
      params.periodEnd,
      params.periodEnd,
      amtD.toFixed(2),
      params.chargeTo,
      journalEntryId,
      nowIso(),
    );

  // Notify payer (FR-NTF-03)
  const ntfId = newId('ntf');
  tenant.db
    .prepare(
      `INSERT INTO notifications (id, organization_id, sender_user_id, title, body, audience_type, audience_target_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'PARTY', ?, ?)`,
    )
    .run(
      ntfId,
      tenant.organizationId,
      tenant.userId,
      `فاتورة خدمة جديدة (${billNumber})`,
      `صدرت فاتورة ${params.serviceName} للوحدة ${unit.unit_number} بمبلغ ${amtD.toFixed(2)}.`,
      payerPartyId,
      nowIso(),
    );
  const pUser = tenant.db
    .prepare(`SELECT id FROM users WHERE organization_id = ? AND party_id = ? AND is_active = 1`)
    .get(tenant.organizationId, payerPartyId) as { id: string } | undefined;
  tenant.db
    .prepare(
      `INSERT INTO notification_recipients (id, organization_id, notification_id, user_id, party_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(newId('nrec'), tenant.organizationId, ntfId, pUser?.id ?? null, payerPartyId);

  return billId;
}
