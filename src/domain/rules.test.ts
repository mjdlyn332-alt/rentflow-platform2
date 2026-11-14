import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {
  buildPartyLedgerStatement,
  calculateDepositBalance,
  calculateGracePeriodImpact,
  calculateManagementCommission,
  calculateSettlement,
  calculateTieredServiceCost,
  distributeSharedCost,
  generateInstallmentSchedule,
  renderContractTemplate,
  StateMachines,
  validatePropertyOwners,
} from './rules';
import {
  CollectionFrequency,
  CommissionType,
  DepositMovementType,
  DistributionMethod,
  EvictionStatus,
  InstallmentStatus,
  RentAgreementStatus,
} from './types';

test('BR-01: Installment schedule sums exactly to total - discount with remainder on last installment', () => {
  const schedule = generateInstallmentSchedule({
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    totalAmount: '10000.00',
    discountAmount: '0.00',
    frequency: CollectionFrequency.QUARTERLY,
  });
  assert.equal(schedule.length, 4);
  assert.equal(schedule[0].amount, '2500.00');

  // Non-divisible amount: 10000 / 3 = 3333.33, 3333.33, 3333.34
  const custom = generateInstallmentSchedule({
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    totalAmount: '10050.00',
    discountAmount: '50.00',
    frequency: CollectionFrequency.CUSTOM,
    customCount: 3,
  });
  assert.equal(custom.length, 3);
  assert.equal(custom[0].amount, '3333.33');
  assert.equal(custom[1].amount, '3333.33');
  assert.equal(custom[2].amount, '3333.34');

  const totalSum = custom.reduce((acc, item) => acc.plus(item.amount), new Decimal(0));
  assert.equal(totalSum.toFixed(2), '10000.00');
});

test('P4: No silent rounding unless explicitly configured by org roundingStep', () => {
  const noStep = generateInstallmentSchedule({
    startDate: '2026-01-01',
    endDate: '2026-03-31',
    totalAmount: '10000.00',
    frequency: CollectionFrequency.MONTHLY,
  });
  assert.equal(noStep[0].amount, '3333.33');
  assert.equal(noStep[2].amount, '3333.34');

  const withStep = generateInstallmentSchedule({
    startDate: '2026-01-01',
    endDate: '2026-03-31',
    totalAmount: '10000.00',
    frequency: CollectionFrequency.MONTHLY,
    roundingStep: '50',
  });
  assert.equal(withStep[0].amount, '3300.00');
  assert.equal(withStep[1].amount, '3300.00');
  assert.equal(withStep[2].amount, '3400.00');
});

test('FR-EVC-03 & BR-02/03/04: Grace period has zero rent, waives unpaid, credits prepaid as advanceRentCredit, and charges post-grace if enabled', () => {
  const result = calculateGracePeriodImpact({
    installments: [
      {
        id: 'i1',
        installmentNumber: 1,
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31', // 31 days -> 3100 / 31 = 100/day
        dueDate: '2026-01-01',
        amount: '3100.00',
        paidAmount: '3100.00', // fully paid
        status: InstallmentStatus.PAID,
      },
      {
        id: 'i2',
        installmentNumber: 2,
        periodStart: '2026-02-01',
        periodEnd: '2026-02-28', // 28 days -> 2800 / 28 = 100/day
        dueDate: '2026-02-01',
        amount: '2800.00',
        paidAmount: '0.00', // unpaid
        status: InstallmentStatus.PENDING,
      },
    ],
    noticeDate: '2026-01-27', // 5 days in Jan (27..31) + 10 days in Feb (1..10) = 15 days grace
    graceDays: 15,
    handoverDate: '2026-02-13', // 3 days overdue (Feb 11, 12, 13)
    postGraceRentEnabled: true,
  });

  assert.equal(result.graceEndDate, '2026-02-10');
  assert.equal(result.totalAdvanceRentCredit, '500.00'); // 5 days * 100
  assert.equal(result.totalWaivedUnpaid, '1000.00'); // 10 days * 100
  assert.equal(result.overdueDays, 3);
  assert.equal(result.postGraceRentAmount, '300.00'); // 3 days * 100
});

test('BR-07: Shared cost distribution sums exactly to total cost', () => {
  const equalShares = distributeSharedCost({
    totalCost: '100.00',
    method: DistributionMethod.EQUAL,
    units: [
      { unitId: 'u1', areaSqm: 100, consumption: 10 },
      { unitId: 'u2', areaSqm: 150, consumption: 20 },
      { unitId: 'u3', areaSqm: 200, consumption: 30 },
    ],
  });
  assert.equal(equalShares[0].amount, '33.33');
  assert.equal(equalShares[1].amount, '33.33');
  assert.equal(equalShares[2].amount, '33.34');

  const areaShares = distributeSharedCost({
    totalCost: '900.00',
    method: DistributionMethod.AREA,
    units: [
      { unitId: 'u1', areaSqm: 100, consumption: 0 },
      { unitId: 'u2', areaSqm: 200, consumption: 0 },
    ],
  });
  assert.equal(areaShares[0].amount, '300.00');
  assert.equal(areaShares[1].amount, '600.00');
});

