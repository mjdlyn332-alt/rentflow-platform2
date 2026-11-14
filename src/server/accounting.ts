import Database from 'better-sqlite3';
import Decimal from 'decimal.js';
import { D, toFixedMoney } from '../domain/money';
import { ChartAccountType } from '../domain/types';
import { HttpError, newId, nowIso, TenantDb } from './db';

export const DEFAULT_CHART_ACCOUNTS: Array<{
  code: string;
  name: string;
  type: ChartAccountType;
}> = [
  // Assets
  { code: '1110', name: 'الصندوق الرئيسي', type: ChartAccountType.ASSET },
  { code: '1120', name: 'صناديق المحصلين', type: ChartAccountType.ASSET },
  { code: '1130', name: 'البنوك', type: ChartAccountType.ASSET },
  { code: '1210', name: 'ذمم المستأجرين', type: ChartAccountType.ASSET },
  { code: '1220', name: 'ذمم ملاك الوحدات', type: ChartAccountType.ASSET },
  // Liabilities
  { code: '2110', name: 'التأمينات المحتجزة', type: ChartAccountType.LIABILITY },
  { code: '2120', name: 'الدائنون', type: ChartAccountType.LIABILITY },
  // Revenue
  { code: '4100', name: 'إيراد الإيجار', type: ChartAccountType.REVENUE },
  { code: '4200', name: 'إيراد خدمات مستردة', type: ChartAccountType.REVENUE },
  { code: '4300', name: 'استرداد صيانة من المستأجرين', type: ChartAccountType.REVENUE },
  { code: '4400', name: 'إيراد غرامات وتعويضات ورسوم', type: ChartAccountType.REVENUE },
  // Expenses
  { code: '5100', name: 'مصروف الصيانة', type: ChartAccountType.EXPENSE },
  { code: '5200', name: 'مصروف الخدمات', type: ChartAccountType.EXPENSE },
  { code: '5300', name: 'خصم الإيجار المسموح به', type: ChartAccountType.EXPENSE },
  { code: '5400', name: 'رواتب الحراس', type: ChartAccountType.EXPENSE },
  { code: '5500', name: 'مكافآت المحصلين', type: ChartAccountType.EXPENSE },
];

export const DEFAULT_POSTING_RULES: Array<{
  docType: string;
  debitCode: string;
  creditCode: string;
  description: string;
}> = [
  { docType: 'INSTALLMENT_ACCRUAL', debitCode: '1210', creditCode: '4100', description: 'استحقاق قسط الإيجار' },
  { docType: 'RENT_RECEIPT', debitCode: '1110', creditCode: '1210', description: 'سند قبض إيجار' },
  { docType: 'SERVICE_BILL_TENANT', debitCode: '1210', creditCode: '4200', description: 'فاتورة خدمة على مستأجر' },
  { docType: 'SERVICE_BILL_UNIT_OWNER', debitCode: '1220', creditCode: '4200', description: 'فاتورة خدمة على مالك وحدة' },
  { docType: 'SERVICE_BILL_OWNER_EXPENSE', debitCode: '5200', creditCode: '2120', description: 'تكلفة خدمة على المالك' },
  { docType: 'SERVICE_RECEIPT_TENANT', debitCode: '1110', creditCode: '1210', description: 'سند قبض خدمة من مستأجر' },
  { docType: 'SERVICE_RECEIPT_UNIT_OWNER', debitCode: '1110', creditCode: '1220', description: 'سند قبض خدمة من مالك وحدة' },
  { docType: 'MAINTENANCE_EXPENSE', debitCode: '5100', creditCode: '1110', description: 'فاتورة صيانة' },
  { docType: 'MAINTENANCE_TENANT_RECOVERY', debitCode: '1210', creditCode: '4300', description: 'تحميل صيانة على المستأجر' },
  { docType: 'DEPOSIT_RECEIPT', debitCode: '1110', creditCode: '2110', description: 'استلام تأمين مستأجر' },
  { docType: 'GRACE_CREDIT_NOTE', debitCode: '5300', creditCode: '1210', description: 'إشعار دائن لإيجار فترة المهلة' },
  { docType: 'DEPOSIT_DAMAGE_DEDUCTION', debitCode: '2110', creditCode: '4300', description: 'خصم تلف من التأمين' },
  { docType: 'DEPOSIT_AR_DEDUCTION', debitCode: '2110', creditCode: '1210', description: 'خصم إيجار أو خدمات مستحقة من التأمين' },
  { docType: 'DEPOSIT_EXCESS_DAMAGE', debitCode: '1210', creditCode: '4300', description: 'تلف يتجاوز رصيد التأمين' },
  { docType: 'DEPOSIT_REFUND', debitCode: '2110', creditCode: '1110', description: 'رد صافي التأمين للمستأجر' },
  { docType: 'DEPOSIT_FORFEIT', debitCode: '2110', creditCode: '4400', description: 'مصادرة التأمين لإخلال بالعقد' },
  { docType: 'GUARD_SALARY', debitCode: '5400', creditCode: '1110', description: 'مصروف راتب الحارس' },
  { docType: 'COLLECTOR_REWARD', debitCode: '5500', creditCode: '1110', description: 'مصروف مكافأة المحصل' },
  { docType: 'CASHBOX_HANDOVER', debitCode: '1110', creditCode: '1120', description: 'تحويل صندوق المحصل إلى الرئيسي' },
];

