import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Role } from '../domain/types';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function newId(prefix = ''): string {
  const raw = crypto.randomUUID();
  return prefix ? `${prefix}_${raw.slice(0, 12)}` : raw;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function openDatabase(dbPath?: string): Database.Database {
  const resolved = dbPath ?? path.resolve(process.cwd(), 'data', 'melaak.db');
  if (resolved !== ':memory:') {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      id TEXT PRIMARY KEY,
      min_password_length INTEGER NOT NULL DEFAULT 12,
      session_ttl_hours INTEGER NOT NULL DEFAULT 8,
      email_from TEXT NOT NULL DEFAULT 'noreply@melaak.sa',
      email_reset_subject TEXT NOT NULL DEFAULT 'رمز استعادة كلمة المرور - منصة مِلاك',
      email_reset_template TEXT NOT NULL DEFAULT 'مرحباً {{name}}، رمز استعادة كلمة المرور الخاص بك هو: {{otp}} (صالح لمدة 15 دقيقة).',
      email_notif_template TEXT NOT NULL DEFAULT 'مرحباً {{name}}، {{title}}: {{body}}',
      email_2fa_template TEXT NOT NULL DEFAULT 'رمز التحقق الثنائي لتسجيل الدخول: {{otp}}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS two_factor_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      otp_hash TEXT NOT NULL,
      challenge_token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_outbox_log (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | SUSPENDED
      timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh',
      base_currency TEXT NOT NULL DEFAULT 'SAR',
      default_grace_days INTEGER NOT NULL DEFAULT 15,
      post_grace_rent_enabled INTEGER NOT NULL DEFAULT 0,
      rounding_step TEXT, -- nullable, e.g. '50' or NULL for exact
      contract_expiry_alert_days INTEGER NOT NULL DEFAULT 30,
      show_hijri_dates INTEGER NOT NULL DEFAULT 0,
      retention_years INTEGER NOT NULL DEFAULT 10,
      property_seq INTEGER NOT NULL DEFAULT 0,
      voucher_seq INTEGER NOT NULL DEFAULT 0,
      journal_seq INTEGER NOT NULL DEFAULT 0,
      bill_seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS property_slots (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      max_units INTEGER NOT NULL,
      property_id TEXT UNIQUE, -- NULL until consumed by a property
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_slots_org ON property_slots(organization_id);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      organization_id TEXT REFERENCES organizations(id), -- NULL only for SUPER_ADMIN
      role TEXT NOT NULL, -- SUPER_ADMIN | OWNER | STAFF | COLLECTOR | RENTER | UNIT_OWNER
      email TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      token_version INTEGER NOT NULL DEFAULT 1,
      party_id TEXT,
      staff_permissions_json TEXT,
      two_factor_enabled INTEGER NOT NULL DEFAULT 0,
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      token_version INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      otp_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS parties (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      national_id TEXT,
      phone TEXT,
      email TEXT,
      emergency_phone TEXT,
      roles_json TEXT NOT NULL, -- JSON array of PartyRole
      notes TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_parties_org ON parties(organization_id);

    CREATE TABLE IF NOT EXISTS properties (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      property_type TEXT NOT NULL,
      address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | ARCHIVED
      commission_type TEXT NOT NULL DEFAULT 'NONE', -- NONE | PERCENTAGE | FIXED
      commission_value TEXT NOT NULL DEFAULT '0.00',
      guard_name TEXT,
      guard_phone TEXT,
      guard_salary TEXT NOT NULL DEFAULT '0.00',
      elevators_count INTEGER,
      parking_spots INTEGER,
      area_sqm TEXT,
      property_value TEXT,
      owner_bank_account TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_properties_org ON properties(organization_id);

    CREATE TABLE IF NOT EXISTS property_owners (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      property_id TEXT NOT NULL REFERENCES properties(id),
      party_id TEXT NOT NULL REFERENCES parties(id),
      share_percent TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      UNIQUE(property_id, party_id)
    );
    CREATE INDEX IF NOT EXISTS idx_prop_owners_org ON property_owners(organization_id, property_id);

    CREATE TABLE IF NOT EXISTS units (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      property_id TEXT NOT NULL REFERENCES properties(id),
      unit_number TEXT NOT NULL,
      unit_type TEXT NOT NULL,
      floor_number TEXT NOT NULL,
      tenure_type TEXT NOT NULL DEFAULT 'RENTAL', -- RENTAL | OWNED
      unit_owner_party_id TEXT REFERENCES parties(id),
      area_sqm TEXT NOT NULL DEFAULT '100.00',
      bedrooms INTEGER,
      bathrooms INTEGER,
      reference_rent TEXT,
      notes TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(property_id, unit_number)
    );
    CREATE INDEX IF NOT EXISTS idx_units_org ON units(organization_id, property_id);

    CREATE TABLE IF NOT EXISTS collectors (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
      can_collect_rent INTEGER NOT NULL DEFAULT 1,
      can_collect_services INTEGER NOT NULL DEFAULT 1,
      can_collect_maintenance INTEGER NOT NULL DEFAULT 0,
      can_create_services INTEGER NOT NULL DEFAULT 0,
      reward_type TEXT NOT NULL DEFAULT 'NONE', -- NONE | PERCENTAGE | FIXED
      reward_value TEXT NOT NULL DEFAULT '0.00',
      is_active INTEGER NOT NULL DEFAULT 1,
      cashbox_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_collectors_org ON collectors(organization_id);

    CREATE TABLE IF NOT EXISTS collector_properties (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      collector_id TEXT NOT NULL REFERENCES collectors(id),
      property_id TEXT NOT NULL REFERENCES properties(id),
      UNIQUE(collector_id, property_id)
    );

    CREATE TABLE IF NOT EXISTS contract_expense_types (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      calc_mode TEXT NOT NULL DEFAULT 'FIXED', -- FIXED | PERCENTAGE
      default_value TEXT NOT NULL DEFAULT '0.00',
      default_charge_to TEXT NOT NULL DEFAULT 'TENANT',
      is_mandatory INTEGER NOT NULL DEFAULT 0,
      account_code TEXT NOT NULL DEFAULT '4400'
    );
    CREATE INDEX IF NOT EXISTS idx_exp_types_org ON contract_expense_types(organization_id);

    CREATE TABLE IF NOT EXISTS rent_agreements (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      property_id TEXT NOT NULL REFERENCES properties(id),
      unit_id TEXT NOT NULL REFERENCES units(id),
      tenant_party_id TEXT NOT NULL REFERENCES parties(id),
      renewed_from_id TEXT REFERENCES rent_agreements(id),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      actual_end_date TEXT,
      total_amount TEXT NOT NULL,
      discount_amount TEXT NOT NULL DEFAULT '0.00',
      frequency TEXT NOT NULL,
      grace_days INTEGER NOT NULL,
      deposit_amount TEXT NOT NULL DEFAULT '0.00',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agreements_org ON rent_agreements(organization_id, unit_id);

    CREATE TABLE IF NOT EXISTS installments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      agreement_id TEXT NOT NULL REFERENCES rent_agreements(id),
      installment_number INTEGER NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      due_date TEXT NOT NULL,
      amount TEXT NOT NULL,
      paid_amount TEXT NOT NULL DEFAULT '0.00',
      waived_amount TEXT NOT NULL DEFAULT '0.00',
      status TEXT NOT NULL DEFAULT 'PENDING',
      accrual_journal_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_installments_org ON installments(organization_id, agreement_id);

    CREATE TABLE IF NOT EXISTS contract_expense_items (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      agreement_id TEXT NOT NULL REFERENCES rent_agreements(id),
      expense_type_id TEXT NOT NULL REFERENCES contract_expense_types(id),
      name TEXT NOT NULL,
      amount TEXT NOT NULL,
      charge_to TEXT NOT NULL,
      paid_amount TEXT NOT NULL DEFAULT '0.00'
    );

    CREATE TABLE IF NOT EXISTS security_deposits (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      agreement_id TEXT NOT NULL UNIQUE REFERENCES rent_agreements(id),
      expected_amount TEXT NOT NULL,
      received_amount TEXT NOT NULL DEFAULT '0.00',
      held_balance TEXT NOT NULL DEFAULT '0.00',
      status TEXT NOT NULL DEFAULT 'HELD',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deposits_org ON security_deposits(organization_id);

    CREATE TABLE IF NOT EXISTS deposit_movements (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      deposit_id TEXT NOT NULL REFERENCES security_deposits(id),
      movement_type TEXT NOT NULL,
      amount TEXT NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dep_moves_org ON deposit_movements(organization_id, deposit_id);

    CREATE TABLE IF NOT EXISTS eviction_requests (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      agreement_id TEXT NOT NULL REFERENCES rent_agreements(id),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'IN_GRACE',
      notice_date TEXT NOT NULL,
      grace_days INTEGER NOT NULL,
      grace_end_date TEXT NOT NULL,
      extended_until TEXT,
      extension_reason TEXT,
      handover_date TEXT,
      advance_rent_credit TEXT NOT NULL DEFAULT '0.00',
      waived_unpaid_rent TEXT NOT NULL DEFAULT '0.00',
      post_grace_rent TEXT NOT NULL DEFAULT '0.00',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evictions_org ON eviction_requests(organization_id, agreement_id);

    CREATE TABLE IF NOT EXISTS move_out_inspections (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      eviction_id TEXT NOT NULL UNIQUE REFERENCES eviction_requests(id),
      keys_returned INTEGER NOT NULL DEFAULT 0,
      tenant_acknowledged INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      final_readings_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS damage_items (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      inspection_id TEXT NOT NULL REFERENCES move_out_inspections(id),
      description TEXT NOT NULL,
      cost TEXT NOT NULL,
      maintenance_id TEXT REFERENCES maintenance_records(id),
      photo_attachment_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settlement_statements (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      eviction_id TEXT NOT NULL UNIQUE REFERENCES eviction_requests(id),
      agreement_id TEXT NOT NULL REFERENCES rent_agreements(id),
      held_deposit TEXT NOT NULL,
      advance_rent_credit TEXT NOT NULL,
      damages_total TEXT NOT NULL,
      unpaid_rent_total TEXT NOT NULL,
      unpaid_services_total TEXT NOT NULL,
      net_payable TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | APPROVED | POSTED
      approved_by_user_id TEXT,
      approved_at TEXT,
      journal_entry_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_definitions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      service_type TEXT NOT NULL, -- METERED | FIXED
      unit_price TEXT NOT NULL DEFAULT '0.00',
      fixed_fee TEXT NOT NULL DEFAULT '0.00',
      frequency TEXT NOT NULL DEFAULT 'MONTHLY',
      default_charge_to TEXT NOT NULL DEFAULT 'TENANT',
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_svc_defs_org ON service_definitions(organization_id);

    CREATE TABLE IF NOT EXISTS service_meters (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      service_id TEXT NOT NULL REFERENCES service_definitions(id),
      scope TEXT NOT NULL, -- UNIT | PROPERTY
      property_id TEXT NOT NULL REFERENCES properties(id),
      unit_id TEXT REFERENCES units(id),
      meter_number TEXT NOT NULL,
      last_reading TEXT NOT NULL DEFAULT '0.00',
      last_reading_date TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meters_org ON service_meters(organization_id, property_id);

    CREATE TABLE IF NOT EXISTS service_readings (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      meter_id TEXT NOT NULL REFERENCES service_meters(id),
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      previous_reading TEXT NOT NULL,
      current_reading TEXT NOT NULL,
      consumption TEXT NOT NULL,
      is_reset INTEGER NOT NULL DEFAULT 0,
      reset_note TEXT,
      recorded_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_readings_org ON service_readings(organization_id, meter_id);

    CREATE TABLE IF NOT EXISTS service_bills (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      bill_number TEXT NOT NULL,
      service_id TEXT NOT NULL REFERENCES service_definitions(id),
      property_id TEXT NOT NULL REFERENCES properties(id),
      unit_id TEXT NOT NULL REFERENCES units(id),
      reading_id TEXT REFERENCES service_readings(id),
      payer_party_id TEXT NOT NULL REFERENCES parties(id),
      payer_role TEXT NOT NULL, -- RENTER | UNIT_OWNER | OWNER
      agreement_id TEXT REFERENCES rent_agreements(id),
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      due_date TEXT NOT NULL,
      amount TEXT NOT NULL,
      paid_amount TEXT NOT NULL DEFAULT '0.00',
      charge_to TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ISSUED',
      journal_entry_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bills_org ON service_bills(organization_id, unit_id);

    CREATE TABLE IF NOT EXISTS shared_cost_policies (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      property_id TEXT NOT NULL REFERENCES properties(id),
      service_id TEXT NOT NULL REFERENCES service_definitions(id),
      method TEXT NOT NULL, -- EQUAL | AREA | CONSUMPTION
      include_owned_units INTEGER NOT NULL DEFAULT 1,
      excluded_unit_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recurring_service_contracts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      service_id TEXT NOT NULL REFERENCES service_definitions(id),
      property_id TEXT NOT NULL REFERENCES properties(id),
      unit_id TEXT NOT NULL REFERENCES units(id),
      amount TEXT NOT NULL,
      charge_to TEXT NOT NULL,
      frequency TEXT NOT NULL,
      next_bill_date TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS maintenance_records (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      property_id TEXT NOT NULL REFERENCES properties(id),
      unit_id TEXT REFERENCES units(id),
      agreement_id TEXT REFERENCES rent_agreements(id),
      maintenance_type TEXT NOT NULL,
      cause TEXT NOT NULL DEFAULT 'NORMAL', -- NORMAL | TENANT_DAMAGE
      description TEXT NOT NULL,
      cost TEXT NOT NULL,
      paid_amount TEXT NOT NULL DEFAULT '0.00',
      charge_to TEXT NOT NULL, -- TENANT | OWNER | SHARED
      vendor_name TEXT,
      maintenance_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | IN_PROGRESS | COMPLETED
      is_periodic INTEGER NOT NULL DEFAULT 0,
      journal_entry_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_maint_org ON maintenance_records(organization_id, property_id);

    CREATE TABLE IF NOT EXISTS cashboxes (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      cashbox_type TEXT NOT NULL, -- MAIN | COLLECTOR | BANK
      account_code TEXT NOT NULL, -- 1110 | 1120 | 1130
      custodian_user_id TEXT,
      balance TEXT NOT NULL DEFAULT '0.00',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cashboxes_org ON cashboxes(organization_id);

    CREATE TABLE IF NOT EXISTS vouchers (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      voucher_number TEXT NOT NULL,
      voucher_type TEXT NOT NULL, -- RECEIPT | PAYMENT | TRANSFER
      cashbox_id TEXT NOT NULL REFERENCES cashboxes(id),
      target_cashbox_id TEXT REFERENCES cashboxes(id),
      party_id TEXT REFERENCES parties(id),
      property_id TEXT REFERENCES properties(id),
      reference_type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      amount TEXT NOT NULL,
      voucher_date TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'POSTED', -- POSTED | REVERSED
      reversed_voucher_id TEXT REFERENCES vouchers(id),
      journal_entry_id TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, voucher_number)
    );
    CREATE INDEX IF NOT EXISTS idx_vouchers_org ON vouchers(organization_id);

    CREATE TABLE IF NOT EXISTS cashbox_transactions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      cashbox_id TEXT NOT NULL REFERENCES cashboxes(id),
      voucher_id TEXT NOT NULL REFERENCES vouchers(id),
      direction TEXT NOT NULL, -- IN | OUT
      amount TEXT NOT NULL,
      balance_after TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cb_tx_org ON cashbox_transactions(organization_id, cashbox_id);

    CREATE TABLE IF NOT EXISTS chart_accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL, -- ASSET | LIABILITY | REVENUE | EXPENSE
      is_system INTEGER NOT NULL DEFAULT 1,
      UNIQUE(organization_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_coa_org ON chart_accounts(organization_id);

    CREATE TABLE IF NOT EXISTS posting_rules (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      doc_type TEXT NOT NULL,
      debit_account_code TEXT NOT NULL,
      credit_account_code TEXT NOT NULL,
      description TEXT NOT NULL,
      UNIQUE(organization_id, doc_type)
    );

    CREATE TABLE IF NOT EXISTS accounting_periods (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      is_closed INTEGER NOT NULL DEFAULT 0,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_periods_org ON accounting_periods(organization_id);

    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      entry_number TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      description TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      property_id TEXT,
      is_manual INTEGER NOT NULL DEFAULT 0,
      reversed_entry_id TEXT REFERENCES journal_entries(id),
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, entry_number)
    );
    CREATE INDEX IF NOT EXISTS idx_je_org ON journal_entries(organization_id, entry_date);

    CREATE TABLE IF NOT EXISTS journal_lines (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id),
      account_code TEXT NOT NULL,
      party_id TEXT,
      property_id TEXT,
      debit TEXT NOT NULL DEFAULT '0.00',
      credit TEXT NOT NULL DEFAULT '0.00',
      memo TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jl_org ON journal_lines(organization_id, account_code);

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      sender_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      audience_type TEXT NOT NULL, -- ALL | PROPERTY | UNIT | PARTY
      audience_target_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notif_org ON notifications(organization_id);

    CREATE TABLE IF NOT EXISTS notification_recipients (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      notification_id TEXT NOT NULL REFERENCES notifications(id),
      user_id TEXT REFERENCES users(id),
      party_id TEXT REFERENCES parties(id),
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notif_rec_org ON notification_recipients(organization_id, user_id);

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      attachment_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data_base64 TEXT NOT NULL,
      entity_type TEXT NOT NULL, -- UNIT | AGREEMENT | DAMAGE | MAINTENANCE | PARTY
      entity_id TEXT NOT NULL,
      uploaded_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attach_org ON attachments(organization_id, entity_type, entity_id);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      organization_id TEXT, -- NULL only for platform-level SUPER_ADMIN actions
      user_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      old_value_json TEXT,
      new_value_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id, created_at);

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, idem_key, endpoint)
    );

    CREATE TABLE IF NOT EXISTS service_tariff_tiers (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      service_id TEXT NOT NULL REFERENCES service_definitions(id),
      tier_order INTEGER NOT NULL,
      from_qty TEXT NOT NULL,
      to_qty TEXT,
      unit_price TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tiers_svc ON service_tariff_tiers(organization_id, service_id);

    CREATE TABLE IF NOT EXISTS maintenance_types (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      default_charge_to TEXT NOT NULL DEFAULT 'OWNER',
      default_cause TEXT NOT NULL DEFAULT 'NORMAL',
      UNIQUE(organization_id, name)
    );

    CREATE TABLE IF NOT EXISTS recurring_maintenance_contracts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      property_id TEXT NOT NULL REFERENCES properties(id),
      unit_id TEXT REFERENCES units(id),
      maintenance_type TEXT NOT NULL,
      description TEXT NOT NULL,
      cost TEXT NOT NULL,
      charge_to TEXT NOT NULL DEFAULT 'OWNER',
      vendor_name TEXT,
      frequency TEXT NOT NULL DEFAULT 'MONTHLY',
      next_date TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_maintenance_requests (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      property_id TEXT NOT NULL REFERENCES properties(id),
      unit_id TEXT NOT NULL REFERENCES units(id),
      agreement_id TEXT NOT NULL REFERENCES rent_agreements(id),
      tenant_party_id TEXT NOT NULL REFERENCES parties(id),
      maintenance_type TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | CONVERTED | REJECTED
      converted_maintenance_id TEXT REFERENCES maintenance_records(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tmreq_org ON tenant_maintenance_requests(organization_id, status);

    CREATE TABLE IF NOT EXISTS contract_templates (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      body_template TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_templates (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      title_template TEXT NOT NULL,
      body_template TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'IN_APP_EMAIL',
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, code)
    );

    CREATE TABLE IF NOT EXISTS scheduled_notifications (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      created_by_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      audience_type TEXT NOT NULL,
      audience_target_id TEXT,
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'SCHEDULED', -- SCHEDULED | SENT | CANCELLED
      sent_at TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Safe incremental column migrations for pre-existing local SQLite databases
  const ensureCol = (table: string, col: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    }
  };
  ensureCol('platform_settings', 'email_reset_subject', `TEXT NOT NULL DEFAULT 'رمز استعادة كلمة المرور - منصة مِلاك'`);
  ensureCol('platform_settings', 'email_reset_template', `TEXT NOT NULL DEFAULT 'مرحباً {{name}}، رمز التحقق الخاص بك هو: {{otp}}'`);
  ensureCol('platform_settings', 'email_notif_template', `TEXT NOT NULL DEFAULT 'مرحباً {{name}}، {{title}}: {{body}}'`);
  ensureCol('platform_settings', 'email_2fa_template', `TEXT NOT NULL DEFAULT 'رمز التحقق الثنائي لتسجيل الدخول: {{otp}}'`);
  ensureCol('contract_expense_items', 'journal_entry_id', `TEXT`);
}

// --- P1 & FR-PLT-06: Strict Tenant DB Guard + Platform DB Guard ---

export interface ActorContext {
  userId: string;
  role: Role;
  organizationId: string | null;
}

export class TenantDb {
  readonly db: Database.Database;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: Role;

  constructor(db: Database.Database, actor: ActorContext) {
    if (actor.role === Role.SUPER_ADMIN || !actor.organizationId) {
      throw new HttpError(403, 'الوصول إلى البيانات التشغيلية محظور على مالك النظام', 'SUPER_ADMIN_ISOLATED');
    }
    this.db = db;
    this.organizationId = actor.organizationId;
    this.userId = actor.userId;
    this.role = actor.role;
  }

  getOrg(): any {
    const org = this.db.prepare('SELECT * FROM organizations WHERE id = ?').get(this.organizationId);
    if (!org) throw new HttpError(404, 'المنشأة غير موجودة');
    return org;
  }

  nextSequence(col: 'property_seq' | 'voucher_seq' | 'journal_seq' | 'bill_seq'): number {
    this.db
      .prepare(`UPDATE organizations SET ${col} = ${col} + 1 WHERE id = ?`)
      .run(this.organizationId);
    const row = this.db
      .prepare(`SELECT ${col} AS seq FROM organizations WHERE id = ?`)
      .get(this.organizationId) as { seq: number };
    return row.seq;
  }

  assertOwnedRow<T extends { organization_id?: string }>(row: T | undefined, label = 'السجل'): T {
    if (!row || row.organization_id !== this.organizationId) {
      throw new HttpError(404, `${label} غير موجود`);
    }
    return row;
  }

  audit(params: {
    entityType: string;
    entityId: string;
    action: string;
    oldValue?: unknown;
    newValue?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_logs (id, organization_id, user_id, entity_type, entity_id, action, old_value_json, new_value_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('aud'),
        this.organizationId,
        this.userId,
        params.entityType,
        params.entityId,
        params.action,
        params.oldValue !== undefined ? JSON.stringify(params.oldValue) : null,
        params.newValue !== undefined ? JSON.stringify(params.newValue) : null,
        nowIso(),
      );
  }

  runAtomic<T>(
    endpoint: string,
    idempotencyKey: string | undefined,
    fn: () => T,
  ): T {
    const tx = this.db.transaction(() => {
      if (idempotencyKey) {
        const existing = this.db
          .prepare(
            `SELECT response_json FROM idempotency_keys WHERE organization_id = ? AND idem_key = ? AND endpoint = ?`,
          )
          .get(this.organizationId, idempotencyKey, endpoint) as { response_json: string } | undefined;
        if (existing) {
          return JSON.parse(existing.response_json) as T;
        }
      }
      const result = fn();
      if (idempotencyKey) {
        this.db
          .prepare(
            `INSERT INTO idempotency_keys (id, organization_id, idem_key, endpoint, response_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(newId('idm'), this.organizationId, idempotencyKey, endpoint, JSON.stringify(result), nowIso());
      }
      return result;
    });
    return tx();
  }
}

export class PlatformDb {
  readonly db: Database.Database;
  readonly userId: string;

  constructor(db: Database.Database, actor: ActorContext) {
    if (actor.role !== Role.SUPER_ADMIN) {
      throw new HttpError(403, 'هذه الصلاحية محصورة بمالك النظام فقط');
    }
    this.db = db;
    this.userId = actor.userId;
  }

  audit(entityType: string, entityId: string, action: string, oldValue?: unknown, newValue?: unknown): void {
    this.db
      .prepare(
        `INSERT INTO audit_logs (id, organization_id, user_id, entity_type, entity_id, action, old_value_json, new_value_json, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('aud'),
        this.userId,
        entityType,
        entityId,
        action,
        oldValue !== undefined ? JSON.stringify(oldValue) : null,
        newValue !== undefined ? JSON.stringify(newValue) : null,
        nowIso(),
      );
  }
}
