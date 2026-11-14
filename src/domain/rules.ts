import Decimal from 'decimal.js';
import { D, applyRoundingStep, toFixedMoney } from './money';
import {
  CollectionFrequency,
  CommissionType,
  DepositMovementType,
  DistributionMethod,
  EvictionStatus,
  InstallmentStatus,
  PartyStatementLine,
  RentAgreementStatus,
  SecurityDepositStatus,
  ServiceBillStatus,
  SettlementStatus,
  TariffTier,
  VoucherStatus,
} from './types';

// --- Pure ISO Date Helpers (YYYY-MM-DD) ---

export function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  const dt = parseIsoDate(iso);
  dt.setUTCDate(dt.getUTCDate() + days);
  return formatIsoDate(dt);
}

export function addMonths(iso: string, months: number): string {
  const dt = parseIsoDate(iso);
  const day = dt.getUTCDate();
  dt.setUTCMonth(dt.getUTCMonth() + months);
  // Clamp end of month
  if (dt.getUTCDate() !== day) {
    dt.setUTCDate(0);
  }
  return formatIsoDate(dt);
}

export function daysBetweenInclusive(startIso: string, endIso: string): number {
  const start = parseIsoDate(startIso).getTime();
  const end = parseIsoDate(endIso).getTime();
  if (end < start) return 0;
  return Math.floor((end - start) / 86400000) + 1;
}

export function overlapDaysInclusive(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): number {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  if (end < start) return 0;
  return daysBetweenInclusive(start, end);
}

// --- BR-01: Installment Schedule Generation ---

export interface GeneratedInstallment {
  installmentNumber: number;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  amount: string;
}

export function getPeriodMonths(frequency: CollectionFrequency): number {
  switch (frequency) {
    case CollectionFrequency.MONTHLY:
      return 1;
    case CollectionFrequency.QUARTERLY:
      return 3;
    case CollectionFrequency.SEMI_ANNUAL:
      return 6;
    case CollectionFrequency.ANNUAL:
      return 12;
    case CollectionFrequency.CUSTOM:
      return 1;
  }
}

export function generateInstallmentSchedule(params: {
  startDate: string;
  endDate: string;
  totalAmount: string | number;
  discountAmount?: string | number;
  frequency: CollectionFrequency;
  customCount?: number;
  roundingStep?: string | number | null;
  currencyDecimals?: number;
}): GeneratedInstallment[] {
  const decimals = params.currencyDecimals ?? 2;
  const total = D(params.totalAmount);
  const discount = D(params.discountAmount ?? 0);
  if (total.lte(0)) {
    throw new Error('إجمالي العقد يجب أن يكون أكبر من صفر');
  }
  if (discount.lt(0) || discount.gte(total)) {
    throw new Error('الخصم غير صالح');
  }
  if (params.endDate < params.startDate) {
    throw new Error('تاريخ نهاية العقد يجب أن يكون بعد تاريخ البداية');
  }

  const netTotal = total.minus(discount).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
  const periods: Array<{ start: string; end: string }> = [];

  if (params.frequency === CollectionFrequency.CUSTOM) {
    const count = Math.max(1, params.customCount ?? 1);
    const totalDays = daysBetweenInclusive(params.startDate, params.endDate);
    const baseDays = Math.floor(totalDays / count);
    let cursor = params.startDate;
    for (let i = 0; i < count; i++) {
      const pEnd = i === count - 1 ? params.endDate : addDays(cursor, Math.max(1, baseDays) - 1);
      const clampedEnd = pEnd > params.endDate ? params.endDate : pEnd;
      periods.push({ start: cursor, end: clampedEnd });
      cursor = addDays(clampedEnd, 1);
    }
  } else {
    const stepMonths = getPeriodMonths(params.frequency);
    let cursor = params.startDate;
    while (cursor <= params.endDate) {
      const nextPeriodStart = addMonths(cursor, stepMonths);
      const candidateEnd = addDays(nextPeriodStart, -1);
      const pEnd = candidateEnd > params.endDate ? params.endDate : candidateEnd;
      periods.push({ start: cursor, end: pEnd });
      cursor = addDays(pEnd, 1);
    }
  }

  const count = periods.length;
  const rawPerInstallment = netTotal.div(count);
  const basePerInstallment = applyRoundingStep(rawPerInstallment, params.roundingStep, decimals);

  const result: GeneratedInstallment[] = [];
  let allocated = new Decimal(0);

  for (let i = 0; i < count; i++) {
    const isLast = i === count - 1;
    const amt = isLast
      ? netTotal.minus(allocated).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
      : basePerInstallment;
    allocated = allocated.plus(amt);
    result.push({
      installmentNumber: i + 1,
      periodStart: periods[i].start,
      periodEnd: periods[i].end,
      dueDate: periods[i].start,
      amount: amt.toFixed(decimals),
    });
  }

  return result;
}