export function seedOrganizationAccounting(db: Database.Database, organizationId: string, year = 2026): void {
  const insertAcc = db.prepare(
    `INSERT OR IGNORE INTO chart_accounts (id, organization_id, code, name, account_type, is_system)
     VALUES (?, ?, ?, ?, ?, 1)`,
  );
  for (const acc of DEFAULT_CHART_ACCOUNTS) {
    insertAcc.run(newId('acc'), organizationId, acc.code, acc.name, acc.type);
  }

  const insertRule = db.prepare(
    `INSERT OR IGNORE INTO posting_rules (id, organization_id, doc_type, debit_account_code, credit_account_code, description)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const r of DEFAULT_POSTING_RULES) {
    insertRule.run(newId('pr'), organizationId, r.docType, r.debitCode, r.creditCode, r.description);
  }

  // Default main cashbox + bank cashbox
  db.prepare(
    `INSERT OR IGNORE INTO cashboxes (id, organization_id, name, cashbox_type, account_code, balance, is_active, created_at)
     VALUES (?, ?, 'الصندوق الرئيسي', 'MAIN', '1110', '0.00', 1, ?)`,
  ).run(newId('cb'), organizationId, nowIso());

  db.prepare(
    `INSERT OR IGNORE INTO cashboxes (id, organization_id, name, cashbox_type, account_code, balance, is_active, created_at)
     VALUES (?, ?, 'الحساب البنكي الرئيسي', 'BANK', '1130', '0.00', 1, ?)`,
  ).run(newId('cb'), organizationId, nowIso());

  // Default open accounting period
  db.prepare(
    `INSERT OR IGNORE INTO accounting_periods (id, organization_id, name, start_date, end_date, is_closed)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(newId('per'), organizationId, `السنة المالية ${year}`, `${year}-01-01`, `${year}-12-31`);

  // Default contract expense types
  const insertExp = db.prepare(
    `INSERT OR IGNORE INTO contract_expense_types (id, organization_id, name, calc_mode, default_value, default_charge_to, is_mandatory, account_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertExp.run(newId('cet'), organizationId, 'رسوم تسجيل العقد', 'FIXED', '250.00', 'TENANT', 0, '4400');
  insertExp.run(newId('cet'), organizationId, 'ضريبة القيمة المضافة', 'PERCENTAGE', '15.00', 'TENANT', 0, '2120');

  // Default maintenance types (FR-MNT-02)
  const insertMaintType = db.prepare(
    `INSERT OR IGNORE INTO maintenance_types (id, organization_id, name, default_charge_to, default_cause)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insertMaintType.run(newId('mt'), organizationId, 'سباكة وتمديدات مياه', 'OWNER', 'NORMAL');
  insertMaintType.run(newId('mt'), organizationId, 'كهرباء وتكييف', 'OWNER', 'NORMAL');
  insertMaintType.run(newId('mt'), organizationId, 'مصاعد ومرافق عامة', 'SHARED', 'NORMAL');
  insertMaintType.run(newId('mt'), organizationId, 'إصلاح تلف ناتج عن سوء استخدام', 'TENANT', 'TENANT_DAMAGE');

  // Default contract print template (FR-CTR-11)
  const existingTpl = db
    .prepare(`SELECT id FROM contract_templates WHERE organization_id = ? LIMIT 1`)
    .get(organizationId);
  if (!existingTpl) {
    const defaultContractBody = `عقد إيجار عقاري موثّق
المنشأة المؤجِّرة / المدير: {{orgName}}
التاريخ: {{createdDate}}

أولاً: بيانات العقار والوحدة:
العقار: {{propertyName}} — العنوان: {{propertyAddress}}
رقم الوحدة: {{unitNumber}} ({{unitType}}) — المساحة: {{areaSqm}} م²

ثانياً: بيانات المستأجر (الطرف الثاني):
الاسم الكامل: {{tenantName}}
رقم الهوية / السجل: {{tenantNationalId}} — رقم الجوال: {{tenantPhone}}

ثالثاً: مدة العقد والقيمة المالية:
تاريخ بدء العقد: {{startDate}}  —  تاريخ انتهاء العقد: {{endDate}}
إجمالي قيمة الإيجار: {{totalAmount}} — الخصم: {{discountAmount}} — الصافي: {{netTotal}}
دورية السداد: {{frequencyLabel}}
مبلغ التأمين المسترد (وديعة محتجزة): {{depositAmount}}
فترة المهلة عند الإخلاء (بلا إيجار): {{graceDays}} يوماً

رابعاً: الشروط والأحكام العامة:
1. يلتزم الطرف الثاني بسداد الأقساط المستحقة وفواتير الخدمات التابعة للوحدة في مواعيدها المحددة.
2. يُسلَّم العقار للمستأجر بالحالة الموثقة في صور الدخول، ويلتزم بردّه بالحالة ذاتها عند الإخلاء.
3. يُحفظ مبلغ التأمين لدى المنشأة كالتزام مسترد وتُجرى بشأنه تسوية نهائية موثقة عند تسليم الوحدة.`;

    db.prepare(
      `INSERT INTO contract_templates (id, organization_id, name, body_template, is_default, updated_at)
       VALUES (?, ?, 'قالب عقد الإيجار القياسي', ?, 1, ?)`,
    ).run(newId('ctpl'), organizationId, defaultContractBody, nowIso());
  }

  // Default notification templates (FR-NTF-05)
  const insertNtfTpl = db.prepare(
    `INSERT OR IGNORE INTO notification_templates (id, organization_id, code, name, title_template, body_template, channel, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'IN_APP_EMAIL', ?)`,
  );
  const ts = nowIso();
  insertNtfTpl.run(newId('ntpl'), organizationId, 'DUE_REMINDER', 'تذكير بقسط قريب الاستحقاق', 'تذكير باستحقاق قسط إيجار وحدة {{unitNumber}}', 'نود تذكيركم بقرب موعد استحقاق القسط بمبلغ {{amount}} بتاريخ {{dueDate}}.', ts);
  insertNtfTpl.run(newId('ntpl'), organizationId, 'MAINTENANCE_NOTICE', 'إشعار صيانة دورية', 'إشعار صيانة في {{propertyName}}', 'نعلمكم بتنفيذ أعمال صيانة في {{propertyName}} بتاريخ {{date}}.', ts);
  insertNtfTpl.run(newId('ntpl'), organizationId, 'GENERAL_NOTICE', 'إشعار إداري عام', 'تنبيه من إدارة {{orgName}}', 'السادة المستأجرين وملاك الوحدات، نحيطكم علماً بالتحديثات الجديدة.', ts);
}

export interface JournalLineInput {
  accountCode: string;
  debit?: string | number | Decimal;
  credit?: string | number | Decimal;
  partyId?: string | null;
  propertyId?: string | null;
  memo?: string;
}

export function postJournalEntry(
  tenant: TenantDb,
  params: {
    entryDate: string;
    description: string;
    sourceType: string;
    sourceId: string;
    propertyId?: string | null;
    isManual?: boolean;
    lines: JournalLineInput[];
  },
): string {
  if (params.lines.length < 2) {
    throw new HttpError(400, 'القيد المحاسبي يجب أن يحتوي على طرفين على الأقل');
  }

  // FR-ACC-06: Reject posting to closed accounting periods
  const closedPeriod = tenant.db
    .prepare(
      `SELECT name FROM accounting_periods
       WHERE organization_id = ? AND is_closed = 1 AND start_date <= ? AND end_date >= ?`,
    )
    .get(tenant.organizationId, params.entryDate, params.entryDate) as { name: string } | undefined;
  if (closedPeriod) {
    throw new HttpError(400, `لا يمكن الترحيل إلى فترة محاسبية مقفلة (${closedPeriod.name})`);
  }

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);

  const checkAcc = tenant.db.prepare(
    `SELECT code FROM chart_accounts WHERE organization_id = ? AND code = ?`,
  );

  const normalizedLines = params.lines.map((l) => {
    const acc = checkAcc.get(tenant.organizationId, l.accountCode);
    if (!acc) {
      throw new HttpError(400, `رمز الحساب غير موجود في شجرة الحسابات: ${l.accountCode}`);
    }
    const deb = D(l.debit ?? 0);
    const cred = D(l.credit ?? 0);
    if (deb.lt(0) || cred.lt(0)) {
      throw new HttpError(400, 'لا يمكن أن تكون قيم المدين أو الدائن سالبة');
    }
    if (deb.gt(0) && cred.gt(0)) {
      throw new HttpError(400, 'السطر المحاسبي لا يجمع بين مدين ودائن في آن واحد');
    }
    if (deb.eq(0) && cred.eq(0)) {
      throw new HttpError(400, 'يجب أن يحتوي السطر المحاسبي على قيمة غير صفرية');
    }
    totalDebit = totalDebit.plus(deb);
    totalCredit = totalCredit.plus(cred);
    return {
      accountCode: l.accountCode,
      debit: toFixedMoney(deb),
      credit: toFixedMoney(cred),
      partyId: l.partyId ?? null,
      propertyId: l.propertyId ?? params.propertyId ?? null,
      memo: l.memo ?? null,
    };
  });

  if (!totalDebit.toDecimalPlaces(2).equals(totalCredit.toDecimalPlaces(2))) {
    throw new HttpError(
      400,
      `القيد غير متوازن: المدين (${totalDebit.toFixed(2)}) ≠ الدائن (${totalCredit.toFixed(2)})`,
    );
  }

  const seq = tenant.nextSequence('journal_seq');
  const entryNumber = `JE-${String(seq).padStart(5, '0')}`;
  const entryId = newId('je');

  tenant.db
    .prepare(
      `INSERT INTO journal_entries (id, organization_id, entry_number, entry_date, description, source_type, source_id, property_id, is_manual, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entryId,
      tenant.organizationId,
      entryNumber,
      params.entryDate,
      params.description,
      params.sourceType,
      params.sourceId,
      params.propertyId ?? null,
      params.isManual ? 1 : 0,
      tenant.userId,
      nowIso(),
    );

  const insertLine = tenant.db.prepare(
    `INSERT INTO journal_lines (id, organization_id, journal_entry_id, account_code, party_id, property_id, debit, credit, memo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const line of normalizedLines) {
    insertLine.run(
      newId('jl'),
      tenant.organizationId,
      entryId,
      line.accountCode,
      line.partyId,
      line.propertyId,
      line.debit,
      line.credit,
      line.memo,
    );
  }

  return entryId;
}

export function reverseJournalEntry(
  tenant: TenantDb,
  originalEntryId: string,
  reversalDate: string,
  reason: string,
  sourceType = 'REVERSAL',
  sourceId?: string,
): string {
  const original = tenant.assertOwnedRow(
    tenant.db
      .prepare(`SELECT * FROM journal_entries WHERE id = ? AND organization_id = ?`)
      .get(originalEntryId, tenant.organizationId) as any,
    'القيد المحاسبي',
  );
  if (original.reversed_entry_id) {
    throw new HttpError(400, 'هذا القيد معكوس مسبقاً');
  }

  const lines = tenant.db
    .prepare(`SELECT * FROM journal_lines WHERE journal_entry_id = ? AND organization_id = ?`)
    .all(originalEntryId, tenant.organizationId) as any[];

  const reversedEntryId = postJournalEntry(tenant, {
    entryDate: reversalDate,
    description: `عكس قيد ${original.entry_number}: ${reason}`,
    sourceType,
    sourceId: sourceId ?? originalEntryId,
    propertyId: original.property_id,
    lines: lines.map((l) => ({
      accountCode: l.account_code,
      debit: l.credit,
      credit: l.debit,
      partyId: l.party_id,
      propertyId: l.property_id,
      memo: `عكس: ${l.memo ?? original.description}`,
    })),
  });

  tenant.db
    .prepare(`UPDATE journal_entries SET reversed_entry_id = ? WHERE id = ? AND organization_id = ?`)
    .run(reversedEntryId, originalEntryId, tenant.organizationId);

  return reversedEntryId;
}

// --- Section 8.3 & FR-ACC-09: Automated Sub-Ledger Reconciliation ---

export interface ReconciliationReport {
  isBalanced: boolean;
  trialBalance: { totalDebit: string; totalCredit: string; diff: string; passed: boolean };
  receivables: {
    subLedgerTotal: string;
    unpaidInstallments: string;
    unpaidTenantBills: string;
    unpaidUnitOwnerBills: string;
    unpaidTenantMaint: string;
    unpaidContractExpenses: string;
    glArBalance: string;
    diff: string;
    passed: boolean;
  };
  deposits: {
    subLedgerHeldTotal: string;
    glDepositLiability: string;
    diff: string;
    passed: boolean;
  };
  cashboxes: {
    subLedgerTotal: string;
    glCashTotal: string;
    diff: string;
    passed: boolean;
  };
}

export function reconcileOrganization(tenant: TenantDb): ReconciliationReport {
  const orgId = tenant.organizationId;

  // 1. Trial Balance
  const tbRow = tenant.db
    .prepare(
      `SELECT COALESCE(SUM(CAST(debit AS REAL)), 0) AS deb, COALESCE(SUM(CAST(credit AS REAL)), 0) AS cred
       FROM journal_lines WHERE organization_id = ?`,
    )
    .get(orgId) as { deb: number; cred: number };

  const glByAccount = tenant.db
    .prepare(
      `SELECT account_code, debit, credit FROM journal_lines WHERE organization_id = ?`,
    )
    .all(orgId) as Array<{ account_code: string; debit: string; credit: string }>;

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  const accNet = new Map<string, Decimal>();

  for (const row of glByAccount) {
    const d = D(row.debit);
    const c = D(row.credit);
    totalDebit = totalDebit.plus(d);
    totalCredit = totalCredit.plus(c);
    accNet.set(row.account_code, (accNet.get(row.account_code) ?? new Decimal(0)).plus(d).minus(c));
  }
  const tbDiff = totalDebit.minus(totalCredit);
  const tbPassed = tbDiff.abs().lte(new Decimal('0.01'));
  void tbRow;

  // 2. Receivables (Accrued Installments unpaid + Tenant/UnitOwner Bills unpaid + Tenant Maint unpaid)
  // Note: Installments are accrued in GL only when accrual_journal_id IS NOT NULL (FR-ACC-05)
  const instRows = tenant.db
    .prepare(
      `SELECT amount, paid_amount, waived_amount FROM installments
       WHERE organization_id = ? AND accrual_journal_id IS NOT NULL AND status != 'WAIVED'`,
    )
    .all(orgId) as Array<{ amount: string; paid_amount: string; waived_amount: string }>;

  let unpaidInstallments = new Decimal(0);
  for (const r of instRows) {
    const rem = Decimal.max(0, D(r.amount).minus(r.paid_amount).minus(r.waived_amount));
    unpaidInstallments = unpaidInstallments.plus(rem);
  }

  const billRows = tenant.db
    .prepare(
      `SELECT amount, paid_amount, payer_role, journal_entry_id FROM service_bills
       WHERE organization_id = ? AND status != 'VOID' AND journal_entry_id IS NOT NULL`,
    )
    .all(orgId) as Array<{ amount: string; paid_amount: string; payer_role: string }>;

  let unpaidTenantBills = new Decimal(0);
  let unpaidUnitOwnerBills = new Decimal(0);
  for (const b of billRows) {
    if (b.payer_role === 'OWNER') continue;
    const rem = Decimal.max(0, D(b.amount).minus(b.paid_amount));
    if (b.payer_role === 'UNIT_OWNER') {
      unpaidUnitOwnerBills = unpaidUnitOwnerBills.plus(rem);
    } else {
      unpaidTenantBills = unpaidTenantBills.plus(rem);
    }
  }

  const maintRows = tenant.db
    .prepare(
      `SELECT cost, paid_amount FROM maintenance_records
       WHERE organization_id = ? AND charge_to = 'TENANT' AND journal_entry_id IS NOT NULL`,
    )
    .all(orgId) as Array<{ cost: string; paid_amount: string }>;
  let unpaidTenantMaint = new Decimal(0);
  for (const m of maintRows) {
    unpaidTenantMaint = unpaidTenantMaint.plus(Decimal.max(0, D(m.cost).minus(m.paid_amount)));
  }

  const ceRows = tenant.db
    .prepare(
      `SELECT amount, paid_amount FROM contract_expense_items
       WHERE organization_id = ? AND charge_to = 'TENANT' AND journal_entry_id IS NOT NULL`,
    )
    .all(orgId) as Array<{ amount: string; paid_amount: string }>;
  let unpaidContractExpenses = new Decimal(0);
  for (const ce of ceRows) {
    unpaidContractExpenses = unpaidContractExpenses.plus(Decimal.max(0, D(ce.amount).minus(ce.paid_amount)));
  }

  const arSubLedger = unpaidInstallments
    .plus(unpaidTenantBills)
    .plus(unpaidUnitOwnerBills)
    .plus(unpaidTenantMaint)
    .plus(unpaidContractExpenses);
  const glArBalance = (accNet.get('1210') ?? new Decimal(0)).plus(accNet.get('1220') ?? new Decimal(0));
  const arDiff = arSubLedger.minus(glArBalance);
  const arPassed = arDiff.abs().lte(new Decimal('0.01'));

  // 3. Security Deposits Held
  const depRows = tenant.db
    .prepare(`SELECT held_balance FROM security_deposits WHERE organization_id = ?`)
    .all(orgId) as Array<{ held_balance: string }>;
  const depSubTotal = depRows.reduce((s, r) => s.plus(D(r.held_balance)), new Decimal(0));
  // Liability normal balance is credit - debit
  const glDepLiab = (accNet.get('2110') ?? new Decimal(0)).negated();
  const depDiff = depSubTotal.minus(glDepLiab);
  const depPassed = depDiff.abs().lte(new Decimal('0.01'));

  // 4. Cashboxes
  const cbRows = tenant.db
    .prepare(`SELECT balance FROM cashboxes WHERE organization_id = ?`)
    .all(orgId) as Array<{ balance: string }>;
  const cbSubTotal = cbRows.reduce((s, r) => s.plus(D(r.balance)), new Decimal(0));
  const glCashTotal = (accNet.get('1110') ?? new Decimal(0))
    .plus(accNet.get('1120') ?? new Decimal(0))
    .plus(accNet.get('1130') ?? new Decimal(0));
  const cbDiff = cbSubTotal.minus(glCashTotal);
  const cbPassed = cbDiff.abs().lte(new Decimal('0.01'));

  return {
    isBalanced: tbPassed && arPassed && depPassed && cbPassed,
    trialBalance: {
      totalDebit: totalDebit.toFixed(2),
      totalCredit: totalCredit.toFixed(2),
      diff: tbDiff.toFixed(2),
      passed: tbPassed,
    },
    receivables: {
      subLedgerTotal: arSubLedger.toFixed(2),
      unpaidInstallments: unpaidInstallments.toFixed(2),
      unpaidTenantBills: unpaidTenantBills.toFixed(2),
      unpaidUnitOwnerBills: unpaidUnitOwnerBills.toFixed(2),
      unpaidTenantMaint: unpaidTenantMaint.toFixed(2),
      unpaidContractExpenses: unpaidContractExpenses.toFixed(2),
      glArBalance: glArBalance.toFixed(2),
      diff: arDiff.toFixed(2),
      passed: arPassed,
    },
    deposits: {
      subLedgerHeldTotal: depSubTotal.toFixed(2),
      glDepositLiability: glDepLiab.toFixed(2),
      diff: depDiff.toFixed(2),
      passed: depPassed,
    },
    cashboxes: {
      subLedgerTotal: cbSubTotal.toFixed(2),
      glCashTotal: glCashTotal.toFixed(2),
      diff: cbDiff.toFixed(2),
      passed: cbPassed,
    },
  };
}
