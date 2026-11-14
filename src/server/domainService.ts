import Decimal from 'decimal.js';
import { D, toFixedMoney } from '../domain/money';
import {
  calculateDepositBalance,
  calculateGracePeriodImpact,
  calculateSettlement,
  generateInstallmentSchedule,
  StateMachines,
} from '../domain/rules';
import {
  ChargeTo,
  CollectionFrequency,
  DepositMovementType,
  EvictionStatus,
  InstallmentStatus,
  MaintenanceStatus,
  RentAgreementStatus,
  SecurityDepositStatus,
  ServiceBillStatus,
  UnitStatus,
  VoucherReferenceType,
  VoucherStatus,
  VoucherType,
} from '../domain/types';
import { postJournalEntry, reverseJournalEntry } from './accounting';
import { HttpError, newId, nowIso, TenantDb, todayIso } from './db';

// FR-PRP-08: Derived Unit Status (VACANT | RENTED | MAINTENANCE)
export function deriveUnitStatus(tenant: TenantDb, unitId: string, tenureType: string): string {
  if (tenureType === 'OWNED') return 'OWNED';
  const activeContract = tenant.db
    .prepare(
      `SELECT a.id FROM rent_agreements a
       WHERE a.organization_id = ? AND a.unit_id = ? AND a.status IN ('ACTIVE', 'NOTICE')
         AND NOT EXISTS (
           SELECT 1 FROM eviction_requests e
           WHERE e.agreement_id = a.id AND e.organization_id = a.organization_id
             AND e.status IN ('HANDED_OVER', 'SETTLED', 'CLOSED')
         )
       LIMIT 1`,
    )
    .get(tenant.organizationId, unitId);
  if (activeContract) return UnitStatus.RENTED;

  const openMaint = tenant.db
    .prepare(
      `SELECT id FROM maintenance_records
       WHERE organization_id = ? AND unit_id = ? AND status IN ('OPEN', 'IN_PROGRESS')
       LIMIT 1`,
    )
    .get(tenant.organizationId, unitId);
  if (openMaint) return UnitStatus.MAINTENANCE;

  return UnitStatus.VACANT;
}

// FR-ACC-05: Accrue due installments idempotently
export function accrueInstallmentIfNeeded(tenant: TenantDb, inst: any, entryDate?: string): string {
  if (inst.accrual_journal_id) return inst.accrual_journal_id;
  if (inst.status === InstallmentStatus.WAIVED) {
    throw new HttpError(400, 'لا يمكن استحقاق قسط ملغى بإشعار دائن');
  }
  const agreement = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ?`)
      .get(inst.agreement_id, tenant.organizationId) as any,
    'العقد',
  );
  const netToAccrue = D(inst.amount).minus(inst.waived_amount ?? 0);
  if (netToAccrue.lte(0)) {
    throw new HttpError(400, 'صافي مبلغ القسط للاستحقاق يساوي صفراً');
  }

  const jeId = postJournalEntry(tenant, {
    entryDate: entryDate ?? inst.due_date,
    description: `استحقاق قسط إيجار #${inst.installment_number} للعقد`,
    sourceType: 'INSTALLMENT_ACCRUAL',
    sourceId: inst.id,
    propertyId: agreement.property_id,
    lines: [
      {
        accountCode: '1210',
        debit: netToAccrue,
        partyId: agreement.tenant_party_id,
        propertyId: agreement.property_id,
        memo: `قسط #${inst.installment_number}`,
      },
      {
        accountCode: '4100',
        credit: netToAccrue,
        partyId: agreement.tenant_party_id,
        propertyId: agreement.property_id,
        memo: `إيراد إيجار قسط #${inst.installment_number}`,
      },
    ],
  });

  tenant.db
    .prepare(`UPDATE installments SET accrual_journal_id = ? WHERE id = ? AND organization_id = ?`)
    .run(jeId, inst.id, tenant.organizationId);

  return jeId;
}

