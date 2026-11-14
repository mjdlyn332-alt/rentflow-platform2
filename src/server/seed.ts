import Database from 'better-sqlite3';
import {
  CollectionFrequency,
  CommissionType,
  Role,
  VoucherReferenceType,
  VoucherType,
} from '../domain/types';
import { addDays } from '../domain/rules';
import { postJournalEntry, seedOrganizationAccounting } from './accounting';
import { buildDefaultStaffPermissions, hashPassword } from './auth';
import { newId, nowIso, TenantDb, todayIso } from './db';
import { accrueInstallmentIfNeeded, createAgreementWithSchedule, createVoucherAtomic } from './domainService';

export function seedInitialDataIfEmpty(db: Database.Database): void {
  const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM users`).get() as { cnt: number };
  if (countRow.cnt > 0) return;

  const tx = db.transaction(() => {
    const now = nowIso();
    // Platform Settings
    db.prepare(
      `INSERT INTO platform_settings (id, min_password_length, session_ttl_hours, email_from, updated_at)
       VALUES ('default', 12, 8, 'noreply@melaak.sa', ?)`,
    ).run(now);

    // 1. SUPER_ADMIN (no organizationId)
    const superAdminId = 'usr_super_admin';
    db.prepare(
      `INSERT INTO users (id, organization_id, role, email, full_name, password_hash, is_active, token_version, created_at)
       VALUES (?, NULL, ?, 'admin@melaak.sa', 'مدير منصة مِلاك', ?, 1, 1, ?)`,
    ).run(superAdminId, Role.SUPER_ADMIN, hashPassword('AdminPass123456'), now);

    // 2. Organization 1: شركة الواحة العقارية
    const org1Id = 'org_waha';
    db.prepare(
      `INSERT INTO organizations (id, name, status, timezone, base_currency, default_grace_days, post_grace_rent_enabled, rounding_step, contract_expiry_alert_days, show_hijri_dates, retention_years, created_at)
       VALUES (?, 'شركة الواحة العقارية', 'ACTIVE', 'Asia/Riyadh', 'SAR', 15, 0, NULL, 30, 1, 10, ?)`,
    ).run(org1Id, now);

    seedOrganizationAccounting(db, org1Id, 2026);

    // 4 property slots for Org 1
    const slot1Id = 'slot_waha_1';
    const slot2Id = 'slot_waha_2';
    db.prepare(
      `INSERT INTO property_slots (id, organization_id, max_units, property_id, created_at) VALUES (?, ?, 12, NULL, ?)`,
    ).run(slot1Id, org1Id, now);
    db.prepare(
      `INSERT INTO property_slots (id, organization_id, max_units, property_id, created_at) VALUES (?, ?, 10, NULL, ?)`,
    ).run(slot2Id, org1Id, now);
    db.prepare(
      `INSERT INTO property_slots (id, organization_id, max_units, property_id, created_at) VALUES (?, ?, 8, NULL, ?)`,
    ).run('slot_waha_3', org1Id, now);
    db.prepare(
      `INSERT INTO property_slots (id, organization_id, max_units, property_id, created_at) VALUES (?, ?, 8, NULL, ?)`,
    ).run('slot_waha_4', org1Id, now);

    // Org 1 Owner
    const owner1Id = 'usr_waha_owner';
    db.prepare(
      `INSERT INTO users (id, organization_id, role, email, full_name, password_hash, is_active, token_version, created_at)
       VALUES (?, ?, ?, 'owner@waha.sa', 'عبدالرحمن بن فهد العتيبي', ?, 1, 1, ?)`,
    ).run(owner1Id, org1Id, Role.OWNER, hashPassword('OwnerPass123456'), now);

    // Org 1 Staff
    const staffPerms = buildDefaultStaffPermissions(false);
    staffPerms.properties = { read: true, create: true, update: true, delete: false };
    staffPerms.parties = { read: true, create: true, update: true, delete: false };
    staffPerms.contracts = { read: true, create: true, update: true, delete: false };
    staffPerms.services = { read: true, create: true, update: true, delete: false };
    staffPerms.collections = { read: true, create: true, update: false, delete: false };
    staffPerms.maintenance = { read: true, create: true, update: true, delete: false };
    staffPerms.evictions = { read: true, create: true, update: true, delete: false };
    staffPerms.accounting = { read: true, create: false, update: false, delete: false };
    staffPerms.reports = { read: true, create: false, update: false, delete: false };
    staffPerms.notifications = { read: true, create: true, update: false, delete: false };

    db.prepare(
      `INSERT INTO users (id, organization_id, role, email, full_name, password_hash, is_active, token_version, staff_permissions_json, created_at)
       VALUES (?, ?, ?, 'staff@waha.sa', 'سارة بنت عبدالله الدوسري', ?, 1, 1, ?, ?)`,
    ).run('usr_waha_staff', org1Id, Role.STAFF, hashPassword('StaffPass123456'), JSON.stringify(staffPerms), now);

    // Org 1 TenantDb context
    const tenant1 = new TenantDb(db, {
      userId: owner1Id,
      role: Role.OWNER,
      organizationId: org1Id,
    });

    // Parties for Org 1
    const partyOwnerId = 'pty_waha_owner';
    const partyRenter1Id = 'pty_waha_renter1';
    const partyRenter2Id = 'pty_waha_renter2';
    const partyUnitOwnerId = 'pty_waha_unitowner';

    db.prepare(
      `INSERT INTO parties (id, organization_id, name, national_id, phone, email, roles_json, created_at)
       VALUES (?, ?, 'شركة الواحة للاستثمار العقاري', '7001122334', '0501112233', 'owner@waha.sa', '["OWNER"]', ?)`,
    ).run(partyOwnerId, org1Id, now);

    db.prepare(
      `INSERT INTO parties (id, organization_id, name, national_id, phone, email, emergency_phone, roles_json, created_at)
       VALUES (?, ?, 'خالد بن محمد السبيعي', '1045566778', '0554433221', 'renter@waha.sa', '0559988776', '["RENTER"]', ?)`,
    ).run(partyRenter1Id, org1Id, now);

    db.prepare(
      `INSERT INTO parties (id, organization_id, name, national_id, phone, email, roles_json, created_at)
       VALUES (?, ?, 'ماجد بن ناصر الحربي', '1088776655', '0543322110', 'majed@example.com', '["RENTER"]', ?)`,
    ).run(partyRenter2Id, org1Id, now);

    db.prepare(
      `INSERT INTO parties (id, organization_id, name, national_id, phone, email, roles_json, created_at)
       VALUES (?, ?, 'نورة بنت سعد القحطاني', '1022334455', '0567788990', 'unitowner@waha.sa', '["UNIT_OWNER"]', ?)`,
    ).run(partyUnitOwnerId, org1Id, now);

    // Portal Users for Renter & Unit Owner
    db.prepare(
      `INSERT INTO users (id, organization_id, role, email, full_name, password_hash, is_active, token_version, party_id, created_at)
       VALUES ('usr_waha_renter', ?, 'RENTER', 'renter@waha.sa', 'خالد بن محمد السبيعي', ?, 1, 1, ?, ?)`,
    ).run(org1Id, hashPassword('RenterPass123456'), partyRenter1Id, now);

    db.prepare(
      `INSERT INTO users (id, organization_id, role, email, full_name, password_hash, is_active, token_version, party_id, created_at)
       VALUES ('usr_waha_unitowner', ?, 'UNIT_OWNER', 'unitowner@waha.sa', 'نورة بنت سعد القحطاني', ?, 1, 1, ?, ?)`,
    ).run(org1Id, hashPassword('UnitOwnerPass123456'), partyUnitOwnerId, now);

    // Properties & Units (consuming slot 1 & slot 2)
    const prop1Id = 'prop_waha_1';
    const seq1 = tenant1.nextSequence('property_seq');
    db.prepare(
      `INSERT INTO properties (id, organization_id, code, name, property_type, address, status, commission_type, commission_value, guard_name, guard_phone, guard_salary, elevators_count, parking_spots, area_sqm, created_at)
       VALUES (?, ?, ?, 'برج الواحة السكني', 'سكني تجاري', 'الرياض - حي العليا - طريق الملك فهد', 'ACTIVE', ?, '4.50', 'سعيد علي', '0531122334', '3000.00', 2, 24, '2400.00', ?)`,
    ).run(prop1Id, org1Id, `PRP-${String(seq1).padStart(4, '0')}`, CommissionType.PERCENTAGE, now);
    db.prepare(`UPDATE property_slots SET property_id = ? WHERE id = ?`).run(prop1Id, slot1Id);
    db.prepare(
      `INSERT INTO property_owners (id, organization_id, property_id, party_id, share_percent, is_primary)
       VALUES (?, ?, ?, ?, '100.00', 1)`,
    ).run(newId('po'), org1Id, prop1Id, partyOwnerId);

    const prop2Id = 'prop_waha_2';
    const seq2 = tenant1.nextSequence('property_seq');
    db.prepare(
      `INSERT INTO properties (id, organization_id, code, name, property_type, address, status, commission_type, commission_value, created_at)
       VALUES (?, ?, ?, 'مجمع النخيل المكتبي', 'تجاري', 'الرياض - حي الملقا', 'ACTIVE', 'NONE', '0.00', ?)`,
    ).run(prop2Id, org1Id, `PRP-${String(seq2).padStart(4, '0')}`, now);
    db.prepare(`UPDATE property_slots SET property_id = ? WHERE id = ?`).run(prop2Id, slot2Id);
    db.prepare(
      `INSERT INTO property_owners (id, organization_id, property_id, party_id, share_percent, is_primary)
       VALUES (?, ?, ?, ?, '100.00', 1)`,
    ).run(newId('po'), org1Id, prop2Id, partyOwnerId);

    // Units in Prop 1: 101 (RENTAL rented), 102 (RENTAL rented), 103 (OWNED), 104 (RENTAL vacant)
    const unit101Id = 'unit_101';
    const unit102Id = 'unit_102';
    const unit103Id = 'unit_103';
    const unit104Id = 'unit_104';
    const unit201Id = 'unit_201';

    db.prepare(
      `INSERT INTO units (id, organization_id, property_id, unit_number, unit_type, floor_number, tenure_type, area_sqm, bedrooms, bathrooms, reference_rent, created_at)
       VALUES (?, ?, ?, '101', 'شقة سكنية', 'الأول', 'RENTAL', '140.00', 3, 2, '48000.00', ?)`,
    ).run(unit101Id, org1Id, prop1Id, now);
    db.prepare(
      `INSERT INTO units (id, organization_id, property_id, unit_number, unit_type, floor_number, tenure_type, area_sqm, bedrooms, bathrooms, reference_rent, created_at)
       VALUES (?, ?, ?, '102', 'شقة سكنية', 'الأول', 'RENTAL', '120.00', 2, 2, '36000.00', ?)`,
    ).run(unit102Id, org1Id, prop1Id, now);
    db.prepare(
      `INSERT INTO units (id, organization_id, property_id, unit_number, unit_type, floor_number, tenure_type, unit_owner_party_id, area_sqm, bedrooms, bathrooms, created_at)
       VALUES (?, ?, ?, '103', 'شقة تمليك', 'الثاني', 'OWNED', ?, '180.00', 4, 3, ?)`,
    ).run(unit103Id, org1Id, prop1Id, partyUnitOwnerId, now);
    db.prepare(
      `INSERT INTO units (id, organization_id, property_id, unit_number, unit_type, floor_number, tenure_type, area_sqm, bedrooms, bathrooms, reference_rent, created_at)
       VALUES (?, ?, ?, '104', 'شقة سكنية', 'الثاني', 'RENTAL', '140.00', 3, 2, '46000.00', ?)`,
    ).run(unit104Id, org1Id, prop1Id, now);
    db.prepare(
      `INSERT INTO units (id, organization_id, property_id, unit_number, unit_type, floor_number, tenure_type, area_sqm, reference_rent, created_at)
       VALUES (?, ?, ?, '201', 'مكتب تجاري', 'الأرضي', 'RENTAL', '220.00', '96000.00', ?)`,
    ).run(unit201Id, org1Id, prop2Id, now);

    // Collector for Org 1
    const collectorUserId = 'usr_waha_collector';
    const collectorCashboxId = 'cb_waha_collector';
    db.prepare(
      `INSERT INTO users (id, organization_id, role, email, full_name, password_hash, is_active, token_version, created_at)
       VALUES (?, ?, 'COLLECTOR', 'collector@waha.sa', 'طارق بن يوسف الغامدي', ?, 1, 1, ?)`,
    ).run(collectorUserId, org1Id, hashPassword('CollectorPass123456'), now);
    db.prepare(
      `INSERT INTO cashboxes (id, organization_id, name, cashbox_type, account_code, custodian_user_id, balance, is_active, created_at)
       VALUES (?, ?, 'صندوق المحصل - طارق الغامدي', 'COLLECTOR', '1120', ?, '0.00', 1, ?)`,
    ).run(collectorCashboxId, org1Id, collectorUserId, now);
    const collectorId = 'col_waha_1';
    db.prepare(
      `INSERT INTO collectors (id, organization_id, user_id, can_collect_rent, can_collect_services, can_collect_maintenance, can_create_services, reward_type, reward_value, is_active, cashbox_id, created_at)
       VALUES (?, ?, ?, 1, 1, 1, 1, 'PERCENTAGE', '2.00', 1, ?, ?)`,
    ).run(collectorId, org1Id, collectorUserId, collectorCashboxId, now);
    db.prepare(
      `INSERT INTO collector_properties (id, organization_id, collector_id, property_id) VALUES (?, ?, ?, ?)`,
    ).run(newId('cp'), org1Id, collectorId, prop1Id);
    db.prepare(
      `INSERT INTO collector_properties (id, organization_id, collector_id, property_id) VALUES (?, ?, ?, ?)`,
    ).run(newId('cp'), org1Id, collectorId, prop2Id);

    // Service Definitions & Meters
    const svcElecId = 'svc_elec';
    const svcWaterId = 'svc_water';
    const svcCleanId = 'svc_clean';

    db.prepare(
      `INSERT INTO service_definitions (id, organization_id, code, name, service_type, unit_price, fixed_fee, frequency, default_charge_to, created_at)
       VALUES (?, ?, 'ELEC', 'كهرباء', 'METERED', '0.25', '15.00', 'MONTHLY', 'TENANT', ?)`,
    ).run(svcElecId, org1Id, now);
    db.prepare(
      `INSERT INTO service_definitions (id, organization_id, code, name, service_type, unit_price, fixed_fee, frequency, default_charge_to, created_at)
       VALUES (?, ?, 'WATER', 'مياه', 'METERED', '4.00', '10.00', 'MONTHLY', 'TENANT', ?)`,
    ).run(svcWaterId, org1Id, now);
    db.prepare(
      `INSERT INTO service_definitions (id, organization_id, code, name, service_type, unit_price, fixed_fee, frequency, default_charge_to, created_at)
       VALUES (?, ?, 'CLEAN', 'نظافة ومرافق مشتركة', 'FIXED', '0.00', '300.00', 'MONTHLY', 'SHARED', ?)`,
    ).run(svcCleanId, org1Id, now);

    const meter101Id = 'mtr_101_elec';
    const meter103Id = 'mtr_103_elec';
    const meterProp1WaterId = 'mtr_prop1_water';
    db.prepare(
      `INSERT INTO service_meters (id, organization_id, service_id, scope, property_id, unit_id, meter_number, last_reading, last_reading_date, created_at)
       VALUES (?, ?, ?, 'UNIT', ?, ?, 'EL-101-A', '1200.00', '2026-10-01', ?)`,
    ).run(meter101Id, org1Id, svcElecId, prop1Id, unit101Id, now);
    db.prepare(
      `INSERT INTO service_meters (id, organization_id, service_id, scope, property_id, unit_id, meter_number, last_reading, last_reading_date, created_at)
       VALUES (?, ?, ?, 'UNIT', ?, ?, 'EL-103-A', '850.00', '2026-10-01', ?)`,
    ).run(meter103Id, org1Id, svcElecId, prop1Id, unit103Id, now);
    db.prepare(
      `INSERT INTO service_meters (id, organization_id, service_id, scope, property_id, unit_id, meter_number, last_reading, last_reading_date, created_at)
       VALUES (?, ?, ?, 'PROPERTY', ?, NULL, 'WT-SHARED-P1', '450.00', '2026-10-01', ?)`,
    ).run(meterProp1WaterId, org1Id, svcWaterId, prop1Id, now);

    // Contract 1 for Unit 101 (Khaled)
    const { agreementId: agr1Id } = createAgreementWithSchedule(tenant1, {
      unitId: unit101Id,
      tenantPartyId: partyRenter1Id,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      totalAmount: '48000.00',
      discountAmount: '0.00',
      frequency: CollectionFrequency.QUARTERLY,
      graceDays: 15,
      depositAmount: '4000.00',
      notes: 'عقد إيجار سنوي — دفعات ربع سنوية',
    });

    // Contract 2 for Unit 102 (Majed)
    const { agreementId: agr2Id } = createAgreementWithSchedule(tenant1, {
      unitId: unit102Id,
      tenantPartyId: partyRenter2Id,
      startDate: '2026-07-01',
      endDate: '2027-06-30',
      totalAmount: '36000.00',
      discountAmount: '0.00',
      frequency: CollectionFrequency.QUARTERLY,
      graceDays: 15,
      depositAmount: '3000.00',
    });

    // Contract 3 for Unit 201 (Majed) — Nearing expiry (~14 days from today) for real-time alert showcase
    const today = todayIso();
    const { agreementId: agr3Id } = createAgreementWithSchedule(tenant1, {
      unitId: unit201Id,
      tenantPartyId: partyRenter2Id,
      startDate: addDays(today, -350),
      endDate: addDays(today, 14),
      totalAmount: '96000.00',
      discountAmount: '0.00',
      frequency: CollectionFrequency.ANNUAL,
      graceDays: 15,
      depositAmount: '0.00',
      notes: 'عقد مكتب تجاري قارب على الانتهاء',
    });

    const mainCb = db
      .prepare(`SELECT id FROM cashboxes WHERE organization_id = ? AND cashbox_type = 'MAIN'`)
      .get(org1Id) as { id: string };

    // Collect Security Deposit for Contract 1 into Main Cashbox
    const dep1 = db
      .prepare(`SELECT id FROM security_deposits WHERE agreement_id = ? AND organization_id = ?`)
      .get(agr1Id, org1Id) as { id: string };
    createVoucherAtomic(tenant1, {
      voucherType: VoucherType.RECEIPT,
      cashboxId: mainCb.id,
      referenceType: VoucherReferenceType.SECURITY_DEPOSIT,
      referenceId: dep1.id,
      amount: '4000.00',
      voucherDate: '2026-01-01',
      description: 'استلام تأمين وحدة 101',
    });

    // Accrue Q1, Q2, Q3, Q4 of Contract 1 up to 2026-11-14 and collect Q1, Q2, Q3
    const insts1 = db
      .prepare(`SELECT * FROM installments WHERE agreement_id = ? AND organization_id = ? ORDER BY installment_number`)
      .all(agr1Id, org1Id) as any[];

    for (const inst of insts1) {
      accrueInstallmentIfNeeded(tenant1, inst, inst.due_date);
    }
    // Collect Q1 & Q2 into Main Cashbox, Q3 into Collector Cashbox
    createVoucherAtomic(tenant1, {
      voucherType: VoucherType.RECEIPT,
      cashboxId: mainCb.id,
      referenceType: VoucherReferenceType.INSTALLMENT,
      referenceId: insts1[0].id,
      amount: insts1[0].amount,
      voucherDate: '2026-01-02',
    });
    createVoucherAtomic(tenant1, {
      voucherType: VoucherType.RECEIPT,
      cashboxId: mainCb.id,
      referenceType: VoucherReferenceType.INSTALLMENT,
      referenceId: insts1[1].id,
      amount: insts1[1].amount,
      voucherDate: '2026-04-02',
    });
    createVoucherAtomic(tenant1, {
      voucherType: VoucherType.RECEIPT,
      cashboxId: collectorCashboxId,
      referenceType: VoucherReferenceType.INSTALLMENT,
      referenceId: insts1[2].id,
      amount: insts1[2].amount,
      voucherDate: '2026-07-05',
    });

    // Accrue & settle Contract 3 annual installment so it is current while approaching contract end date
    const insts3 = db
      .prepare(`SELECT * FROM installments WHERE agreement_id = ? AND organization_id = ? ORDER BY installment_number`)
      .all(agr3Id, org1Id) as any[];
    if (insts3.length > 0) {
      accrueInstallmentIfNeeded(tenant1, insts3[0], insts3[0].due_date);
      createVoucherAtomic(tenant1, {
        voucherType: VoucherType.RECEIPT,
        cashboxId: mainCb.id,
        referenceType: VoucherReferenceType.INSTALLMENT,
        referenceId: insts3[0].id,
        amount: insts3[0].amount,
        voucherDate: insts3[0].due_date,
        description: 'تحصيل إيجار مكتب 201 السنوي',
      });
    }

    // Seed an OPEN owner common-area maintenance task & a PENDING tenant maintenance request (Unit 102)
    db.prepare(
      `INSERT INTO maintenance_records
       (id, organization_id, property_id, unit_id, agreement_id, maintenance_type, cause, description, cost, paid_amount, charge_to, vendor_name, maintenance_date, status, is_periodic, journal_entry_id, created_at)
       VALUES ('mnt_seed_elev', ?, ?, NULL, NULL, 'مصاعد', 'NORMAL', 'فحص دوري لحساسات المصعد الرئيسي بالبرج', '850.00', '0.00', 'OWNER', 'شركة المصاعد الحديثة', ?, 'OPEN', 1, NULL, ?)`,
    ).run(org1Id, prop1Id, today, now);

    db.prepare(
      `INSERT INTO tenant_maintenance_requests
       (id, organization_id, property_id, unit_id, agreement_id, tenant_party_id, maintenance_type, description, status, created_at)
       VALUES ('tmr_seed_102', ?, ?, ?, ?, ?, 'تكييف', 'ضعف تبريد المكيف المركزي في الصالة', 'PENDING', ?)`,
    ).run(org1Id, prop1Id, unit102Id, agr2Id, partyRenter2Id, now);

    // Issue a sample metered Service Bill for Unit 101 (RENTER) and Unit 103 (UNIT_OWNER)
    const bill1Id = newId('bill');
    const bSeq1 = tenant1.nextSequence('bill_seq');
    const bill1Je = postJournalEntry(tenant1, {
      entryDate: '2026-10-31',
      description: 'فاتورة كهرباء وحدة 101 - أكتوبر 2026',
      sourceType: 'SERVICE_BILL',
      sourceId: bill1Id,
      propertyId: prop1Id,
      lines: [
        { accountCode: '1210', debit: '140.00', partyId: partyRenter1Id, propertyId: prop1Id, memo: 'كهرباء أكتوبر' },
        { accountCode: '4200', credit: '140.00', partyId: partyRenter1Id, propertyId: prop1Id, memo: 'إيراد خدمات مستردة' },
      ],
    });
    db.prepare(
      `INSERT INTO service_bills (id, organization_id, bill_number, service_id, property_id, unit_id, payer_party_id, payer_role, agreement_id, period_start, period_end, due_date, amount, paid_amount, charge_to, status, journal_entry_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'RENTER', ?, '2026-10-01', '2026-10-31', '2026-11-10', '140.00', '0.00', 'TENANT', 'ISSUED', ?, ?)`,
    ).run(bill1Id, org1Id, `BILL-${String(bSeq1).padStart(5, '0')}`, svcElecId, prop1Id, unit101Id, partyRenter1Id, agr1Id, bill1Je, now);

    const bill2Id = newId('bill');
    const bSeq2 = tenant1.nextSequence('bill_seq');
    const bill2Je = postJournalEntry(tenant1, {
      entryDate: '2026-10-31',
      description: 'فاتورة كهرباء وحدة التمليك 103 - أكتوبر 2026',
      sourceType: 'SERVICE_BILL',
      sourceId: bill2Id,
      propertyId: prop1Id,
      lines: [
        { accountCode: '1220', debit: '95.00', partyId: partyUnitOwnerId, propertyId: prop1Id, memo: 'كهرباء وحدة تمليك' },
        { accountCode: '4200', credit: '95.00', partyId: partyUnitOwnerId, propertyId: prop1Id, memo: 'إيراد خدمات مستردة' },
      ],
    });
    db.prepare(
      `INSERT INTO service_bills (id, organization_id, bill_number, service_id, property_id, unit_id, payer_party_id, payer_role, agreement_id, period_start, period_end, due_date, amount, paid_amount, charge_to, status, journal_entry_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'UNIT_OWNER', NULL, '2026-10-01', '2026-10-31', '2026-11-10', '95.00', '0.00', 'TENANT', 'ISSUED', ?, ?)`,
    ).run(bill2Id, org1Id, `BILL-${String(bSeq2).padStart(5, '0')}`, svcElecId, prop1Id, unit103Id, partyUnitOwnerId, bill2Je, now);

    // Sample Entry Documentation Photo (SVG data URL stored safely in attachments table, accessible via signed/authenticated endpoint)
    const sampleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360" viewBox="0 0 600 360"><rect width="600" height="360" fill="#F1F5F9"/><rect x="30" y="30" width="540" height="300" rx="8" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="2"/><text x="300" y="165" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#0F172A">توثيق تسليم واستلام وحدة 101 — برج الواحة</text><text x="300" y="205" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#475569">الصالة الرئيسية والأرضيات بحالة ممتازة عند الدخول</text></svg>`;
    db.prepare(
      `INSERT INTO attachments (id, organization_id, attachment_type, file_name, mime_type, size_bytes, data_base64, entity_type, entity_id, uploaded_by_user_id, created_at)
       VALUES ('att_entry_101', ?, 'ENTRY_PHOTO', 'entry_living_room_101.svg', 'image/svg+xml', ?, ?, 'AGREEMENT', ?, ?, ?)`,
    ).run(org1Id, Buffer.byteLength(sampleSvg), Buffer.from(sampleSvg).toString('base64'), agr1Id, owner1Id, now);

    // Sample Notification for Tenant & Unit Owner
    const ntf1Id = newId('ntf');
    db.prepare(
      `INSERT INTO notifications (id, organization_id, sender_user_id, title, body, audience_type, audience_target_id, created_at)
       VALUES (?, ?, ?, 'جدولة صيانة دورية للمصاعد', 'نعلمكم بوجود فحص دوري لمصاعد برج الواحة يوم الخميس من الساعة 10 صباحاً حتى 12 ظهراً.', 'PROPERTY', ?, ?)`,
    ).run(ntf1Id, org1Id, owner1Id, prop1Id, now);
    db.prepare(
      `INSERT INTO notification_recipients (id, organization_id, notification_id, user_id, party_id) VALUES (?, ?, ?, 'usr_waha_renter', ?)`,
    ).run(newId('nrec'), org1Id, ntf1Id, partyRenter1Id);
    db.prepare(
      `INSERT INTO notification_recipients (id, organization_id, notification_id, user_id, party_id) VALUES (?, ?, ?, 'usr_waha_unitowner', ?)`,
    ).run(newId('nrec'), org1Id, ntf1Id, partyUnitOwnerId);

    // 3. Organization 2: مجموعة المدار للعقارات (for cross-tenant isolation verification)
    const org2Id = 'org_madar';
    db.prepare(
      `INSERT INTO organizations (id, name, status, timezone, base_currency, default_grace_days, post_grace_rent_enabled, created_at)
       VALUES (?, 'مجموعة المدار للعقارات', 'ACTIVE', 'Asia/Riyadh', 'SAR', 15, 0, ?)`,
    ).run(org2Id, now);
    seedOrganizationAccounting(db, org2Id, 2026);
    db.prepare(
      `INSERT INTO property_slots (id, organization_id, max_units, property_id, created_at) VALUES ('slot_madar_1', ?, 6, NULL, ?)`,
    ).run(org2Id, now);
    const owner2Id = 'usr_madar_owner';
    db.prepare(
      `INSERT INTO users (id, organization_id, role, email, full_name, password_hash, is_active, token_version, created_at)
       VALUES (?, ?, 'OWNER', 'owner2@madar.sa', 'فيصل بن تركي الشهري', ?, 1, 1, ?)`,
    ).run(owner2Id, org2Id, hashPassword('OwnerPass123456'), now);
    const tenant2 = new TenantDb(db, { userId: owner2Id, role: Role.OWNER, organizationId: org2Id });
    db.prepare(
      `INSERT INTO parties (id, organization_id, name, national_id, phone, roles_json, created_at)
       VALUES ('pty_madar_owner', ?, 'شركة المدار', '7009988776', '0509988776', '["OWNER"]', ?)`,
    ).run(org2Id, now);
    const mSeq = tenant2.nextSequence('property_seq');
    db.prepare(
      `INSERT INTO properties (id, organization_id, code, name, property_type, address, status, created_at)
       VALUES ('prop_madar_1', ?, ?, 'برج المدار الإداري', 'تجاري', 'جدة - طريق الملك عبدالعزيز', 'ACTIVE', ?)`,
    ).run(org2Id, `PRP-${String(mSeq).padStart(4, '0')}`, now);
    db.prepare(`UPDATE property_slots SET property_id = 'prop_madar_1' WHERE id = 'slot_madar_1'`).run();
    db.prepare(
      `INSERT INTO property_owners (id, organization_id, property_id, party_id, share_percent, is_primary)
       VALUES (?, ?, 'prop_madar_1', 'pty_madar_owner', '100.00', 1)`,
    ).run(newId('po'), org2Id);
  });

  tx();
}