test('BR-09 & BR-10: Deposit balance invariant and Settlement net calculation', () => {
  const bal = calculateDepositBalance([
    { type: DepositMovementType.RECEIVED, amount: '5000.00' },
    { type: DepositMovementType.DAMAGE_DEDUCTION, amount: '1200.00' },
    { type: DepositMovementType.RENT_DEDUCTION, amount: '800.00' },
  ]);
  assert.equal(bal.heldBalance, '3000.00');

  assert.throws(() => {
    calculateDepositBalance([
      { type: DepositMovementType.RECEIVED, amount: '1000.00' },
      { type: DepositMovementType.REFUNDED, amount: '1200.00' },
    ]);
  });

  const settlement = calculateSettlement({
    heldDeposit: '5000.00',
    advanceRentCredit: '500.00',
    damagesTotal: '1200.00',
    unpaidRentTotal: '1000.00',
    unpaidServicesTotal: '300.00',
  });
  assert.equal(settlement.netPayable, '3000.00');
  assert.equal(settlement.refundToTenant, '3000.00');
  assert.equal(settlement.dueFromTenant, '0.00');

  const deficitSettlement = calculateSettlement({
    heldDeposit: '1000.00',
    advanceRentCredit: '0.00',
    damagesTotal: '1500.00',
    unpaidRentTotal: '500.00',
    unpaidServicesTotal: '200.00',
  });
  assert.equal(deficitSettlement.netPayable, '-1200.00');
  assert.equal(deficitSettlement.dueFromTenant, '1200.00');
  assert.equal(deficitSettlement.refundToTenant, '0.00');
});

test('FR-RPT-04 & FR-PRP-03: Commission and Property Ownership validation', () => {
  assert.equal(
    calculateManagementCommission({
      commissionType: CommissionType.NONE,
      commissionValue: '0',
      collectedRentalRevenue: '100000',
    }),
    '0.00',
  );
  assert.equal(
    calculateManagementCommission({
      commissionType: CommissionType.PERCENTAGE,
      commissionValue: '5.5',
      collectedRentalRevenue: '10000',
    }),
    '550.00',
  );

  assert.doesNotThrow(() =>
    validatePropertyOwners([
      { partyId: 'p1', sharePercent: '60', isPrimary: true },
      { partyId: 'p2', sharePercent: '40', isPrimary: false },
    ]),
  );
  assert.throws(() =>
    validatePropertyOwners([
      { partyId: 'p1', sharePercent: '50', isPrimary: true },
      { partyId: 'p2', sharePercent: '40', isPrimary: false },
    ]),
  );
});

test('P7: State machines permit valid transitions and reject invalid ones', () => {
  assert.doesNotThrow(() =>
    StateMachines.agreement(RentAgreementStatus.ACTIVE, RentAgreementStatus.NOTICE),
  );
  assert.throws(() =>
    StateMachines.agreement(RentAgreementStatus.CLOSED, RentAgreementStatus.ACTIVE),
  );
  assert.doesNotThrow(() =>
    StateMachines.eviction(EvictionStatus.IN_GRACE, EvictionStatus.HANDED_OVER),
  );
  assert.throws(() =>
    StateMachines.eviction(EvictionStatus.CLOSED, EvictionStatus.IN_GRACE),
  );
});

test('FR-SVC-10: Tiered service tariff calculates flat rate, progressive brackets, and fixed fee accurately', () => {
  const flat = calculateTieredServiceCost({
    consumption: 100,
    fixedFee: '15.00',
    defaultUnitPrice: '0.25',
    tiers: [],
  });
  assert.equal(flat.energyCost, '25.00');
  assert.equal(flat.fixedFee, '15.00');
  assert.equal(flat.totalAmount, '40.00');

  const tiered = calculateTieredServiceCost({
    consumption: 250,
    fixedFee: '20.00',
    defaultUnitPrice: '0.18',
    tiers: [
      { fromQty: '0', toQty: '100', unitPrice: '0.18' },
      { fromQty: '100', toQty: '200', unitPrice: '0.30' },
      { fromQty: '200', toQty: null, unitPrice: '0.50' },
    ],
  });
  // 100*0.18 (18) + 100*0.30 (30) + 50*0.50 (25) = 73.00 + 20.00 fixed = 93.00
  assert.equal(tiered.energyCost, '73.00');
  assert.equal(tiered.totalAmount, '93.00');
  assert.equal(tiered.breakdown.length, 3);
});