export function runDueInstallmentsAccrualJob(tenant: TenantDb, asOfDate = todayIso()): {
  accruedCount: number;
  notificationsSent: number;
} {
  return tenant.runAtomic('JOB_ACCRUE_DUE', undefined, () => {
    const dueRows = tenant.db
      .prepare(
        `SELECT i.* FROM installments i
         JOIN rent_agreements a ON a.id = i.agreement_id
         WHERE i.organization_id = ?
           AND i.accrual_journal_id IS NULL
           AND i.status != 'WAIVED'
           AND a.status IN ('ACTIVE', 'NOTICE')
           AND i.due_date <= ?`,
      )
      .all(tenant.organizationId, asOfDate) as any[];

    let accruedCount = 0;
    for (const inst of dueRows) {
      accrueInstallmentIfNeeded(tenant, inst, inst.due_date);
      accruedCount += 1;
    }

    // Also generate notifications for upcoming expiry & overdue installments (FR-NTF-03)
    const org = tenant.getOrg();
    let notificationsSent = 0;
    const expiryDays = Number(org.contract_expiry_alert_days ?? 30);
    const futureLimit = new Date(Date.parse(asOfDate) + expiryDays * 86400000).toISOString().slice(0, 10);

    const expiring = tenant.db
      .prepare(
        `SELECT a.*, u.unit_number FROM rent_agreements a
         JOIN units u ON u.id = a.unit_id
         WHERE a.organization_id = ? AND a.status = 'ACTIVE' AND a.end_date <= ? AND a.end_date >= ?`,
      )
      .all(tenant.organizationId, futureLimit, asOfDate) as any[];

    for (const ag of expiring) {
      const already = tenant.db
        .prepare(
          `SELECT id FROM notifications WHERE organization_id = ? AND title LIKE ? AND created_at >= ?`,
        )
        .get(tenant.organizationId, `%${ag.unit_number}%`, `${asOfDate}T00:00:00`);
      if (!already) {
        const notifId = newId('ntf');
        tenant.db
          .prepare(
            `INSERT INTO notifications (id, organization_id, sender_user_id, title, body, audience_type, audience_target_id, created_at)
             VALUES (?, ?, ?, ?, ?, 'PARTY', ?, ?)`,
          )
          .run(
            notifId,
            tenant.organizationId,
            tenant.userId,
            `تنبيه قرب انتهاء عقد الوحدة ${ag.unit_number}`,
            `ينتهي عقد الإيجار الخاص بالوحدة ${ag.unit_number} بتاريخ ${ag.end_date}.`,
            ag.tenant_party_id,
            nowIso(),
          );
        const tenantUser = tenant.db
          .prepare(`SELECT id FROM users WHERE organization_id = ? AND party_id = ? AND is_active = 1`)
          .get(tenant.organizationId, ag.tenant_party_id) as { id: string } | undefined;
        tenant.db
          .prepare(
            `INSERT INTO notification_recipients (id, organization_id, notification_id, user_id, party_id)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(newId('nrec'), tenant.organizationId, notifId, tenantUser?.id ?? null, ag.tenant_party_id);
        notificationsSent += 1;
      }
    }

    // Dispatch scheduled notifications due <= asOfDate (FR-NTF-05)
    const dueScheduled = tenant.db
      .prepare(
        `SELECT * FROM scheduled_notifications
         WHERE organization_id = ? AND status = 'SCHEDULED' AND scheduled_for <= ?`,
      )
      .all(tenant.organizationId, asOfDate) as any[];

    for (const sn of dueScheduled) {
      const notifId = newId('ntf');
      tenant.db
        .prepare(
          `INSERT INTO notifications (id, organization_id, sender_user_id, title, body, audience_type, audience_target_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          notifId,
          tenant.organizationId,
          sn.created_by_user_id,
          sn.title,
          sn.body,
          sn.audience_type,
          sn.audience_target_id ?? null,
          nowIso(),
        );
      let targetParties: Array<{ party_id: string }> = [];
      if (sn.audience_type === 'ALL') {
        targetParties = tenant.db
          .prepare(`SELECT id AS party_id FROM parties WHERE organization_id = ? AND deleted_at IS NULL`)
          .all(tenant.organizationId) as any[];
      } else if (sn.audience_type === 'PARTY' && sn.audience_target_id) {
        targetParties = [{ party_id: sn.audience_target_id }];
      } else if (sn.audience_type === 'PROPERTY' && sn.audience_target_id) {
        targetParties = tenant.db
          .prepare(
            `SELECT DISTINCT tenant_party_id AS party_id FROM rent_agreements WHERE organization_id = ? AND property_id = ? AND status IN ('ACTIVE','NOTICE')`,
          )
          .all(tenant.organizationId, sn.audience_target_id) as any[];
      } else if (sn.audience_type === 'UNIT' && sn.audience_target_id) {
        targetParties = tenant.db
          .prepare(
            `SELECT tenant_party_id AS party_id FROM rent_agreements WHERE organization_id = ? AND unit_id = ? AND status IN ('ACTIVE','NOTICE')`,
          )
          .all(tenant.organizationId, sn.audience_target_id) as any[];
      }
      for (const tp of targetParties) {
        const u = tenant.db
          .prepare(`SELECT id FROM users WHERE organization_id = ? AND party_id = ? AND is_active = 1`)
          .get(tenant.organizationId, tp.party_id) as { id: string } | undefined;
        tenant.db
          .prepare(
            `INSERT INTO notification_recipients (id, organization_id, notification_id, user_id, party_id) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(newId('nrec'), tenant.organizationId, notifId, u?.id ?? null, tp.party_id);
      }
      tenant.db
        .prepare(`UPDATE scheduled_notifications SET status = 'SENT', sent_at = ? WHERE id = ? AND organization_id = ?`)
        .run(nowIso(), sn.id, tenant.organizationId);
      notificationsSent += 1;
    }

    return { accruedCount, notificationsSent };
  });
}

// FR-EVC-10: Daily eviction check
export function runEvictionDailyCheck(tenant: TenantDb, asOfDate = todayIso()): {
  movedToOverdue: number;
} {
  return tenant.runAtomic('JOB_EVICTION_CHECK', undefined, () => {
    const rows = tenant.db
      .prepare(
        `SELECT * FROM eviction_requests
         WHERE organization_id = ? AND status = 'IN_GRACE'`,
      )
      .all(tenant.organizationId) as any[];

    let movedToOverdue = 0;
    for (const ev of rows) {
      const deadline = ev.extended_until && ev.extended_until > ev.grace_end_date ? ev.extended_until : ev.grace_end_date;
      if (asOfDate > deadline) {
        StateMachines.eviction(EvictionStatus.IN_GRACE, EvictionStatus.OVERDUE);
        tenant.db
          .prepare(`UPDATE eviction_requests SET status = 'OVERDUE' WHERE id = ? AND organization_id = ?`)
          .run(ev.id, tenant.organizationId);
        tenant.audit({
          entityType: 'EvictionRequest',
          entityId: ev.id,
          action: 'MARK_OVERDUE',
          oldValue: { status: EvictionStatus.IN_GRACE },
          newValue: { status: EvictionStatus.OVERDUE, asOfDate },
        });
        movedToOverdue += 1;
      }
    }
    return { movedToOverdue };
  });
}

export function createAgreementWithSchedule(
  tenant: TenantDb,
  params: {
    unitId: string;
    tenantPartyId: string;
    startDate: string;
    endDate: string;
    totalAmount: string;
    discountAmount?: string;
    frequency: CollectionFrequency;
    customCount?: number;
    graceDays?: number;
    depositAmount?: string;
    renewedFromId?: string | null;
    notes?: string;
    expenseItems?: Array<{ expenseTypeId: string; amount?: string; chargeTo?: ChargeTo }>;
    initialMeterReadings?: Array<{ meterId: string; reading: string }>;
  },
): { agreementId: string; installmentCount: number } {
  const org = tenant.getOrg();
  const unit = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM units WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
      .get(params.unitId, tenant.organizationId) as any,
    'الوحدة',
  );

  // BR-13: No rental contract on OWNED unit
  if (unit.tenure_type === 'OWNED') {
    throw new HttpError(400, 'لا يمكن إنشاء عقد إيجار على وحدة تمليك (OWNED)');
  }

  // FR-PTY-02: Tenant must have national_id and phone
  const party = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM parties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
      .get(params.tenantPartyId, tenant.organizationId) as any,
    'المستأجر',
  );
  if (!party.national_id || !party.phone) {
    throw new HttpError(400, 'رقم الهوية ورقم الهاتف إلزاميان للمستأجر');
  }

  // FR-CTR-02: No overlapping active/notice contracts on the unit
  const overlap = tenant.db
    .prepare(
      `SELECT id FROM rent_agreements
       WHERE organization_id = ? AND unit_id = ?
         AND status IN ('ACTIVE', 'NOTICE', 'DRAFT')
         AND NOT (end_date < ? OR start_date > ?)`,
    )
    .get(tenant.organizationId, params.unitId, params.startDate, params.endDate);
  if (overlap) {
    throw new HttpError(409, 'يوجد عقد نشط متداخل لهذه الوحدة في نفس الفترة');
  }

  const schedule = generateInstallmentSchedule({
    startDate: params.startDate,
    endDate: params.endDate,
    totalAmount: params.totalAmount,
    discountAmount: params.discountAmount ?? '0',
    frequency: params.frequency,
    customCount: params.customCount,
    roundingStep: org.rounding_step,
  });

  const agreementId = newId('agr');
  const graceDays = params.graceDays ?? Number(org.default_grace_days ?? 15);
  const depositAmount = toFixedMoney(params.depositAmount ?? '0');

  tenant.db
    .prepare(
      `INSERT INTO rent_agreements
       (id, organization_id, property_id, unit_id, tenant_party_id, renewed_from_id, start_date, end_date, total_amount, discount_amount, frequency, grace_days, deposit_amount, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    )
    .run(
      agreementId,
      tenant.organizationId,
      unit.property_id,
      unit.id,
      party.id,
      params.renewedFromId ?? null,
      params.startDate,
      params.endDate,
      toFixedMoney(params.totalAmount),
      toFixedMoney(params.discountAmount ?? '0'),
      params.frequency,
      graceDays,
      depositAmount,
      params.notes ?? null,
      nowIso(),
    );

  const insertInst = tenant.db.prepare(
    `INSERT INTO installments
     (id, organization_id, agreement_id, installment_number, period_start, period_end, due_date, amount, paid_amount, waived_amount, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0.00', '0.00', 'PENDING', ?)`,
  );

  for (const item of schedule) {
    insertInst.run(
      newId('ins'),
      tenant.organizationId,
      agreementId,
      item.installmentNumber,
      item.periodStart,
      item.periodEnd,
      item.dueDate,
      item.amount,
      nowIso(),
    );
  }

  // Contract expense items (FR-CTR-04) + balanced GL accrual (P2)
  if (params.expenseItems && params.expenseItems.length > 0) {
    const netAmount = D(params.totalAmount).minus(params.discountAmount ?? '0');
    for (const ei of params.expenseItems) {
      const expType = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM contract_expense_types WHERE id = ? AND organization_id = ?`)
          .get(ei.expenseTypeId, tenant.organizationId) as any,
        'نوع المصروف',
      );
      const computedAmtD = ei.amount
        ? D(ei.amount)
        : expType.calc_mode === 'PERCENTAGE'
          ? netAmount.mul(expType.default_value).div(100)
          : D(expType.default_value);
      const computedAmt = toFixedMoney(computedAmtD);
      const chargeTo = ei.chargeTo ?? expType.default_charge_to;
      const itemId = newId('cei');
      let jeId: string | null = null;

      if (D(computedAmt).gt(0)) {
        if (chargeTo === ChargeTo.TENANT) {
          jeId = postJournalEntry(tenant, {
            entryDate: params.startDate,
            description: `بند مصروف عقد: ${expType.name}`,
            sourceType: 'CONTRACT_EXPENSE',
            sourceId: itemId,
            propertyId: unit.property_id,
            lines: [
              { accountCode: '1210', debit: computedAmt, partyId: party.id, propertyId: unit.property_id, memo: expType.name },
              { accountCode: expType.account_code || '4400', credit: computedAmt, partyId: party.id, propertyId: unit.property_id, memo: expType.name },
            ],
          });
        } else {
          jeId = postJournalEntry(tenant, {
            entryDate: params.startDate,
            description: `بند مصروف عقد على المالك: ${expType.name}`,
            sourceType: 'CONTRACT_EXPENSE',
            sourceId: itemId,
            propertyId: unit.property_id,
            lines: [
              { accountCode: '5200', debit: computedAmt, partyId: party.id, propertyId: unit.property_id, memo: expType.name },
              { accountCode: '2120', credit: computedAmt, partyId: party.id, propertyId: unit.property_id, memo: expType.name },
            ],
          });
        }
      }

      tenant.db
        .prepare(
          `INSERT INTO contract_expense_items (id, organization_id, agreement_id, expense_type_id, name, amount, charge_to, paid_amount, journal_entry_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, '0.00', ?)`,
        )
        .run(
          itemId,
          tenant.organizationId,
          agreementId,
          expType.id,
          expType.name,
          computedAmt,
          chargeTo,
          jeId,
        );
    }
  }

  // FR-CTR-05: Independent SecurityDeposit record
  tenant.db
    .prepare(
      `INSERT INTO security_deposits (id, organization_id, agreement_id, expected_amount, received_amount, held_balance, status, created_at)
       VALUES (?, ?, ?, ?, '0.00', '0.00', 'HELD', ?)`,
    )
    .run(newId('dep'), tenant.organizationId, agreementId, depositAmount, nowIso());

  // FR-CTR-06: Initial meter readings on contract start
  if (params.initialMeterReadings) {
    for (const mr of params.initialMeterReadings) {
      const meter = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM service_meters WHERE id = ? AND organization_id = ?`)
          .get(mr.meterId, tenant.organizationId) as any,
        'العداد',
      );
      tenant.db
        .prepare(
          `UPDATE service_meters SET last_reading = ?, last_reading_date = ? WHERE id = ? AND organization_id = ?`,
        )
        .run(toFixedMoney(mr.reading), params.startDate, meter.id, tenant.organizationId);
    }
  }

  // Ensure RENTER party has RENTER role
  const roles: string[] = JSON.parse(party.roles_json);
  if (!roles.includes('RENTER')) {
    roles.push('RENTER');
    tenant.db
      .prepare(`UPDATE parties SET roles_json = ? WHERE id = ? AND organization_id = ?`)
      .run(JSON.stringify(roles), party.id, tenant.organizationId);
  }

  tenant.audit({
    entityType: 'RentAgreement',
    entityId: agreementId,
    action: 'CREATE',
    newValue: {
      unitId: unit.id,
      tenantPartyId: party.id,
      totalAmount: params.totalAmount,
      installments: schedule.length,
      depositAmount,
    },
  });

  return { agreementId, installmentCount: schedule.length };
}

// FR-COL-02, FR-COL-06: Atomic receipt collection + cashbox update + balanced journal entry
export function createVoucherAtomic(
  tenant: TenantDb,
  params: {
    voucherType: VoucherType;
    cashboxId: string;
    targetCashboxId?: string;
    referenceType: VoucherReferenceType;
    referenceId: string;
    amount: string;
    voucherDate?: string;
    description?: string;
  },
): { voucherId: string; voucherNumber: string; journalEntryId: string } {
  const amt = D(params.amount);
  if (amt.lte(0)) {
    throw new HttpError(400, 'مبلغ السند يجب أن يكون أكبر من صفر');
  }
  const vDate = params.voucherDate ?? todayIso();

  const cashbox = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM cashboxes WHERE id = ? AND organization_id = ? AND is_active = 1`)
      .get(params.cashboxId, tenant.organizationId) as any,
    'الصندوق',
  );

  const seq = tenant.nextSequence('voucher_seq');
  const prefix =
    params.voucherType === VoucherType.RECEIPT
      ? 'RV'
      : params.voucherType === VoucherType.PAYMENT
        ? 'PV'
        : 'TV';
  const voucherNumber = `${prefix}-${String(seq).padStart(5, '0')}`;
  const voucherId = newId('vch');

  let partyId: string | null = null;
  let propertyId: string | null = null;
  let journalEntryId = '';
  let autoDescription = params.description ?? '';

  if (params.voucherType === VoucherType.TRANSFER) {
    if (!params.targetCashboxId || params.targetCashboxId === params.cashboxId) {
      throw new HttpError(400, 'يجب تحديد صندوق مستهدف مختلف للتحويل');
    }
    const targetCb = tenant.assertOwnedRow(
      tenant.db
        .prepare(`SELECT * FROM cashboxes WHERE id = ? AND organization_id = ? AND is_active = 1`)
        .get(params.targetCashboxId, tenant.organizationId) as any,
      'الصندوق المستهدف',
    );
    const srcBal = D(cashbox.balance);
    if (srcBal.lt(amt)) {
      throw new HttpError(400, `رصيد الصندوق (${srcBal.toFixed(2)}) غير كافٍ للتحويل`);
    }
    const newSrcBal = srcBal.minus(amt);
    const newTgtBal = D(targetCb.balance).plus(amt);

    autoDescription = autoDescription || `تحويل من ${cashbox.name} إلى ${targetCb.name}`;

    journalEntryId = postJournalEntry(tenant, {
      entryDate: vDate,
      description: autoDescription,
      sourceType: 'VOUCHER_TRANSFER',
      sourceId: voucherId,
      lines: [
        { accountCode: targetCb.account_code, debit: amt, memo: targetCb.name },
        { accountCode: cashbox.account_code, credit: amt, memo: cashbox.name },
      ],
    });

    tenant.db
      .prepare(
        `INSERT INTO vouchers
         (id, organization_id, voucher_number, voucher_type, cashbox_id, target_cashbox_id, reference_type, reference_id, amount, voucher_date, description, status, journal_entry_id, created_by_user_id, created_at)
         VALUES (?, ?, ?, 'TRANSFER', ?, ?, 'CASHBOX_TRANSFER', ?, ?, ?, ?, 'POSTED', ?, ?, ?)`,
      )
      .run(
        voucherId,
        tenant.organizationId,
        voucherNumber,
        cashbox.id,
        targetCb.id,
        voucherId,
        amt.toFixed(2),
        vDate,
        autoDescription,
        journalEntryId,
        tenant.userId,
        nowIso(),
      );

    tenant.db
      .prepare(`UPDATE cashboxes SET balance = ? WHERE id = ? AND organization_id = ?`)
      .run(newSrcBal.toFixed(2), cashbox.id, tenant.organizationId);
    tenant.db
      .prepare(`UPDATE cashboxes SET balance = ? WHERE id = ? AND organization_id = ?`)
      .run(newTgtBal.toFixed(2), targetCb.id, tenant.organizationId);

    tenant.db
      .prepare(
        `INSERT INTO cashbox_transactions (id, organization_id, cashbox_id, voucher_id, direction, amount, balance_after, created_at)
         VALUES (?, ?, ?, ?, 'OUT', ?, ?, ?)`,
      )
      .run(newId('cbt'), tenant.organizationId, cashbox.id, voucherId, amt.toFixed(2), newSrcBal.toFixed(2), nowIso());
    tenant.db
      .prepare(
        `INSERT INTO cashbox_transactions (id, organization_id, cashbox_id, voucher_id, direction, amount, balance_after, created_at)
         VALUES (?, ?, ?, ?, 'IN', ?, ?, ?)`,
      )
      .run(newId('cbt'), tenant.organizationId, targetCb.id, voucherId, amt.toFixed(2), newTgtBal.toFixed(2), nowIso());

    tenant.audit({
      entityType: 'Voucher',
      entityId: voucherId,
      action: 'CREATE_TRANSFER',
      newValue: { voucherNumber, amount: amt.toFixed(2), from: cashbox.id, to: targetCb.id },
    });

    return { voucherId, voucherNumber, journalEntryId };
  }

  if (params.voucherType === VoucherType.RECEIPT) {
    let creditAccountCode = '1210';

    if (params.referenceType === VoucherReferenceType.INSTALLMENT) {
      const inst = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM installments WHERE id = ? AND organization_id = ?`)
          .get(params.referenceId, tenant.organizationId) as any,
        'القسط',
      );
      if (inst.status === InstallmentStatus.WAIVED || inst.status === InstallmentStatus.PAID) {
        throw new HttpError(400, 'القسط مسدّد أو ملغى بالفعل');
      }
      const remaining = D(inst.amount).minus(inst.paid_amount).minus(inst.waived_amount ?? 0);
      if (amt.gt(remaining)) {
        throw new HttpError(400, `مبلغ التحصيل (${amt.toFixed(2)}) يتجاوز المتبقي من القسط (${remaining.toFixed(2)})`);
      }

      // Accrue installment in GL if not yet accrued so AR sub-ledger stays 100% matched!
      accrueInstallmentIfNeeded(tenant, inst, vDate);

      const agreement = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ?`)
          .get(inst.agreement_id, tenant.organizationId) as any,
        'العقد',
      );
      partyId = agreement.tenant_party_id;
      propertyId = agreement.property_id;
      creditAccountCode = '1210';

      const newPaid = D(inst.paid_amount).plus(amt);
      const netDue = D(inst.amount).minus(inst.waived_amount ?? 0);
      const nextStatus = newPaid.gte(netDue) ? InstallmentStatus.PAID : InstallmentStatus.PARTIAL;
      StateMachines.installment(inst.status as InstallmentStatus, nextStatus);

      tenant.db
        .prepare(`UPDATE installments SET paid_amount = ?, status = ? WHERE id = ? AND organization_id = ?`)
        .run(newPaid.toFixed(2), nextStatus, inst.id, tenant.organizationId);

      autoDescription = autoDescription || `سند قبض قسط إيجار #${inst.installment_number}`;
    } else if (params.referenceType === VoucherReferenceType.SERVICE_BILL) {
      const bill = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM service_bills WHERE id = ? AND organization_id = ?`)
          .get(params.referenceId, tenant.organizationId) as any,
        'فاتورة الخدمة',
      );
      if (bill.status === ServiceBillStatus.VOID || bill.status === ServiceBillStatus.PAID) {
        throw new HttpError(400, 'الفاتورة مسدّدة أو ملغاة بالفعل');
      }
      const remaining = D(bill.amount).minus(bill.paid_amount);
      if (amt.gt(remaining)) {
        throw new HttpError(400, `مبلغ التحصيل يتجاوز المتبقي من الفاتورة (${remaining.toFixed(2)})`);
      }
      partyId = bill.payer_party_id;
      propertyId = bill.property_id;
      creditAccountCode = bill.payer_role === 'UNIT_OWNER' ? '1220' : '1210';

      const newPaid = D(bill.paid_amount).plus(amt);
      const nextStatus = newPaid.gte(D(bill.amount)) ? ServiceBillStatus.PAID : ServiceBillStatus.PARTIAL;
      StateMachines.serviceBill(bill.status as ServiceBillStatus, nextStatus);
      tenant.db
        .prepare(`UPDATE service_bills SET paid_amount = ?, status = ? WHERE id = ? AND organization_id = ?`)
        .run(newPaid.toFixed(2), nextStatus, bill.id, tenant.organizationId);

      autoDescription = autoDescription || `سند قبض فاتورة خدمة ${bill.bill_number}`;
    } else if (params.referenceType === VoucherReferenceType.MAINTENANCE) {
      const maint = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM maintenance_records WHERE id = ? AND organization_id = ?`)
          .get(params.referenceId, tenant.organizationId) as any,
        'سجل الصيانة',
      );
      if (maint.charge_to !== ChargeTo.TENANT) {
        throw new HttpError(400, 'يمكن تحصيل الصيانة المحمّلة على المستأجر فقط');
      }
      const remaining = D(maint.cost).minus(maint.paid_amount);
      if (amt.gt(remaining)) {
        throw new HttpError(400, `مبلغ التحصيل يتجاوز المتبقي من الصيانة (${remaining.toFixed(2)})`);
      }
      if (maint.agreement_id) {
        const ag = tenant.db
          .prepare(`SELECT tenant_party_id FROM rent_agreements WHERE id = ? AND organization_id = ?`)
          .get(maint.agreement_id, tenant.organizationId) as { tenant_party_id: string } | undefined;
        partyId = ag?.tenant_party_id ?? null;
      }
      propertyId = maint.property_id;
      creditAccountCode = '1210';

      const newPaid = D(maint.paid_amount).plus(amt);
      tenant.db
        .prepare(`UPDATE maintenance_records SET paid_amount = ? WHERE id = ? AND organization_id = ?`)
        .run(newPaid.toFixed(2), maint.id, tenant.organizationId);

      autoDescription = autoDescription || `سند قبض تكلفة صيانة (${maint.maintenance_type})`;
    } else if (params.referenceType === VoucherReferenceType.CONTRACT_EXPENSE) {
      const ce = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM contract_expense_items WHERE id = ? AND organization_id = ?`)
          .get(params.referenceId, tenant.organizationId) as any,
        'بند مصروف العقد',
      );
      if (ce.charge_to !== ChargeTo.TENANT) {
        throw new HttpError(400, 'يمكن تحصيل بنود العقد المحمّلة على المستأجر فقط');
      }
      const remaining = D(ce.amount).minus(ce.paid_amount);
      if (amt.gt(remaining)) {
        throw new HttpError(400, `مبلغ التحصيل يتجاوز المتبقي من البند (${remaining.toFixed(2)})`);
      }
      const ag = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ?`)
          .get(ce.agreement_id, tenant.organizationId) as any,
        'العقد',
      );
      partyId = ag.tenant_party_id;
      propertyId = ag.property_id;
      creditAccountCode = '1210';
      const newPaid = D(ce.paid_amount).plus(amt);
      tenant.db
        .prepare(`UPDATE contract_expense_items SET paid_amount = ? WHERE id = ? AND organization_id = ?`)
        .run(newPaid.toFixed(2), ce.id, tenant.organizationId);
      autoDescription = autoDescription || `سند قبض رسوم عقد (${ce.name})`;
    } else if (params.referenceType === VoucherReferenceType.SECURITY_DEPOSIT) {
      const dep = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM security_deposits WHERE id = ? AND organization_id = ?`)
          .get(params.referenceId, tenant.organizationId) as any,
        'سجل التأمين',
      );
      const ag = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ?`)
          .get(dep.agreement_id, tenant.organizationId) as any,
        'العقد',
      );
      partyId = ag.tenant_party_id;
      propertyId = ag.property_id;
      creditAccountCode = '2110';

      tenant.db
        .prepare(
          `INSERT INTO deposit_movements (id, organization_id, deposit_id, movement_type, amount, reference_type, reference_id, notes, created_at)
           VALUES (?, ?, ?, 'RECEIVED', ?, 'VOUCHER', ?, 'استلام تأمين العقد', ?)`,
        )
        .run(newId('dmv'), tenant.organizationId, dep.id, amt.toFixed(2), voucherId, nowIso());

      const moves = tenant.db
        .prepare(`SELECT movement_type AS type, amount FROM deposit_movements WHERE deposit_id = ? AND organization_id = ?`)
        .all(dep.id, tenant.organizationId) as any[];
      const bal = calculateDepositBalance(moves);

      tenant.db
        .prepare(`UPDATE security_deposits SET received_amount = ?, held_balance = ?, status = 'HELD' WHERE id = ? AND organization_id = ?`)
        .run(bal.received, bal.heldBalance, dep.id, tenant.organizationId);

      autoDescription = autoDescription || 'سند قبض تأمين مستأجر';
    } else {
      creditAccountCode = '4400';
      autoDescription = autoDescription || 'سند قبض عام';
    }

    journalEntryId = postJournalEntry(tenant, {
      entryDate: vDate,
      description: autoDescription,
      sourceType: `VOUCHER_RECEIPT_${params.referenceType}`,
      sourceId: voucherId,
      propertyId,
      lines: [
        { accountCode: cashbox.account_code, debit: amt, partyId, propertyId, memo: cashbox.name },
        { accountCode: creditAccountCode, credit: amt, partyId, propertyId, memo: autoDescription },
      ],
    });

    const newCbBal = D(cashbox.balance).plus(amt);
    tenant.db
      .prepare(
        `INSERT INTO vouchers
         (id, organization_id, voucher_number, voucher_type, cashbox_id, party_id, property_id, reference_type, reference_id, amount, voucher_date, description, status, journal_entry_id, created_by_user_id, created_at)
         VALUES (?, ?, ?, 'RECEIPT', ?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, ?)`,
      )
      .run(
        voucherId,
        tenant.organizationId,
        voucherNumber,
        cashbox.id,
        partyId,
        propertyId,
        params.referenceType,
        params.referenceId,
        amt.toFixed(2),
        vDate,
        autoDescription,
        journalEntryId,
        tenant.userId,
        nowIso(),
      );

    tenant.db
      .prepare(`UPDATE cashboxes SET balance = ? WHERE id = ? AND organization_id = ?`)
      .run(newCbBal.toFixed(2), cashbox.id, tenant.organizationId);

    tenant.db
      .prepare(
        `INSERT INTO cashbox_transactions (id, organization_id, cashbox_id, voucher_id, direction, amount, balance_after, created_at)
         VALUES (?, ?, ?, ?, 'IN', ?, ?, ?)`,
      )
      .run(newId('cbt'), tenant.organizationId, cashbox.id, voucherId, amt.toFixed(2), newCbBal.toFixed(2), nowIso());

    tenant.audit({
      entityType: 'Voucher',
      entityId: voucherId,
      action: 'CREATE_RECEIPT',
      newValue: { voucherNumber, amount: amt.toFixed(2), referenceType: params.referenceType, referenceId: params.referenceId },
    });

    return { voucherId, voucherNumber, journalEntryId };
  }

  // VoucherType.PAYMENT
  const srcBal = D(cashbox.balance);
  if (srcBal.lt(amt)) {
    throw new HttpError(400, `رصيد الصندوق (${srcBal.toFixed(2)}) غير كافٍ للصرف (يرفض الرصيد السالب)`);
  }
  const newCbBal = srcBal.minus(amt);

  let debitAccountCode = '5100';
  if (params.referenceType === VoucherReferenceType.MAINTENANCE) {
    debitAccountCode = '5100';
    autoDescription = autoDescription || 'سند صرف مصروف صيانة';
  } else if (params.referenceType === VoucherReferenceType.SETTLEMENT) {
    debitAccountCode = '2110';
    autoDescription = autoDescription || 'سند صرف رد تأمين تسوية';
  } else if (params.referenceType === VoucherReferenceType.EXPENSE) {
    debitAccountCode = '5400';
    autoDescription = autoDescription || 'سند صرف مصروف تشغيل / راتب حارس / مكافأة محصل';
  } else {
    debitAccountCode = '5200';
    autoDescription = autoDescription || 'سند صرف عام';
  }

  journalEntryId = postJournalEntry(tenant, {
    entryDate: vDate,
    description: autoDescription,
    sourceType: `VOUCHER_PAYMENT_${params.referenceType}`,
    sourceId: voucherId,
    propertyId,
    lines: [
      { accountCode: debitAccountCode, debit: amt, partyId, propertyId, memo: autoDescription },
      { accountCode: cashbox.account_code, credit: amt, partyId, propertyId, memo: cashbox.name },
    ],
  });

  tenant.db
    .prepare(
      `INSERT INTO vouchers
       (id, organization_id, voucher_number, voucher_type, cashbox_id, party_id, property_id, reference_type, reference_id, amount, voucher_date, description, status, journal_entry_id, created_by_user_id, created_at)
       VALUES (?, ?, ?, 'PAYMENT', ?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, ?)`,
    )
    .run(
      voucherId,
      tenant.organizationId,
      voucherNumber,
      cashbox.id,
      partyId,
      propertyId,
      params.referenceType,
      params.referenceId,
      amt.toFixed(2),
      vDate,
      autoDescription,
      journalEntryId,
      tenant.userId,
      nowIso(),
    );

  tenant.db
    .prepare(`UPDATE cashboxes SET balance = ? WHERE id = ? AND organization_id = ?`)
    .run(newCbBal.toFixed(2), cashbox.id, tenant.organizationId);

  tenant.db
    .prepare(
      `INSERT INTO cashbox_transactions (id, organization_id, cashbox_id, voucher_id, direction, amount, balance_after, created_at)
       VALUES (?, ?, ?, ?, 'OUT', ?, ?, ?)`,
    )
    .run(newId('cbt'), tenant.organizationId, cashbox.id, voucherId, amt.toFixed(2), newCbBal.toFixed(2), nowIso());

  tenant.audit({
    entityType: 'Voucher',
    entityId: voucherId,
    action: 'CREATE_PAYMENT',
    newValue: { voucherNumber, amount: amt.toFixed(2) },
  });

  return { voucherId, voucherNumber, journalEntryId };
}