// --- FR-EVC-03, BR-02, BR-03, BR-04: Grace Period & Post-Grace Rent ---

export interface InstallmentSnapshot {
  id: string;
  installmentNumber: number;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  amount: string;
  paidAmount: string;
  status: InstallmentStatus;
}

export interface GracePeriodAdjustment {
  installmentId: string;
  overlapDays: number;
  periodDays: number;
  dailyRate: string;
  graceReductionAmount: string; // total rent covered by grace
  unpaidWaivedAmount: string; // credit note / waiver for unpaid portion
  advanceRentCreditAmount: string; // already paid portion over grace days -> credited in settlement
}

export interface GraceCalculationResult {
  graceEndDate: string;
  adjustments: GracePeriodAdjustment[];
  totalWaivedUnpaid: string;
  totalAdvanceRentCredit: string;
  postGraceRentAmount: string;
  overdueDays: number;
}

export function calculateGracePeriodImpact(params: {
  installments: InstallmentSnapshot[];
  noticeDate: string;
  graceDays: number;
  handoverDate?: string | null;
  extendedUntil?: string | null;
  postGraceRentEnabled?: boolean;
}): GraceCalculationResult {
  if (params.graceDays < 0) {
    throw new Error('أيام المهلة لا يمكن أن تكون سالبة');
  }
  const graceEndDate =
    params.graceDays === 0 ? params.noticeDate : addDays(params.noticeDate, params.graceDays - 1);

  const adjustments: GracePeriodAdjustment[] = [];
  let totalWaivedUnpaid = new Decimal(0);
  let totalAdvanceRentCredit = new Decimal(0);

  for (const inst of params.installments) {
    if (inst.status === InstallmentStatus.WAIVED) continue;
    const overlap =
      params.graceDays === 0
        ? 0
        : overlapDaysInclusive(inst.periodStart, inst.periodEnd, params.noticeDate, graceEndDate);
    if (overlap <= 0) continue;

    const periodDays = Math.max(1, daysBetweenInclusive(inst.periodStart, inst.periodEnd));
    const amountD = D(inst.amount);
    const paidD = D(inst.paidAmount);
    const dailyRate = amountD.div(periodDays);

    // Proportional rent during grace days (clamped to installment amount)
    const graceRent =
      overlap >= periodDays
        ? amountD
        : dailyRate.mul(overlap).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

    // Unpaid remaining on this installment before waiver
    const remainingUnpaid = Decimal.max(0, amountD.minus(paidD));

    // Waive unpaid up to graceRent; any excess graceRent beyond remainingUnpaid means tenant already paid for grace days!
    const waivedUnpaid = Decimal.min(remainingUnpaid, graceRent);
    const advanceCredit = Decimal.max(0, graceRent.minus(waivedUnpaid));

    totalWaivedUnpaid = totalWaivedUnpaid.plus(waivedUnpaid);
    totalAdvanceRentCredit = totalAdvanceRentCredit.plus(advanceCredit);

    adjustments.push({
      installmentId: inst.id,
      overlapDays: overlap,
      periodDays,
      dailyRate: dailyRate.toFixed(4),
      graceReductionAmount: graceRent.toFixed(2),
      unpaidWaivedAmount: waivedUnpaid.toFixed(2),
      advanceRentCreditAmount: advanceCredit.toFixed(2),
    });
  }

  let overdueDays = 0;
  let postGraceRentAmount = new Decimal(0);
  const effectiveDeadline =
    params.extendedUntil && params.extendedUntil > graceEndDate ? params.extendedUntil : graceEndDate;

  if (params.postGraceRentEnabled && params.handoverDate && params.handoverDate > effectiveDeadline) {
    const startAfterDeadline = addDays(effectiveDeadline, 1);
    overdueDays = daysBetweenInclusive(startAfterDeadline, params.handoverDate);
    const sorted = [...params.installments].sort((a, b) => a.installmentNumber - b.installmentNumber);
    const lastInst = sorted[sorted.length - 1];
    if (lastInst) {
      const pDays = Math.max(1, daysBetweenInclusive(lastInst.periodStart, lastInst.periodEnd));
      const dailyRate = D(lastInst.amount).div(pDays);
      postGraceRentAmount = dailyRate.mul(overdueDays).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
  }

  return {
    graceEndDate,
    adjustments,
    totalWaivedUnpaid: totalWaivedUnpaid.toFixed(2),
    totalAdvanceRentCredit: totalAdvanceRentCredit.toFixed(2),
    postGraceRentAmount: postGraceRentAmount.toFixed(2),
    overdueDays,
  };
}

// --- BR-07: Shared Cost Distribution ---

export interface SharedUnitInput {
  unitId: string;
  areaSqm: string | number;
  consumption: string | number;
}

export interface SharedCostAllocation {
  unitId: string;
  amount: string;
}

export function distributeSharedCost(params: {
  totalCost: string | number;
  method: DistributionMethod;
  units: SharedUnitInput[];
  decimals?: number;
}): SharedCostAllocation[] {
  const decimals = params.decimals ?? 2;
  const total = D(params.totalCost);
  if (total.lt(0)) throw new Error('التكلفة المشتركة لا يمكن أن تكون سالبة');
  if (params.units.length === 0) throw new Error('يجب اختيار وحدة مشاركة واحدة على الأقل');

  const weights = params.units.map((u) => {
    if (params.method === DistributionMethod.EQUAL) return new Decimal(1);
    if (params.method === DistributionMethod.AREA) {
      const area = D(u.areaSqm);
      return area.gt(0) ? area : new Decimal(0);
    }
    const cons = D(u.consumption);
    return cons.gt(0) ? cons : new Decimal(0);
  });

  const weightSum = weights.reduce((acc, w) => acc.plus(w), new Decimal(0));
  if (weightSum.lte(0)) {
    throw new Error('مجموع أوزان التوزيع (المساحة أو الاستهلاك) يساوي صفراً');
  }

  const allocations: SharedCostAllocation[] = [];
  let running = new Decimal(0);

  for (let i = 0; i < params.units.length; i++) {
    const isLast = i === params.units.length - 1;
    const share = isLast
      ? total.minus(running).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
      : total.mul(weights[i]).div(weightSum).toDecimalPlaces(decimals, Decimal.ROUND_DOWN);
    running = running.plus(share);
    allocations.push({
      unitId: params.units[i].unitId,
      amount: share.toFixed(decimals),
    });
  }

  return allocations;
}

// --- BR-09 & BR-10: Security Deposit & Settlement Statement ---

export interface DepositMovementInput {
  type: DepositMovementType;
  amount: string | number;
}

export function calculateDepositBalance(movements: DepositMovementInput[]): {
  received: string;
  deducted: string;
  refunded: string;
  forfeited: string;
  heldBalance: string;
} {
  let received = new Decimal(0);
  let deducted = new Decimal(0);
  let refunded = new Decimal(0);
  let forfeited = new Decimal(0);

  for (const m of movements) {
    const amt = D(m.amount);
    if (amt.lt(0)) throw new Error('مبلغ حركة التأمين لا يمكن أن يكون سالباً');
    switch (m.type) {
      case DepositMovementType.RECEIVED:
        received = received.plus(amt);
        break;
      case DepositMovementType.DAMAGE_DEDUCTION:
      case DepositMovementType.RENT_DEDUCTION:
      case DepositMovementType.SERVICE_DEDUCTION:
        deducted = deducted.plus(amt);
        break;
      case DepositMovementType.REFUNDED:
        refunded = refunded.plus(amt);
        break;
      case DepositMovementType.FORFEITED:
        forfeited = forfeited.plus(amt);
        break;
    }
  }

  const held = received.minus(deducted).minus(refunded).minus(forfeited);
  if (held.lt(0)) {
    throw new Error('رصيد التأمين المحتجز لا يمكن أن يكون سالباً');
  }

  return {
    received: received.toFixed(2),
    deducted: deducted.toFixed(2),
    refunded: refunded.toFixed(2),
    forfeited: forfeited.toFixed(2),
    heldBalance: held.toFixed(2),
  };
}

export interface SettlementComputation {
  heldDeposit: string;
  advanceRentCredit: string;
  damagesTotal: string;
  unpaidRentTotal: string;
  unpaidServicesTotal: string;
  netPayable: string; // > 0 refund to tenant, < 0 receivable from tenant
  refundToTenant: string;
  dueFromTenant: string;
  depositUsedForDamages: string;
  depositUsedForRent: string;
  depositUsedForServices: string;
  excessDamagesBeyondDeposit: string;
}

export function calculateSettlement(params: {
  heldDeposit: string | number;
  advanceRentCredit: string | number;
  damagesTotal: string | number;
  unpaidRentTotal: string | number;
  unpaidServicesTotal: string | number;
}): SettlementComputation {
  const held = D(params.heldDeposit);
  const advance = D(params.advanceRentCredit);
  const damages = D(params.damagesTotal);
  const rent = D(params.unpaidRentTotal);
  const services = D(params.unpaidServicesTotal);

  // Order of applying held deposit: unpaid rent -> unpaid services -> damages
  let remainingHeld = held;
  const depositUsedForRent = Decimal.min(remainingHeld, rent);
  remainingHeld = remainingHeld.minus(depositUsedForRent);

  const depositUsedForServices = Decimal.min(remainingHeld, services);
  remainingHeld = remainingHeld.minus(depositUsedForServices);

  const depositUsedForDamages = Decimal.min(remainingHeld, damages);
  remainingHeld = remainingHeld.minus(depositUsedForDamages);

  const excessDamages = damages.minus(depositUsedForDamages);

  const net = held.plus(advance).minus(damages).minus(rent).minus(services);

  return {
    heldDeposit: held.toFixed(2),
    advanceRentCredit: advance.toFixed(2),
    damagesTotal: damages.toFixed(2),
    unpaidRentTotal: rent.toFixed(2),
    unpaidServicesTotal: services.toFixed(2),
    netPayable: net.toFixed(2),
    refundToTenant: net.gt(0) ? net.toFixed(2) : '0.00',
    dueFromTenant: net.lt(0) ? net.abs().toFixed(2) : '0.00',
    depositUsedForDamages: depositUsedForDamages.toFixed(2),
    depositUsedForRent: depositUsedForRent.toFixed(2),
    depositUsedForServices: depositUsedForServices.toFixed(2),
    excessDamagesBeyondDeposit: excessDamages.toFixed(2),
  };
}

// --- FR-RPT-04: Property Management Commission ---

export function calculateManagementCommission(params: {
  commissionType: CommissionType;
  commissionValue: string | number;
  collectedRentalRevenue: string | number;
}): string {
  const val = D(params.commissionValue ?? 0);
  const rev = D(params.collectedRentalRevenue ?? 0);
  switch (params.commissionType) {
    case CommissionType.NONE:
      return '0.00';
    case CommissionType.PERCENTAGE:
      return rev.mul(val).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
    case CommissionType.FIXED:
      return val.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }
}

// --- FR-PRP-03: Property Ownership Share Validation ---

export function validatePropertyOwners(
  owners: Array<{ partyId: string; sharePercent: string | number; isPrimary: boolean }>,
): void {
  if (owners.length === 0) {
    throw new Error('يجب تحديد مالك واحد على الأقل للعقار');
  }
  const primaryCount = owners.filter((o) => o.isPrimary).length;
  if (primaryCount !== 1) {
    throw new Error('يجب تحديد مالك أساسي واحد بالضبط للعقار');
  }
  const uniqueParties = new Set(owners.map((o) => o.partyId));
  if (uniqueParties.size !== owners.length) {
    throw new Error('لا يمكن تكرار نفس الطرف في ملاك العقار');
  }
  let sum = new Decimal(0);
  for (const o of owners) {
    const s = D(o.sharePercent);
    if (s.lte(0) || s.gt(100)) {
      throw new Error('نسبة الملكية يجب أن تكون أكبر من 0 وحتى 100%');
    }
    sum = sum.plus(s);
  }
  if (!sum.toDecimalPlaces(2).equals(new Decimal(100))) {
    throw new Error(`مجموع نسب الملكية يجب أن يساوي 100% (الحالي: ${toFixedMoney(sum)}%)`);
  }
}

// --- P7 (Section 6.1): Explicit State Machines ---

const AGREEMENT_TRANSITIONS: Record<RentAgreementStatus, RentAgreementStatus[]> = {
  [RentAgreementStatus.DRAFT]: [RentAgreementStatus.ACTIVE, RentAgreementStatus.CANCELED],
  [RentAgreementStatus.ACTIVE]: [
    RentAgreementStatus.NOTICE,
    RentAgreementStatus.EXPIRED,
    RentAgreementStatus.CANCELED,
  ],
  [RentAgreementStatus.NOTICE]: [
    RentAgreementStatus.CLOSED,
    RentAgreementStatus.ACTIVE, // withdraw eviction request
  ],
  [RentAgreementStatus.EXPIRED]: [RentAgreementStatus.CLOSED],
  [RentAgreementStatus.CLOSED]: [],
  [RentAgreementStatus.CANCELED]: [],
};

const EVICTION_TRANSITIONS: Record<EvictionStatus, EvictionStatus[]> = {
  [EvictionStatus.DRAFT]: [EvictionStatus.NOTIFIED, EvictionStatus.CANCELLED],
  [EvictionStatus.NOTIFIED]: [EvictionStatus.IN_GRACE, EvictionStatus.CANCELLED],
  [EvictionStatus.IN_GRACE]: [
    EvictionStatus.HANDED_OVER,
    EvictionStatus.OVERDUE,
    EvictionStatus.CANCELLED,
  ],
  [EvictionStatus.OVERDUE]: [EvictionStatus.HANDED_OVER, EvictionStatus.CANCELLED],
  [EvictionStatus.HANDED_OVER]: [EvictionStatus.SETTLED],
  [EvictionStatus.SETTLED]: [EvictionStatus.CLOSED],
  [EvictionStatus.CLOSED]: [],
  [EvictionStatus.CANCELLED]: [],
};

const INSTALLMENT_TRANSITIONS: Record<InstallmentStatus, InstallmentStatus[]> = {
  [InstallmentStatus.PENDING]: [
    InstallmentStatus.PARTIAL,
    InstallmentStatus.PAID,
    InstallmentStatus.WAIVED,
  ],
  [InstallmentStatus.PARTIAL]: [InstallmentStatus.PAID, InstallmentStatus.WAIVED],
  [InstallmentStatus.PAID]: [InstallmentStatus.PARTIAL, InstallmentStatus.PENDING], // via voucher reversal only
  [InstallmentStatus.WAIVED]: [InstallmentStatus.PENDING, InstallmentStatus.PARTIAL], // via eviction withdrawal
};

const DEPOSIT_TRANSITIONS: Record<SecurityDepositStatus, SecurityDepositStatus[]> = {
  [SecurityDepositStatus.HELD]: [
    SecurityDepositStatus.PARTIALLY_APPLIED,
    SecurityDepositStatus.REFUNDED,
    SecurityDepositStatus.FORFEITED,
  ],
  [SecurityDepositStatus.PARTIALLY_APPLIED]: [
    SecurityDepositStatus.REFUNDED,
    SecurityDepositStatus.FORFEITED,
  ],
  [SecurityDepositStatus.REFUNDED]: [],
  [SecurityDepositStatus.FORFEITED]: [],
};

const SERVICE_BILL_TRANSITIONS: Record<ServiceBillStatus, ServiceBillStatus[]> = {
  [ServiceBillStatus.ISSUED]: [
    ServiceBillStatus.PARTIAL,
    ServiceBillStatus.PAID,
    ServiceBillStatus.VOID,
  ],
  [ServiceBillStatus.PARTIAL]: [ServiceBillStatus.PAID],
  [ServiceBillStatus.PAID]: [ServiceBillStatus.PARTIAL, ServiceBillStatus.ISSUED], // via voucher reversal
  [ServiceBillStatus.VOID]: [],
};

const VOUCHER_TRANSITIONS: Record<VoucherStatus, VoucherStatus[]> = {
  [VoucherStatus.POSTED]: [VoucherStatus.REVERSED],
  [VoucherStatus.REVERSED]: [],
};

const SETTLEMENT_TRANSITIONS: Record<SettlementStatus, SettlementStatus[]> = {
  [SettlementStatus.DRAFT]: [SettlementStatus.APPROVED],
  [SettlementStatus.APPROVED]: [SettlementStatus.POSTED],
  [SettlementStatus.POSTED]: [],
};

export function assertTransition<T extends string>(
  entityName: string,
  map: Record<T, T[]>,
  from: T,
  to: T,
): void {
  if (!map[from]?.includes(to)) {
    throw new Error(`انتقال حالة غير مسموح لـ ${entityName}: من ${from} إلى ${to}`);
  }
}

export const StateMachines = {
  agreement: (from: RentAgreementStatus, to: RentAgreementStatus) =>
    assertTransition('العقد', AGREEMENT_TRANSITIONS, from, to),
  eviction: (from: EvictionStatus, to: EvictionStatus) =>
    assertTransition('طلب الإخلاء', EVICTION_TRANSITIONS, from, to),
  installment: (from: InstallmentStatus, to: InstallmentStatus) =>
    assertTransition('القسط', INSTALLMENT_TRANSITIONS, from, to),
  deposit: (from: SecurityDepositStatus, to: SecurityDepositStatus) =>
    assertTransition('التأمين', DEPOSIT_TRANSITIONS, from, to),
  serviceBill: (from: ServiceBillStatus, to: ServiceBillStatus) =>
    assertTransition('فاتورة الخدمة', SERVICE_BILL_TRANSITIONS, from, to),
  voucher: (from: VoucherStatus, to: VoucherStatus) =>
    assertTransition('السند', VOUCHER_TRANSITIONS, from, to),
  settlement: (from: SettlementStatus, to: SettlementStatus) =>
    assertTransition('كشف التسوية', SETTLEMENT_TRANSITIONS, from, to),
};

// --- FR-SVC-10: Tiered Consumption Tariff Calculation ---

export function calculateTieredServiceCost(params: {
  consumption: string | number;
  fixedFee?: string | number;
  defaultUnitPrice?: string | number;
  tiers?: TariffTier[];
  decimals?: number;
}): { energyCost: string; fixedFee: string; totalAmount: string; breakdown: Array<{ fromQty: string; toQty: string | null; units: string; unitPrice: string; amount: string }> } {
  const decimals = params.decimals ?? 2;
  const consD = D(params.consumption);
  if (consD.lt(0)) throw new Error('الاستهلاك لا يمكن أن يكون سالباً');
  const fixedD = D(params.fixedFee ?? 0).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
  const tiers = (params.tiers ?? []).slice().sort((a, b) => D(a.fromQty).cmp(D(b.fromQty)));

  if (tiers.length === 0) {
    const unitP = D(params.defaultUnitPrice ?? 0);
    const energy = consD.mul(unitP).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
    return {
      energyCost: energy.toFixed(decimals),
      fixedFee: fixedD.toFixed(decimals),
      totalAmount: energy.plus(fixedD).toFixed(decimals),
      breakdown: consD.gt(0)
        ? [{ fromQty: '0', toQty: null, units: consD.toFixed(2), unitPrice: unitP.toFixed(2), amount: energy.toFixed(decimals) }]
        : [],
    };
  }

  let remaining = consD;
  let totalEnergy = new Decimal(0);
  const breakdown: Array<{ fromQty: string; toQty: string | null; units: string; unitPrice: string; amount: string }> = [];

  for (let i = 0; i < tiers.length; i++) {
    if (remaining.lte(0)) break;
    const t = tiers[i];
    const fromD = D(t.fromQty);
    const toD = t.toQty !== null && t.toQty !== '' ? D(t.toQty) : null;
    if (toD !== null && toD.lte(fromD)) {
      throw new Error('نهاية الشريحة يجب أن تكون أكبر من بدايتها');
    }
    const bandCapacity = toD !== null ? toD.minus(fromD) : remaining;
    const usedInBand = Decimal.min(remaining, bandCapacity);
    if (usedInBand.gt(0)) {
      const bandCost = usedInBand.mul(D(t.unitPrice)).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
      totalEnergy = totalEnergy.plus(bandCost);
      remaining = remaining.minus(usedInBand);
      breakdown.push({
        fromQty: fromD.toFixed(2),
        toQty: toD ? toD.toFixed(2) : null,
        units: usedInBand.toFixed(2),
        unitPrice: D(t.unitPrice).toFixed(2),
        amount: bandCost.toFixed(decimals),
      });
    }
  }

  // Any remaining beyond last explicit bounded tier falls back to last tier's rate or defaultUnitPrice
  if (remaining.gt(0)) {
    const fallbackPrice = D(tiers[tiers.length - 1]?.unitPrice ?? params.defaultUnitPrice ?? 0);
    const extraCost = remaining.mul(fallbackPrice).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
    totalEnergy = totalEnergy.plus(extraCost);
    breakdown.push({
      fromQty: tiers[tiers.length - 1]?.toQty ?? '0',
      toQty: null,
      units: remaining.toFixed(2),
      unitPrice: fallbackPrice.toFixed(2),
      amount: extraCost.toFixed(decimals),
    });
  }

  return {
    energyCost: totalEnergy.toFixed(decimals),
    fixedFee: fixedD.toFixed(decimals),
    totalAmount: totalEnergy.plus(fixedD).toFixed(decimals),
    breakdown,
  };
}

// --- FR-CTR-11: Contract Template Variable Rendering ---

export function renderContractTemplate(templateText: string, variables: Record<string, string | number | null | undefined>): string {
  return templateText.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const val = variables[key];
    return val === null || val === undefined || val === '' ? '—' : String(val);
  });
}

// --- FR-PTY-06 & FR-ACC-08: Party Account Statement Running Balance ---

export function buildPartyLedgerStatement(
  lines: Array<{
    date: string;
    entryNumber: string;
    sourceType: string;
    description: string;
    accountCode: string;
    debit: string | number;
    credit: string | number;
  }>,
): { rows: PartyStatementLine[]; closingBalance: string; totalDebit: string; totalCredit: string } {
  let running = new Decimal(0);
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);

  const rows: PartyStatementLine[] = lines.map((l) => {
    const d = D(l.debit);
    const c = D(l.credit);
    totalDebit = totalDebit.plus(d);
    totalCredit = totalCredit.plus(c);
    running = running.plus(d).minus(c);
    return {
      date: l.date,
      entryNumber: l.entryNumber,
      sourceType: l.sourceType,
      description: l.description,
      accountCode: l.accountCode,
      debit: d.toFixed(2),
      credit: c.toFixed(2),
      balanceAfter: running.toFixed(2),
    };
  });

  return {
    rows,
    closingBalance: running.toFixed(2),
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
  };
}

