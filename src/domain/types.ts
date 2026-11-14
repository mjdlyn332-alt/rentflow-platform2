export enum Role {
  SUPER_ADMIN = 'SUPER_ADMIN',
  OWNER = 'OWNER',
  STAFF = 'STAFF',
  COLLECTOR = 'COLLECTOR',
  RENTER = 'RENTER',
  UNIT_OWNER = 'UNIT_OWNER',
}

export enum OrgStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
}

export enum PropertyStatus {
  ACTIVE = 'ACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export enum CommissionType {
  NONE = 'NONE',
  PERCENTAGE = 'PERCENTAGE',
  FIXED = 'FIXED',
}

export enum TenureType {
  RENTAL = 'RENTAL',
  OWNED = 'OWNED',
}

export enum UnitStatus {
  VACANT = 'VACANT',
  RENTED = 'RENTED',
  MAINTENANCE = 'MAINTENANCE',
}

export enum PartyRole {
  OWNER = 'OWNER',
  RENTER = 'RENTER',
  UNIT_OWNER = 'UNIT_OWNER',
}

export enum CollectionFrequency {
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
  SEMI_ANNUAL = 'SEMI_ANNUAL',
  ANNUAL = 'ANNUAL',
  CUSTOM = 'CUSTOM',
}

export enum RentAgreementStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  NOTICE = 'NOTICE',
  EXPIRED = 'EXPIRED',
  CLOSED = 'CLOSED',
  CANCELED = 'CANCELED',
}

export enum InstallmentStatus {
  PENDING = 'PENDING',
  PARTIAL = 'PARTIAL',
  PAID = 'PAID',
  WAIVED = 'WAIVED',
}

export enum ChargeTo {
  TENANT = 'TENANT',
  OWNER = 'OWNER',
  SHARED = 'SHARED',
}

export enum SecurityDepositStatus {
  HELD = 'HELD',
  PARTIALLY_APPLIED = 'PARTIALLY_APPLIED',
  REFUNDED = 'REFUNDED',
  FORFEITED = 'FORFEITED',
}

export enum DepositMovementType {
  RECEIVED = 'RECEIVED',
  DAMAGE_DEDUCTION = 'DAMAGE_DEDUCTION',
  RENT_DEDUCTION = 'RENT_DEDUCTION',
  SERVICE_DEDUCTION = 'SERVICE_DEDUCTION',
  REFUNDED = 'REFUNDED',
  FORFEITED = 'FORFEITED',
}

export enum EvictionStatus {
  DRAFT = 'DRAFT',
  NOTIFIED = 'NOTIFIED',
  IN_GRACE = 'IN_GRACE',
  OVERDUE = 'OVERDUE',
  HANDED_OVER = 'HANDED_OVER',
  SETTLED = 'SETTLED',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

export enum SettlementStatus {
  DRAFT = 'DRAFT',
  APPROVED = 'APPROVED',
  POSTED = 'POSTED',
}

export enum ServiceType {
  METERED = 'METERED',
  FIXED = 'FIXED',
}

export enum MeterScope {
  UNIT = 'UNIT',
  PROPERTY = 'PROPERTY',
}

export enum ServiceBillStatus {
  ISSUED = 'ISSUED',
  PARTIAL = 'PARTIAL',
  PAID = 'PAID',
  VOID = 'VOID',
}

export enum DistributionMethod {
  EQUAL = 'EQUAL',
  AREA = 'AREA',
  CONSUMPTION = 'CONSUMPTION',
}

export enum MaintenanceCause {
  NORMAL = 'NORMAL',
  TENANT_DAMAGE = 'TENANT_DAMAGE',
}

export enum MaintenanceStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

export enum CashboxType {
  MAIN = 'MAIN',
  COLLECTOR = 'COLLECTOR',
  BANK = 'BANK',
}

export enum VoucherType {
  RECEIPT = 'RECEIPT',
  PAYMENT = 'PAYMENT',
  TRANSFER = 'TRANSFER',
}

export enum VoucherStatus {
  POSTED = 'POSTED',
  REVERSED = 'REVERSED',
}

export enum VoucherReferenceType {
  INSTALLMENT = 'INSTALLMENT',
  SERVICE_BILL = 'SERVICE_BILL',
  MAINTENANCE = 'MAINTENANCE',
  SECURITY_DEPOSIT = 'SECURITY_DEPOSIT',
  SETTLEMENT = 'SETTLEMENT',
  CONTRACT_EXPENSE = 'CONTRACT_EXPENSE',
  CASHBOX_TRANSFER = 'CASHBOX_TRANSFER',
  EXPENSE = 'EXPENSE',
  OTHER = 'OTHER',
}

export enum ChartAccountType {
  ASSET = 'ASSET',
  LIABILITY = 'LIABILITY',
  REVENUE = 'REVENUE',
  EXPENSE = 'EXPENSE',
}

export enum AttachmentType {
  ENTRY_PHOTO = 'ENTRY_PHOTO',
  EXIT_PHOTO = 'EXIT_PHOTO',
  DAMAGE_PHOTO = 'DAMAGE_PHOTO',
  CONTRACT_DOC = 'CONTRACT_DOC',
  ID_DOC = 'ID_DOC',
  OTHER = 'OTHER',
}

export type StaffDomain =
  | 'properties'
  | 'parties'
  | 'contracts'
  | 'services'
  | 'collections'
  | 'maintenance'
  | 'evictions'
  | 'accounting'
  | 'reports'
  | 'notifications'
  | 'settings';

export type StaffAction = 'read' | 'create' | 'update' | 'delete';

export type StaffPermissions = Record<StaffDomain, Record<StaffAction, boolean>>;

export interface CollectorFlags {
  canCollectRent: boolean;
  canCollectServices: boolean;
  canCollectMaintenance: boolean;
  canCreateServices: boolean;
}

export interface TariffTier {
  fromQty: string;
  toQty: string | null;
  unitPrice: string;
}

export interface PartyStatementLine {
  date: string;
  entryNumber: string;
  sourceType: string;
  description: string;
  accountCode: string;
  debit: string;
  credit: string;
  balanceAfter: string;
}

export const ALL_STAFF_DOMAINS: StaffDomain[] = [
  'properties',
  'parties',
  'contracts',
  'services',
  'collections',
  'maintenance',
  'evictions',
  'accounting',
  'reports',
  'notifications',
  'settings',
];