// FR-COL-05: Reverse Voucher (no delete)
export function reverseVoucherAtomic(tenant: TenantDb, voucherId: string, reason: string): {
  reversalVoucherId: string;
  reversalJournalId: string;
} {
  const vch = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM vouchers WHERE id = ? AND organization_id = ?`)
      .get(voucherId, tenant.organizationId) as any,
    'السند',
  );
  StateMachines.voucher(vch.status as VoucherStatus, VoucherStatus.REVERSED);

  const amt = D(vch.amount);
  const vDate = todayIso();
  const revSeq = tenant.nextSequence('voucher_seq');
  const revNumber = `REV-${String(revSeq).padStart(5, '0')}`;
  const revVoucherId = newId('vch');

  const reversalJournalId = reverseJournalEntry(
    tenant,
    vch.journal_entry_id,
    vDate,
    `عكس سند ${vch.voucher_number}: ${reason}`,
    'VOUCHER_REVERSAL',
    revVoucherId,
  );

  // Restore cashbox balance(s)
  const cb = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM cashboxes WHERE id = ? AND organization_id = ?`)
      .get(vch.cashbox_id, tenant.organizationId) as any,
    'الصندوق',
  );

  if (vch.voucher_type === VoucherType.RECEIPT) {
    const newBal = D(cb.balance).minus(amt);
    if (newBal.lt(0)) {
      throw new HttpError(400, 'رصيد الصندوق لا يسمح بعكس سند القبض');
    }
    tenant.db
      .prepare(`UPDATE cashboxes SET balance = ? WHERE id = ? AND organization_id = ?`)
      .run(newBal.toFixed(2), cb.id, tenant.organizationId);
    tenant.db
      .prepare(
        `INSERT INTO cashbox_transactions (id, organization_id, cashbox_id, voucher_id, direction, amount, balance_after, created_at)
         VALUES (?, ?, ?, ?, 'OUT', ?, ?, ?)`,
      )
      .run(newId('cbt'), tenant.organizationId, cb.id, revVoucherId, amt.toFixed(2), newBal.toFixed(2), nowIso());

    // Restore reference sub-ledger status
    if (vch.reference_type === VoucherReferenceType.INSTALLMENT) {
      const inst = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM installments WHERE id = ? AND organization_id = ?`)
          .get(vch.reference_id, tenant.organizationId) as any,
        'القسط',
      );
      const newPaid = Decimal.max(0, D(inst.paid_amount).minus(amt));
      const nextStatus = newPaid.eq(0) ? InstallmentStatus.PENDING : InstallmentStatus.PARTIAL;
      StateMachines.installment(inst.status as InstallmentStatus, nextStatus);
      tenant.db
        .prepare(`UPDATE installments SET paid_amount = ?, status = ? WHERE id = ? AND organization_id = ?`)
        .run(newPaid.toFixed(2), nextStatus, inst.id, tenant.organizationId);
    } else if (vch.reference_type === VoucherReferenceType.SERVICE_BILL) {
      const bill = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM service_bills WHERE id = ? AND organization_id = ?`)
          .get(vch.reference_id, tenant.organizationId) as any,
        'فاتورة الخدمة',
      );
      const newPaid = Decimal.max(0, D(bill.paid_amount).minus(amt));
      const nextStatus = newPaid.eq(0) ? ServiceBillStatus.ISSUED : ServiceBillStatus.PARTIAL;
      StateMachines.serviceBill(bill.status as ServiceBillStatus, nextStatus);
      tenant.db
        .prepare(`UPDATE service_bills SET paid_amount = ?, status = ? WHERE id = ? AND organization_id = ?`)
        .run(newPaid.toFixed(2), nextStatus, bill.id, tenant.organizationId);
    } else if (vch.reference_type === VoucherReferenceType.MAINTENANCE) {
      const maint = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM maintenance_records WHERE id = ? AND organization_id = ?`)
          .get(vch.reference_id, tenant.organizationId) as any,
        'سجل الصيانة',
      );
      const newPaid = Decimal.max(0, D(maint.paid_amount).minus(amt));
      tenant.db
        .prepare(`UPDATE maintenance_records SET paid_amount = ? WHERE id = ? AND organization_id = ?`)
        .run(newPaid.toFixed(2), maint.id, tenant.organizationId);
    } else if (vch.reference_type === VoucherReferenceType.CONTRACT_EXPENSE) {
      const ce = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM contract_expense_items WHERE id = ? AND organization_id = ?`)
          .get(vch.reference_id, tenant.organizationId) as any,
        'بند مصروف العقد',
      );
      const newPaid = Decimal.max(0, D(ce.paid_amount).minus(amt));
      tenant.db
        .prepare(`UPDATE contract_expense_items SET paid_amount = ? WHERE id = ? AND organization_id = ?`)
        .run(newPaid.toFixed(2), ce.id, tenant.organizationId);
    }
  } else if (vch.voucher_type === VoucherType.PAYMENT) {
    const newBal = D(cb.balance).plus(amt);
    tenant.db
      .prepare(`UPDATE cashboxes SET balance = ? WHERE id = ? AND organization_id = ?`)
      .run(newBal.toFixed(2), cb.id, tenant.organizationId);
    tenant.db
      .prepare(
        `INSERT INTO cashbox_transactions (id, organization_id, cashbox_id, voucher_id, direction, amount, balance_after, created_at)
         VALUES (?, ?, ?, ?, 'IN', ?, ?, ?)`,
      )
      .run(newId('cbt'), tenant.organizationId, cb.id, revVoucherId, amt.toFixed(2), newBal.toFixed(2), nowIso());
  } else if (vch.voucher_type === VoucherType.TRANSFER && vch.target_cashbox_id) {
    const tgt = tenant.assertOwnedRow(
      tenant.db
        .prepare(`SELECT * FROM cashboxes WHERE id = ? AND organization_id = ?`)
        .get(vch.target_cashbox_id, tenant.organizationId) as any,
      'الصندوق المستهدف',
    );
    const newTgtBal = D(tgt.balance).minus(amt);
    if (newTgtBal.lt(0)) {
      throw new HttpError(400, 'رصيد الصندوق المستهدف لا يسمح بعكس التحويل');
    }
    const newSrcBal = D(cb.balance).plus(amt);
    tenant.db
      .prepare(`UPDATE cashboxes SET balance = ? WHERE id = ? AND organization_id = ?`)
      .run(newSrcBal.toFixed(2), cb.id, tenant.organizationId);
    tenant.db
      .prepare(`UPDATE cashboxes SET balance = ? WHERE id = ? AND organization_id = ?`)
      .run(newTgtBal.toFixed(2), tgt.id, tenant.organizationId);
    tenant.db
      .prepare(
        `INSERT INTO cashbox_transactions (id, organization_id, cashbox_id, voucher_id, direction, amount, balance_after, created_at)
         VALUES (?, ?, ?, ?, 'IN', ?, ?, ?)`,
      )
      .run(newId('cbt'), tenant.organizationId, cb.id, revVoucherId, amt.toFixed(2), newSrcBal.toFixed(2), nowIso());
    tenant.db
      .prepare(
        `INSERT INTO cashbox_transactions (id, organization_id, cashbox_id, voucher_id, direction, amount, balance_after, created_at)
         VALUES (?, ?, ?, ?, 'OUT', ?, ?, ?)`,
      )
      .run(newId('cbt'), tenant.organizationId, tgt.id, revVoucherId, amt.toFixed(2), newTgtBal.toFixed(2), nowIso());
  }

  tenant.db
    .prepare(
      `INSERT INTO vouchers
       (id, organization_id, voucher_number, voucher_type, cashbox_id, target_cashbox_id, party_id, property_id, reference_type, reference_id, amount, voucher_date, description, status, reversed_voucher_id, journal_entry_id, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REVERSED', ?, ?, ?, ?)`,
    )
    .run(
      revVoucherId,
      tenant.organizationId,
      revNumber,
      vch.voucher_type,
      vch.cashbox_id,
      vch.target_cashbox_id,
      vch.party_id,
      vch.property_id,
      vch.reference_type,
      vch.reference_id,
      amt.toFixed(2),
      vDate,
      `عكس سند ${vch.voucher_number}: ${reason}`,
      vch.id,
      reversalJournalId,
      tenant.userId,
      nowIso(),
    );

  tenant.db
    .prepare(`UPDATE vouchers SET status = 'REVERSED', reversed_voucher_id = ? WHERE id = ? AND organization_id = ?`)
    .run(revVoucherId, vch.id, tenant.organizationId);

  tenant.audit({
    entityType: 'Voucher',
    entityId: vch.id,
    action: 'REVERSE',
    oldValue: { status: 'POSTED' },
    newValue: { status: 'REVERSED', reversalVoucherId: revVoucherId, reason },
  });

  return { reversalVoucherId: revVoucherId, reversalJournalId };
}