test('FR-CTR-11: Contract template renderer replaces tokens and falls back missing values to em-dash', () => {
  const rendered = renderContractTemplate(
    'مستأجر: {{ tenant_name }} | وحدة: {{unitNumber}} | ملاحظات: {{notes}}',
    {
      tenant_name: 'خالد السبيعي',
      unitNumber: '101',
      notes: '',
    },
  );
  assert.equal(rendered, 'مستأجر: خالد السبيعي | وحدة: 101 | ملاحظات: —');
});

test('FR-PTY-06 & FR-ACC-08: Party ledger statement computes running balance and debit/credit totals', () => {
  const stmt = buildPartyLedgerStatement([
    {
      date: '2026-01-01',
      entryNumber: 'JE-00001',
      sourceType: 'INSTALLMENT_ACCRUAL',
      description: 'قسط #1',
      accountCode: '1210',
      debit: '12000.00',
      credit: '0.00',
    },
    {
      date: '2026-01-05',
      entryNumber: 'JE-00002',
      sourceType: 'RECEIPT',
      description: 'تحصيل سند',
      accountCode: '1210',
      debit: '0.00',
      credit: '4500.00',
    },
  ]);
  assert.equal(stmt.totalDebit, '12000.00');
  assert.equal(stmt.totalCredit, '4500.00');
  assert.equal(stmt.closingBalance, '7500.00');
  assert.equal(stmt.rows[0].balanceAfter, '12000.00');
  assert.equal(stmt.rows[1].balanceAfter, '7500.00');
});

import { buildDashboardAlertToasts, calculateDaysRemaining } from './alerts';

test('Dashboard Alert Toasts: builds prioritized expiring contract & pending maintenance toasts and filters dismissed items', () => {
  assert.equal(calculateDaysRemaining('2026-11-14', '2026-11-29'), 15);
  assert.equal(calculateDaysRemaining('2026-11-14', '2026-11-12'), -2);

  const built = buildDashboardAlertToasts({
    today: '2026-11-14',
    expiringContracts: [
      {
        id: 'agr_soon',
        property_name: 'مجمع النخيل',
        unit_number: '201',
        tenant_name: 'ماجد الحربي',
        end_date: '2026-11-29',
      },
      {
        id: 'agr_today',
        property_name: 'برج الواحة',
        unit_number: '104',
        tenant_name: 'سلمان القحطاني',
        end_date: '2026-11-14',
      },
    ],
    pendingMaintenance: [
      {
        id: 'mnt_open',
        maintenance_type: 'مصاعد',
        description: 'فحص دوري لحساسات المصعد الرئيسي',
        property_name: 'برج الواحة',
        unit_number: null,
        status: 'OPEN',
        maintenance_date: '2026-11-14',
      },
      {
        id: 'mnt_done',
        maintenance_type: 'كهرباء',
        description: 'منتهية لا يجب ظهورها',
        property_name: 'برج الواحة',
        unit_number: '101',
        status: 'COMPLETED',
        maintenance_date: '2026-11-10',
      },
    ],
    pendingMaintenanceRequests: [
      {
        id: 'tmr_1',
        maintenance_type: 'تكييف',
        description: 'ضعف تبريد وحدة الصالة',
        property_name: 'برج الواحة',
        unit_number: '102',
        tenant_name: 'ماجد الحربي',
      },
    ],
    maxVisible: 3,
  });

  assert.equal(built.contractAlertCount, 2);
  assert.equal(built.maintenanceAlertCount, 2);
  assert.equal(built.allToasts.length, 4);
  assert.equal(built.visibleToasts.length, 3);
  assert.equal(built.hiddenCount, 1);

  // Urgent contract expiring today comes first (priority 0)
  assert.equal(built.visibleToasts[0].id, 'contract:agr_today');
  assert.equal(built.visibleToasts[0].severity, 'urgent');
  assert.equal(built.visibleToasts[0].targetTab, 'contracts');

  // Pending tenant maintenance request comes next (priority 1)
  assert.equal(built.visibleToasts[1].id, 'tmreq:tmr_1');
  assert.equal(built.visibleToasts[1].targetTab, 'maintenance');

  // Dismissing one toast exposes the 4th item cleanly
  const afterDismiss = buildDashboardAlertToasts({
    today: '2026-11-14',
    expiringContracts: [
      { id: 'agr_soon', property_name: 'مجمع النخيل', unit_number: '201', tenant_name: 'ماجد الحربي', end_date: '2026-11-29' },
    ],
    pendingMaintenance: [
      { id: 'mnt_open', maintenance_type: 'مصاعد', description: 'فحص', property_name: 'برج الواحة', unit_number: null, status: 'OPEN', maintenance_date: '2026-11-14' },
    ],
    dismissedIds: ['contract:agr_soon'],
  });
  assert.equal(afterDismiss.allToasts.length, 2);
  assert.equal(afterDismiss.visibleToasts.length, 1);
  assert.equal(afterDismiss.visibleToasts[0].id, 'maint:mnt_open');
});