// --- FR-EVC-01..08 & FR-DEP-01..07: Eviction, Grace Period, Handover, Settlement ---

export function initiateEvictionAtomic(
  tenant: TenantDb,
  params: {
    agreementId: string;
    reason: string;
    noticeDate: string;
    graceDays?: number;
  },
): { evictionId: string; graceEndDate: string; waivedUnpaidRent: string; advanceRentCredit: string } {
  const ag = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ?`)
      .get(params.agreementId, tenant.organizationId) as any,
    'العقد',
  );
  StateMachines.agreement(ag.status as RentAgreementStatus, RentAgreementStatus.NOTICE);

  const openEv = tenant.db
    .prepare(
      `SELECT id FROM eviction_requests
       WHERE organization_id = ? AND agreement_id = ? AND status NOT IN ('CLOSED', 'CANCELLED')`,
    )
    .get(tenant.organizationId, ag.id);
  if (openEv) {
    throw new HttpError(409, 'يوجد طلب إخلاء مفتوح بالفعل لهذا العقد');
  }

  const org = tenant.getOrg();
  const graceDays = params.graceDays ?? Number(ag.grace_days ?? org.default_grace_days ?? 15);
  const installments = tenant.db
    .prepare(`SELECT * FROM installments WHERE agreement_id = ? AND organization_id = ? ORDER BY installment_number`)
    .all(ag.id, tenant.organizationId) as any[];

  const graceImpact = calculateGracePeriodImpact({
    installments: installments.map((i) => ({
      id: i.id,
      installmentNumber: i.installment_number,
      periodStart: i.period_start,
      periodEnd: i.period_end,
      dueDate: i.due_date,
      amount: i.amount,
      paidAmount: i.paid_amount,
      status: i.status as InstallmentStatus,
    })),
    noticeDate: params.noticeDate,
    graceDays,
  });

  const evictionId = newId('evc');

  // Apply zero-rent during grace period (FR-EVC-03)
  for (const adj of graceImpact.adjustments) {
    const waiveD = D(adj.unpaidWaivedAmount);
    if (waiveD.gt(0)) {
      const inst = installments.find((x) => x.id === adj.installmentId);
      // If accrued in GL, post credit note (Debit 5300 / Credit 1210)
      if (inst.accrual_journal_id) {
        postJournalEntry(tenant, {
          entryDate: params.noticeDate,
          description: `إشعار دائن لإيجار فترة المهلة - قسط #${inst.installment_number}`,
          sourceType: 'GRACE_CREDIT_NOTE',
          sourceId: evictionId,
          propertyId: ag.property_id,
          lines: [
            {
              accountCode: '5300',
              debit: waiveD,
              partyId: ag.tenant_party_id,
              propertyId: ag.property_id,
              memo: 'خصم إيجار مسموح به لفترة المهلة',
            },
            {
              accountCode: '1210',
              credit: waiveD,
              partyId: ag.tenant_party_id,
              propertyId: ag.property_id,
              memo: 'تخفيض ذمم المستأجر لفترة المهلة',
            },
          ],
        });
      }
      const totalWaived = D(inst.waived_amount ?? 0).plus(waiveD);
      const remainingDue = D(inst.amount).minus(inst.paid_amount).minus(totalWaived);
      const nextStatus =
        remainingDue.lte(0) && D(inst.paid_amount).eq(0)
          ? InstallmentStatus.WAIVED
          : remainingDue.lte(0)
            ? InstallmentStatus.PAID
            : (inst.status as InstallmentStatus);

      tenant.db
        .prepare(`UPDATE installments SET waived_amount = ?, status = ? WHERE id = ? AND organization_id = ?`)
        .run(totalWaived.toFixed(2), nextStatus, inst.id, tenant.organizationId);
    }
  }

  tenant.db
    .prepare(
      `INSERT INTO eviction_requests
       (id, organization_id, agreement_id, reason, status, notice_date, grace_days, grace_end_date, advance_rent_credit, waived_unpaid_rent, created_at)
       VALUES (?, ?, ?, ?, 'IN_GRACE', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      evictionId,
      tenant.organizationId,
      ag.id,
      params.reason,
      params.noticeDate,
      graceDays,
      graceImpact.graceEndDate,
      graceImpact.totalAdvanceRentCredit,
      graceImpact.totalWaivedUnpaid,
      nowIso(),
    );

  tenant.db
    .prepare(`UPDATE rent_agreements SET status = 'NOTICE' WHERE id = ? AND organization_id = ?`)
    .run(ag.id, tenant.organizationId);

  // FR-NTF-03: Notify tenant
  const notifId = newId('ntf');
  tenant.db
    .prepare(
      `INSERT INTO notifications (id, organization_id, sender_user_id, title, body, audience_type, audience_target_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'PARTY', ?, ?)`,
    )
    .run(
      notifId,
      tenant.organizationId,
      tenant.userId,
      'إشعار إخلاء ومهلة بلا إيجار',
      `تم تسجيل إشعار إخلاء بتاريخ ${params.noticeDate} مع مهلة ${graceDays} يوماً بلا إيجار حتى تاريخ ${graceImpact.graceEndDate}.`,
      ag.tenant_party_id,
      nowIso(),
    );
  const tUser = tenant.db
    .prepare(`SELECT id FROM users WHERE organization_id = ? AND party_id = ? AND is_active = 1`)
    .get(tenant.organizationId, ag.tenant_party_id) as { id: string } | undefined;
  tenant.db
    .prepare(
      `INSERT INTO notification_recipients (id, organization_id, notification_id, user_id, party_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(newId('nrec'), tenant.organizationId, notifId, tUser?.id ?? null, ag.tenant_party_id);

  tenant.audit({
    entityType: 'EvictionRequest',
    entityId: evictionId,
    action: 'INITIATE',
    newValue: {
      agreementId: ag.id,
      noticeDate: params.noticeDate,
      graceDays,
      graceEndDate: graceImpact.graceEndDate,
      waivedUnpaidRent: graceImpact.totalWaivedUnpaid,
      advanceRentCredit: graceImpact.totalAdvanceRentCredit,
    },
  });

  return {
    evictionId,
    graceEndDate: graceImpact.graceEndDate,
    waivedUnpaidRent: graceImpact.totalWaivedUnpaid,
    advanceRentCredit: graceImpact.totalAdvanceRentCredit,
  };
}

export function completeHandoverAndDraftSettlement(
  tenant: TenantDb,
  params: {
    evictionId: string;
    handoverDate: string;
    keysReturned: boolean;
    tenantAcknowledged: boolean;
    notes?: string;
    finalReadings?: Array<{ meterId: string; reading: string }>;
    damages: Array<{
      description: string;
      cost: string;
      photoAttachmentId: string;
      vendorName?: string;
    }>;
  },
): { inspectionId: string; settlementId: string; netPayable: string } {
  const ev = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM eviction_requests WHERE id = ? AND organization_id = ?`)
      .get(params.evictionId, tenant.organizationId) as any,
    'طلب الإخلاء',
  );
  StateMachines.eviction(ev.status as EvictionStatus, EvictionStatus.HANDED_OVER);

  const ag = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ?`)
      .get(ev.agreement_id, tenant.organizationId) as any,
    'العقد',
  );

  // FR-DEP-02: Every damage item MUST have a photo attachment
  for (const dmg of params.damages) {
    if (!dmg.photoAttachmentId) {
      throw new HttpError(400, 'لا يُخصم بند تلف إلا مع إرفاق صورة موثّقة للتلف');
    }
    tenant.assertOwnedRow(
      tenant.db
        .prepare(`SELECT id, organization_id FROM attachments WHERE id = ? AND organization_id = ?`)
        .get(dmg.photoAttachmentId, tenant.organizationId) as any,
      'صورة التلف',
    );
  }

  const org = tenant.getOrg();
  const installments = tenant.db
    .prepare(`SELECT * FROM installments WHERE agreement_id = ? AND organization_id = ? ORDER BY installment_number`)
    .all(ag.id, tenant.organizationId) as any[];

  // Compute post-grace rent if overdue & enabled (BR-04)
  const graceCheck = calculateGracePeriodImpact({
    installments: installments.map((i) => ({
      id: i.id,
      installmentNumber: i.installment_number,
      periodStart: i.period_start,
      periodEnd: i.period_end,
      dueDate: i.due_date,
      amount: i.amount,
      paidAmount: i.paid_amount,
      status: i.status as InstallmentStatus,
    })),
    noticeDate: ev.notice_date,
    graceDays: ev.grace_days,
    handoverDate: params.handoverDate,
    extendedUntil: ev.extended_until,
    postGraceRentEnabled: Boolean(org.post_grace_rent_enabled),
  });

  const inspectionId = newId('ins');
  tenant.db
    .prepare(
      `INSERT INTO move_out_inspections (id, organization_id, eviction_id, keys_returned, tenant_acknowledged, notes, final_readings_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      inspectionId,
      tenant.organizationId,
      ev.id,
      params.keysReturned ? 1 : 0,
      params.tenantAcknowledged ? 1 : 0,
      params.notes ?? null,
      params.finalReadings ? JSON.stringify(params.finalReadings) : null,
      nowIso(),
    );

  // Create linked Maintenance records for every damage item (FR-DEP-02)
  let damagesTotal = new Decimal(0);
  for (const dmg of params.damages) {
    const costD = D(dmg.cost);
    if (costD.lte(0)) throw new HttpError(400, 'تكلفة التلف يجب أن تكون أكبر من صفر');
    damagesTotal = damagesTotal.plus(costD);

    const maintId = newId('mnt');
    tenant.db
      .prepare(
        `INSERT INTO maintenance_records
         (id, organization_id, property_id, unit_id, agreement_id, maintenance_type, cause, description, cost, paid_amount, charge_to, vendor_name, maintenance_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'تلفيات تسليم', 'TENANT_DAMAGE', ?, ?, '0.00', 'TENANT', ?, ?, 'COMPLETED', ?)`,
      )
      .run(
        maintId,
        tenant.organizationId,
        ag.property_id,
        ag.unit_id,
        ag.id,
        dmg.description,
        costD.toFixed(2),
        dmg.vendorName ?? null,
        params.handoverDate,
        nowIso(),
      );

    tenant.db
      .prepare(
        `INSERT INTO damage_items (id, organization_id, inspection_id, description, cost, maintenance_id, photo_attachment_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('dmg'),
        tenant.organizationId,
        inspectionId,
        dmg.description,
        costD.toFixed(2),
        maintId,
        dmg.photoAttachmentId,
        nowIso(),
      );
  }

  // Record final meter readings if provided
  if (params.finalReadings) {
    for (const fr of params.finalReadings) {
      tenant.db
        .prepare(`UPDATE service_meters SET last_reading = ?, last_reading_date = ? WHERE id = ? AND organization_id = ?`)
        .run(toFixedMoney(fr.reading), params.handoverDate, fr.meterId, tenant.organizationId);
    }
  }

  // Sum unpaid accrued/unwaived rent + post-grace rent
  let unpaidRent = new Decimal(graceCheck.postGraceRentAmount);
  for (const inst of installments) {
    if (inst.status === InstallmentStatus.WAIVED) continue;
    // Accrue any remaining unpaid installment up to handover date so settlement settles clean AR
    const rem = Decimal.max(0, D(inst.amount).minus(inst.paid_amount).minus(inst.waived_amount ?? 0));
    if (rem.gt(0) && inst.due_date <= params.handoverDate) {
      accrueInstallmentIfNeeded(tenant, inst, params.handoverDate);
      unpaidRent = unpaidRent.plus(rem);
    }
  }

  // Sum unpaid service bills for this unit/tenant
  const unpaidBills = tenant.db
    .prepare(
      `SELECT amount, paid_amount FROM service_bills
       WHERE organization_id = ? AND unit_id = ? AND payer_party_id = ? AND status IN ('ISSUED', 'PARTIAL')`,
    )
    .all(tenant.organizationId, ag.unit_id, ag.tenant_party_id) as Array<{ amount: string; paid_amount: string }>;
  let unpaidServices = new Decimal(0);
  for (const b of unpaidBills) {
    unpaidServices = unpaidServices.plus(Decimal.max(0, D(b.amount).minus(b.paid_amount)));
  }

  const dep = tenant.db
    .prepare(`SELECT * FROM security_deposits WHERE agreement_id = ? AND organization_id = ?`)
    .get(ag.id, tenant.organizationId) as any;

  const heldDeposit = dep ? dep.held_balance : '0.00';

  const settlementCalc = calculateSettlement({
    heldDeposit,
    advanceRentCredit: ev.advance_rent_credit,
    damagesTotal: damagesTotal.toFixed(2),
    unpaidRentTotal: unpaidRent.toFixed(2),
    unpaidServicesTotal: unpaidServices.toFixed(2),
  });

  const settlementId = newId('stl');
  tenant.db
    .prepare(
      `INSERT INTO settlement_statements
       (id, organization_id, eviction_id, agreement_id, held_deposit, advance_rent_credit, damages_total, unpaid_rent_total, unpaid_services_total, net_payable, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)`,
    )
    .run(
      settlementId,
      tenant.organizationId,
      ev.id,
      ag.id,
      settlementCalc.heldDeposit,
      settlementCalc.advanceRentCredit,
      settlementCalc.damagesTotal,
      settlementCalc.unpaidRentTotal,
      settlementCalc.unpaidServicesTotal,
      settlementCalc.netPayable,
      nowIso(),
    );

  // FR-EVC-07: Unit becomes vacant (since contract moves from active/notice on handover) and actual_end_date is set,
  // while contract stays NOTICE until settlement is posted! Wait: FR-EVC-07 says:
  // "عند التسليم تصبح الوحدة شاغرة ويُسجَّل تاريخ الانتهاء الفعلي. لا يُغلق العقد قبل اعتماد التسوية."
  // And unit status derives from rent_agreements status IN ('ACTIVE','NOTICE') or we check if handover_date is set!
  tenant.db
    .prepare(
      `UPDATE eviction_requests SET status = 'HANDED_OVER', handover_date = ?, post_grace_rent = ? WHERE id = ? AND organization_id = ?`,
    )
    .run(params.handoverDate, graceCheck.postGraceRentAmount, ev.id, tenant.organizationId);

  tenant.db
    .prepare(`UPDATE rent_agreements SET actual_end_date = ? WHERE id = ? AND organization_id = ?`)
    .run(params.handoverDate, ag.id, tenant.organizationId);

  tenant.audit({
    entityType: 'EvictionRequest',
    entityId: ev.id,
    action: 'HANDOVER_AND_DRAFT_SETTLEMENT',
    newValue: { handoverDate: params.handoverDate, settlementId, netPayable: settlementCalc.netPayable },
  });

  return {
    inspectionId,
    settlementId,
    netPayable: settlementCalc.netPayable,
  };
}

export function approveAndPostSettlement(
  tenant: TenantDb,
  settlementId: string,
  cashboxId: string,
): { journalEntryId: string; status: string } {
  const stl = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM settlement_statements WHERE id = ? AND organization_id = ?`)
      .get(settlementId, tenant.organizationId) as any,
    'كشف التسوية',
  );
  StateMachines.settlement(stl.status as any, 'APPROVED' as any);
  StateMachines.settlement('APPROVED' as any, 'POSTED' as any);

  const ev = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM eviction_requests WHERE id = ? AND organization_id = ?`)
      .get(stl.eviction_id, tenant.organizationId) as any,
    'طلب الإخلاء',
  );
  const ag = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM rent_agreements WHERE id = ? AND organization_id = ?`)
      .get(stl.agreement_id, tenant.organizationId) as any,
    'العقد',
  );
  const dep = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM security_deposits WHERE agreement_id = ? AND organization_id = ?`)
      .get(ag.id, tenant.organizationId) as any,
    'التأمين',
  );
  const cashbox = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM cashboxes WHERE id = ? AND organization_id = ?`)
      .get(cashboxId, tenant.organizationId) as any,
    'الصندوق',
  );

  const calc = calculateSettlement({
    heldDeposit: stl.held_deposit,
    advanceRentCredit: stl.advance_rent_credit,
    damagesTotal: stl.damages_total,
    unpaidRentTotal: stl.unpaid_rent_total,
    unpaidServicesTotal: stl.unpaid_services_total,
  });

  const postDate = ev.handover_date ?? todayIso();
  const journalLines: Array<{
    accountCode: string;
    debit?: Decimal;
    credit?: Decimal;
    partyId?: string;
    propertyId?: string;
    memo?: string;
  }> = [];

  // Record deposit deductions
  const usedRent = D(calc.depositUsedForRent);
  const usedSvc = D(calc.depositUsedForServices);
  const usedDmg = D(calc.depositUsedForDamages);
  const totalDeductedFromDep = usedRent.plus(usedSvc).plus(usedDmg);
  const remainingDepToRefund = D(stl.held_deposit).minus(totalDeductedFromDep);

  if (usedRent.gt(0)) {
    tenant.db
      .prepare(
        `INSERT INTO deposit_movements (id, organization_id, deposit_id, movement_type, amount, reference_type, reference_id, notes, created_at)
         VALUES (?, ?, ?, 'RENT_DEDUCTION', ?, 'SETTLEMENT', ?, 'خصم إيجار مستحق في التسوية', ?)`,
      )
      .run(newId('dmv'), tenant.organizationId, dep.id, usedRent.toFixed(2), stl.id, nowIso());
    journalLines.push({
      accountCode: '2110',
      debit: usedRent,
      partyId: ag.tenant_party_id,
      propertyId: ag.property_id,
      memo: 'خصم إيجار من التأمين',
    });
    journalLines.push({
      accountCode: '1210',
      credit: usedRent,
      partyId: ag.tenant_party_id,
      propertyId: ag.property_id,
      memo: 'تسوية إيجار مستحق',
    });
  }

  if (usedSvc.gt(0)) {
    tenant.db
      .prepare(
        `INSERT INTO deposit_movements (id, organization_id, deposit_id, movement_type, amount, reference_type, reference_id, notes, created_at)
         VALUES (?, ?, ?, 'SERVICE_DEDUCTION', ?, 'SETTLEMENT', ?, 'خصم خدمات مستحقة في التسوية', ?)`,
      )
      .run(newId('dmv'), tenant.organizationId, dep.id, usedSvc.toFixed(2), stl.id, nowIso());
    journalLines.push({
      accountCode: '2110',
      debit: usedSvc,
      partyId: ag.tenant_party_id,
      propertyId: ag.property_id,
      memo: 'خصم خدمات من التأمين',
    });
    journalLines.push({
      accountCode: '1210',
      credit: usedSvc,
      partyId: ag.tenant_party_id,
      propertyId: ag.property_id,
      memo: 'تسوية فواتير خدمات',
    });
  }

  if (usedDmg.gt(0)) {
    tenant.db
      .prepare(
        `INSERT INTO deposit_movements (id, organization_id, deposit_id, movement_type, amount, reference_type, reference_id, notes, created_at)
         VALUES (?, ?, ?, 'DAMAGE_DEDUCTION', ?, 'SETTLEMENT', ?, 'خصم تلفيات من التأمين', ?)`,
      )
      .run(newId('dmv'), tenant.organizationId, dep.id, usedDmg.toFixed(2), stl.id, nowIso());
    journalLines.push({
      accountCode: '2110',
      debit: usedDmg,
      partyId: ag.tenant_party_id,
      propertyId: ag.property_id,
      memo: 'خصم تلفيات من التأمين',
    });
    journalLines.push({
      accountCode: '4300',
      credit: usedDmg,
      partyId: ag.tenant_party_id,
      propertyId: ag.property_id,
      memo: 'استرداد تلفيات من المستأجر',
    });
  }

  // Excess damages beyond deposit -> AR on tenant (Section 8.2)
  const excessDmg = D(calc.excessDamagesBeyondDeposit);
  if (excessDmg.gt(0)) {
    journalLines.push({
      accountCode: '1210',
      debit: excessDmg,
      partyId: ag.tenant_party_id,
      propertyId: ag.property_id,
      memo: 'تلفيات تتجاوز رصيد التأمين',
    });
    journalLines.push({
      accountCode: '4300',
      credit: excessDmg,
      partyId: ag.tenant_party_id,
      propertyId: ag.property_id,
      memo: 'استرداد تلفيات إضافية من المستأجر',
    });
  }

  // Refund remaining held deposit (and advance rent credit if positive net)
  const advanceCredit = D(stl.advance_rent_credit);
  if (advanceCredit.gt(0)) {
    journalLines.push({
      accountCode: '5300',
      debit: advanceCredit,
      partyId: ag.tenant_party_id,
      propertyId: ag.property_id,
      memo: 'رد رصيد إيجار مدفوع مقدماً عن فترة المهلة',
    });
    journalLines.push({
      accountCode: cashbox.account_code,
      credit: advanceCredit,
      partyId: ag.tenant_party_id,
      propertyId: ag.property_id,
      memo: 'صرف رصيد إيجار مقدم',
    });
  }

  if (remainingDepToRefund.gt(0)) {
    const cbBal = D(cashbox.balance);
    if (cbBal.lt(remainingDepToRefund.plus(advanceCredit))) {
      throw new HttpError(
        400,
        `رصيد الصندوق (${cbBal.toFixed(2)}) غير كافٍ لصرف صافي التسوية (${remainingDepToRefund.plus(advanceCredit).toFixed(2)})`,
      );
    }
    tenant.db
      .prepare(
        `INSERT INTO deposit_movements (id, organization_id, deposit_id, movement_type, amount, reference_type, reference_id, notes, created_at)
         VALUES (?, ?, ?, 'REFUNDED', ?, 'SETTLEMENT', ?, 'رد المتبقي من التأمين عند التسوية', ?)`,
      )
      .run(newId('dmv'), tenant.organizationId, dep.id, remainingDepToRefund.toFixed(2), stl.id, nowIso());
    journalLines.push({
      accountCode: '2110',
      debit: remainingDepToRefund,
      partyId: ag.tenant_party_id,
      propertyId: ag.property_id,
      memo: 'رد صافي التأمين للمستأجر',
    });
    journalLines.push({
      accountCode: cashbox.account_code,
      credit: remainingDepToRefund,
      partyId: ag.tenant_party_id,
      propertyId: ag.property_id,
      memo: 'صرف رد التأمين',
    });
  }

  // Update cashbox if any cash payout occurred
  const totalCashRefund = remainingDepToRefund.plus(advanceCredit);
  if (totalCashRefund.gt(0)) {
    const seq = tenant.nextSequence('voucher_seq');
    const vNum = `PV-${String(seq).padStart(5, '0')}`;
    const vId = newId('vch');
    const newBal = D(cashbox.balance).minus(totalCashRefund);
    if (newBal.lt(0)) {
      throw new HttpError(400, 'رصيد الصندوق غير كافٍ لصرف مبلغ التسوية');
    }

    const jeId = postJournalEntry(tenant, {
      entryDate: postDate,
      description: `ترحيل كشف تسوية الإخلاء وصرف الصافي`,
      sourceType: 'SETTLEMENT_POSTING',
      sourceId: stl.id,
      propertyId: ag.property_id,
      lines: journalLines,
    });

    tenant.db
      .prepare(
        `INSERT INTO vouchers
         (id, organization_id, voucher_number, voucher_type, cashbox_id, party_id, property_id, reference_type, reference_id, amount, voucher_date, description, status, journal_entry_id, created_by_user_id, created_at)
         VALUES (?, ?, ?, 'PAYMENT', ?, ?, ?, 'SETTLEMENT', ?, ?, ?, 'سند صرف تسوية إخلاء', 'POSTED', ?, ?, ?)`,
      )
      .run(
        vId,
        tenant.organizationId,
        vNum,
        cashbox.id,
        ag.tenant_party_id,
        ag.property_id,
        stl.id,
        totalCashRefund.toFixed(2),
        postDate,
        jeId,
        tenant.userId,
        nowIso(),
      );

    tenant.db
      .prepare(`UPDATE cashboxes SET balance = ? WHERE id = ? AND organization_id = ?`)
      .run(newBal.toFixed(2), cashbox.id, tenant.organizationId);
    tenant.db
      .prepare(
        `INSERT INTO cashbox_transactions (id, organization_id, cashbox_id, voucher_id, direction, amount, balance_after, created_at)
         VALUES (?, ?, ?, ?, 'OUT', ?, ?, ?)`,
      )
      .run(newId('cbt'), tenant.organizationId, cashbox.id, vId, totalCashRefund.toFixed(2), newBal.toFixed(2), nowIso());

    finalizeSettlementDb(tenant, stl, ev, ag, dep, jeId);
    return { journalEntryId: jeId, status: 'POSTED' };
  }

  // Zero cash payout case (all deposit applied or deficit)
  const jeId =
    journalLines.length >= 2
      ? postJournalEntry(tenant, {
          entryDate: postDate,
          description: `ترحيل كشف تسوية الإخلاء`,
          sourceType: 'SETTLEMENT_POSTING',
          sourceId: stl.id,
          propertyId: ag.property_id,
          lines: journalLines,
        })
      : '';

  finalizeSettlementDb(tenant, stl, ev, ag, dep, jeId);
  return { journalEntryId: jeId, status: 'POSTED' };
}

function finalizeSettlementDb(
  tenant: TenantDb,
  stl: any,
  ev: any,
  ag: any,
  dep: any,
  jeId: string,
): void {
  // Mark settled bills & installments covered by deposit deduction
  // Ensure deposit held balance === 0 after settlement (FR-DEP-07)
  const moves = tenant.db
    .prepare(`SELECT movement_type AS type, amount FROM deposit_movements WHERE deposit_id = ? AND organization_id = ?`)
    .all(dep.id, tenant.organizationId) as any[];
  const depBal = calculateDepositBalance(moves);

  tenant.db
    .prepare(
      `UPDATE security_deposits SET held_balance = ?, status = 'REFUNDED' WHERE id = ? AND organization_id = ?`,
    )
    .run(depBal.heldBalance, dep.id, tenant.organizationId);

  // Mark installments/bills settled up to depositUsedForRent / depositUsedForServices so AR subledger stays 100% synced
  const calc = calculateSettlement({
    heldDeposit: stl.held_deposit,
    advanceRentCredit: stl.advance_rent_credit,
    damagesTotal: stl.damages_total,
    unpaidRentTotal: stl.unpaid_rent_total,
    unpaidServicesTotal: stl.unpaid_services_total,
  });

  let remRentToSettle = D(calc.depositUsedForRent);
  if (remRentToSettle.gt(0)) {
    const insts = tenant.db
      .prepare(
        `SELECT * FROM installments WHERE agreement_id = ? AND organization_id = ? AND status IN ('PENDING','PARTIAL') ORDER BY installment_number`,
      )
      .all(ag.id, tenant.organizationId) as any[];
    for (const i of insts) {
      if (remRentToSettle.lte(0)) break;
      const due = Decimal.max(0, D(i.amount).minus(i.paid_amount).minus(i.waived_amount ?? 0));
      const apply = Decimal.min(due, remRentToSettle);
      if (apply.gt(0)) {
        const newPaid = D(i.paid_amount).plus(apply);
        const st = newPaid.gte(D(i.amount).minus(i.waived_amount ?? 0)) ? 'PAID' : 'PARTIAL';
        tenant.db
          .prepare(`UPDATE installments SET paid_amount = ?, status = ? WHERE id = ? AND organization_id = ?`)
          .run(newPaid.toFixed(2), st, i.id, tenant.organizationId);
        remRentToSettle = remRentToSettle.minus(apply);
      }
    }
  }

  let remSvcToSettle = D(calc.depositUsedForServices);
  if (remSvcToSettle.gt(0)) {
    const bills = tenant.db
      .prepare(
        `SELECT * FROM service_bills WHERE unit_id = ? AND payer_party_id = ? AND organization_id = ? AND status IN ('ISSUED','PARTIAL')`,
      )
      .all(ag.unit_id, ag.tenant_party_id, tenant.organizationId) as any[];
    for (const b of bills) {
      if (remSvcToSettle.lte(0)) break;
      const due = Decimal.max(0, D(b.amount).minus(b.paid_amount));
      const apply = Decimal.min(due, remSvcToSettle);
      if (apply.gt(0)) {
        const newPaid = D(b.paid_amount).plus(apply);
        const st = newPaid.gte(D(b.amount)) ? 'PAID' : 'PARTIAL';
        tenant.db
          .prepare(`UPDATE service_bills SET paid_amount = ?, status = ? WHERE id = ? AND organization_id = ?`)
          .run(newPaid.toFixed(2), st, b.id, tenant.organizationId);
        remSvcToSettle = remSvcToSettle.minus(apply);
      }
    }
  }

  // Sync handover damage maintenance records with GL 1210 & 4300
  const insp = tenant.db
    .prepare(`SELECT id FROM move_out_inspections WHERE eviction_id = ? AND organization_id = ?`)
    .get(ev.id, tenant.organizationId) as { id: string } | undefined;
  if (insp) {
    const dmgMaintRows = tenant.db
      .prepare(
        `SELECT m.* FROM damage_items d
         JOIN maintenance_records m ON m.id = d.maintenance_id
         WHERE d.inspection_id = ? AND d.organization_id = ?`,
      )
      .all(insp.id, tenant.organizationId) as any[];
    let remDmgPaidByDep = D(calc.depositUsedForDamages);
    for (const m of dmgMaintRows) {
      const mCost = D(m.cost);
      const paidByDep = Decimal.min(mCost, remDmgPaidByDep);
      remDmgPaidByDep = remDmgPaidByDep.minus(paidByDep);
      tenant.db
        .prepare(
          `UPDATE maintenance_records SET paid_amount = ?, journal_entry_id = ? WHERE id = ? AND organization_id = ?`,
        )
        .run(paidByDep.toFixed(2), jeId || null, m.id, tenant.organizationId);
    }
  }

  tenant.db
    .prepare(
      `UPDATE settlement_statements SET status = 'POSTED', approved_by_user_id = ?, approved_at = ?, journal_entry_id = ? WHERE id = ? AND organization_id = ?`,
    )
    .run(tenant.userId, nowIso(), jeId || null, stl.id, tenant.organizationId);

  StateMachines.eviction(ev.status as EvictionStatus, EvictionStatus.SETTLED);
  StateMachines.eviction(EvictionStatus.SETTLED, EvictionStatus.CLOSED);
  tenant.db
    .prepare(`UPDATE eviction_requests SET status = 'CLOSED' WHERE id = ? AND organization_id = ?`)
    .run(ev.id, tenant.organizationId);

  StateMachines.agreement(ag.status as RentAgreementStatus, RentAgreementStatus.CLOSED);
  tenant.db
    .prepare(`UPDATE rent_agreements SET status = 'CLOSED' WHERE id = ? AND organization_id = ?`)
    .run(ag.id, tenant.organizationId);

  // FR-NTF-03: Notify tenant of approved settlement
  const notifId = newId('ntf');
  tenant.db
    .prepare(
      `INSERT INTO notifications (id, organization_id, sender_user_id, title, body, audience_type, audience_target_id, created_at)
       VALUES (?, ?, ?, 'اعتماد كشف تسوية الإخلاء', ?, 'PARTY', ?, ?)`,
    )
    .run(
      notifId,
      tenant.organizationId,
      tenant.userId,
      `تم اعتماد وترحيل كشف التسوية النهائي. الصافي: ${stl.net_payable}`,
      ag.tenant_party_id,
      nowIso(),
    );
  const tUser = tenant.db
    .prepare(`SELECT id FROM users WHERE organization_id = ? AND party_id = ? AND is_active = 1`)
    .get(tenant.organizationId, ag.tenant_party_id) as { id: string } | undefined;
  tenant.db
    .prepare(
      `INSERT INTO notification_recipients (id, organization_id, notification_id, user_id, party_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(newId('nrec'), tenant.organizationId, notifId, tUser?.id ?? null, ag.tenant_party_id);

  tenant.audit({
    entityType: 'SettlementStatement',
    entityId: stl.id,
    action: 'APPROVE_AND_POST',
    newValue: { status: 'POSTED', depositHeldAfter: depBal.heldBalance },
  });
}
