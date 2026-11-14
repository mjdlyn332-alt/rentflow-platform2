import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Decimal from 'decimal.js';
import { createApiApp } from './app';
import { reconcileOrganization } from './accounting';
import { openDatabase, TenantDb } from './db';
import { seedInitialDataIfEmpty } from './seed';
import { Role } from '../domain/types';

async function withTestServer(fn: (baseUrl: string, db: ReturnType<typeof openDatabase>) => Promise<void>) {
  const db = openDatabase(':memory:');
  seedInitialDataIfEmpty(db);
  const app = createApiApp(db);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(baseUrl, db);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

async function loginAs(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `Expected login 200 for ${email}`);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie, 'Expected session cookie');
  return cookie.split(';')[0];
}

test('P1 & FR-PLT-06: Multi-tenant isolation & SUPER_ADMIN blocked from operational data', async () => {
  await withTestServer(async (baseUrl, db) => {
    // 1. Direct DB guard check
    assert.throws(() => {
      new TenantDb(db, { userId: 'usr_super_admin', role: Role.SUPER_ADMIN, organizationId: null });
    });
    assert.throws(() => {
      new TenantDb(db, { userId: 'usr_super_admin', role: Role.SUPER_ADMIN, organizationId: 'org_waha' });
    });

    // 2. SUPER_ADMIN HTTP checks
    const saCookie = await loginAs(baseUrl, 'admin@melaak.sa', 'AdminPass123456');
    const orgsRes = await fetch(`${baseUrl}/api/platform/organizations`, {
      headers: { Cookie: saCookie },
    });
    assert.equal(orgsRes.status, 200);
    const orgsJson = (await orgsRes.json()) as any;
    assert.ok(orgsJson.organizations.length >= 2);
    // Verify no operational details (like tenant names or property names) leaked
    assert.equal(orgsJson.organizations[0].properties, undefined);

    const saPropRes = await fetch(`${baseUrl}/api/properties`, {
      headers: { Cookie: saCookie },
    });
    assert.equal(saPropRes.status, 403);

    // 3. Cross-tenant isolation: Org 2 owner cannot read or mutate Org 1 properties
    const owner2Cookie = await loginAs(baseUrl, 'owner2@madar.sa', 'OwnerPass123456');
    const owner2PropsRes = await fetch(`${baseUrl}/api/properties`, {
      headers: { Cookie: owner2Cookie },
    });
    assert.equal(owner2PropsRes.status, 200);
    const owner2Props = (await owner2PropsRes.json()) as any;
    assert.equal(owner2Props.properties.length, 1);
    assert.equal(owner2Props.properties[0].id, 'prop_madar_1');

    // Attempt to add unit to Org 1 property as Org 2 owner -> 404/403
    const crossUnitRes = await fetch(`${baseUrl}/api/properties/prop_waha_1/units`, {
      method: 'POST',
      headers: { Cookie: owner2Cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ unitNumber: 'HACK-999' }),
    });
    assert.equal(crossUnitRes.status, 404);

    // 4. Renter portal only sees their own contract, never other tenants
    const renterCookie = await loginAs(baseUrl, 'renter@waha.sa', 'RenterPass123456');
    const renterPortalRes = await fetch(`${baseUrl}/api/portal/renter`, {
      headers: { Cookie: renterCookie },
    });
    assert.equal(renterPortalRes.status, 200);
    const renterData = (await renterPortalRes.json()) as any;
    assert.equal(renterData.agreements.length, 1);
    assert.equal(renterData.agreements[0].unit_number, '101');
    // Renter cannot access owner accounting
    const renterAccRes = await fetch(`${baseUrl}/api/accounting/overview`, {
      headers: { Cookie: renterCookie },
    });
    assert.equal(renterAccRes.status, 403);
  });
});

test('P2, P11 & Section 8.3: Seed reconciliation passes, idempotency prevents double voucher, and full eviction-settlement lifecycle leaves deposit=0 & GL balanced', async () => {
  await withTestServer(async (baseUrl, db) => {
    const ownerCookie = await loginAs(baseUrl, 'owner@waha.sa', 'OwnerPass123456');

    // 1. Seeded accounting is 100% balanced & reconciled
    const tenant1 = new TenantDb(db, { userId: 'usr_waha_owner', role: Role.OWNER, organizationId: 'org_waha' });
    const initialRec = reconcileOrganization(tenant1);
    assert.equal(initialRec.isBalanced, true, JSON.stringify(initialRec));

    // 2. Slot & unit cap enforcement + OWNED unit rejection for rental contract
    const ownedContractRes = await fetch(`${baseUrl}/api/contracts`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unitId: 'unit_103', // OWNED unit
        tenantPartyId: 'pty_waha_renter1',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        totalAmount: '30000',
        frequency: 'ANNUAL',
      }),
    });
    assert.equal(ownedContractRes.status, 400);

    // 3. Idempotency key on voucher prevents double collection
    const contractsRes = await fetch(`${baseUrl}/api/contracts`, { headers: { Cookie: ownerCookie } });
    const contractsJson = (await contractsRes.json()) as any;
    const agr1 = contractsJson.agreements.find((a: any) => a.unit_id === 'unit_101');
    const q4 = contractsJson.installments.find(
      (i: any) => i.agreement_id === agr1.id && i.installment_number === 4,
    );
    assert.equal(q4.status, 'PENDING');

    const colRes = await fetch(`${baseUrl}/api/collections`, { headers: { Cookie: ownerCookie } });
    const colJson = (await colRes.json()) as any;
    const mainCb = colJson.cashboxes.find((c: any) => c.cashbox_type === 'MAIN');

    const idemHeaders = {
      Cookie: ownerCookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem-pay-q4-half',
    };
    const pay1 = await fetch(`${baseUrl}/api/collections/vouchers`, {
      method: 'POST',
      headers: idemHeaders,
      body: JSON.stringify({
        voucherType: 'RECEIPT',
        cashboxId: mainCb.id,
        referenceType: 'INSTALLMENT',
        referenceId: q4.id,
        amount: '6000.00',
        voucherDate: '2026-10-15',
      }),
    });
    assert.equal(pay1.status, 201);
    const pay1Body = await pay1.json();

    // Repeat with same idempotency key -> returns same voucher without double debit
    const pay2 = await fetch(`${baseUrl}/api/collections/vouchers`, {
      method: 'POST',
      headers: idemHeaders,
      body: JSON.stringify({
        voucherType: 'RECEIPT',
        cashboxId: mainCb.id,
        referenceType: 'INSTALLMENT',
        referenceId: q4.id,
        amount: '6000.00',
        voucherDate: '2026-10-15',
      }),
    });
    assert.equal(pay2.status, 201);
    const pay2Body = await pay2.json();
    assert.deepEqual(pay1Body, pay2Body);

    // 4. Full Eviction -> Grace Period (zero rent) -> Handover with Damage Photo -> Settlement Approve & Post
    const evInitRes = await fetch(`${baseUrl}/api/evictions`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agreementId: agr1.id,
        reason: 'انتهاء رغبة المستأجر بالبقاء',
        noticeDate: '2026-11-01',
        graceDays: 15,
      }),
    });
    assert.equal(evInitRes.status, 201);
    const evInit = (await evInitRes.json()) as any;
    assert.ok(new Decimal(evInit.waivedUnpaidRent).gt(0));

    // Upload damage photo attachment
    const attRes = await fetch(`${baseUrl}/api/attachments`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachmentType: 'DAMAGE_PHOTO',
        fileName: 'wall_damage.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('fake-png-bytes').toString('base64'),
        entityType: 'EVICTION',
        entityId: evInit.evictionId,
      }),
    });
    assert.equal(attRes.status, 201);
    const attBody = (await attRes.json()) as any;

    // Handover
    const handoverRes = await fetch(`${baseUrl}/api/evictions/${evInit.evictionId}/handover`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handoverDate: '2026-11-12',
        keysReturned: true,
        tenantAcknowledged: true,
        notes: 'استلام كامل المفاتيح مع تلف دهان الصالة',
        damages: [
          {
            description: 'إصلاح دهان جدار الصالة',
            cost: '650.00',
            photoAttachmentId: attBody.attachmentId,
          },
        ],
      }),
    });
    assert.equal(handoverRes.status, 201);
    const handoverBody = (await handoverRes.json()) as any;

    // Approve & post settlement
    const postStlRes = await fetch(`${baseUrl}/api/settlements/${handoverBody.settlementId}/approve-post`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cashboxId: mainCb.id }),
    });
    assert.equal(postStlRes.status, 200);

    // Verify Deposit held balance === 0.00 and Reconciliation passes 100%
    const depRow = db
      .prepare(`SELECT held_balance, status FROM security_deposits WHERE agreement_id = ?`)
      .get(agr1.id) as { held_balance: string; status: string };
    assert.equal(depRow.held_balance, '0.00');

    const finalRec = reconcileOrganization(tenant1);
    assert.equal(finalRec.isBalanced, true, JSON.stringify(finalRec));
  });
});

test('FR-IAM-05/07: 2FA OTP login challenge and Staff 11x4 permission matrix enforcement', async () => {
  await withTestServer(async (baseUrl) => {
    const ownerCookie = await loginAs(baseUrl, 'owner@waha.sa', 'OwnerPass123456');

    // Enable 2FA for owner
    const toggleRes = await fetch(`${baseUrl}/api/auth/2fa/toggle`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(toggleRes.status, 200);

    // Next login requires 2FA OTP challenge
    const loginStep1 = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@waha.sa', password: 'OwnerPass123456' }),
    });
    assert.equal(loginStep1.status, 200);
    const step1Json = (await loginStep1.json()) as any;
    assert.equal(step1Json.requiresTwoFactor, true);
    assert.ok(step1Json.challengeToken);
    assert.ok(step1Json.devOtp);

    const loginStep2 = await fetch(`${baseUrl}/api/auth/login/verify-2fa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: step1Json.challengeToken, otp: step1Json.devOtp }),
    });
    assert.equal(loginStep2.status, 200);
    assert.ok(loginStep2.headers.get('set-cookie'));

    // Create a STAFF user with read-only maintenance & properties, no collections or accounting access
    const staffCreateRes = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'STAFF',
        fullName: 'موظف صيانة مقيد',
        email: 'limitedstaff@waha.sa',
        password: 'StaffPass123456',
        staffPermissions: {
          properties: { read: true, create: false, update: false, delete: false },
          parties: { read: false, create: false, update: false, delete: false },
          contracts: { read: false, create: false, update: false, delete: false },
          services: { read: false, create: false, update: false, delete: false },
          collections: { read: false, create: false, update: false, delete: false },
          maintenance: { read: true, create: true, update: false, delete: false },
          evictions: { read: false, create: false, update: false, delete: false },
          accounting: { read: false, create: false, update: false, delete: false },
          reports: { read: false, create: false, update: false, delete: false },
          notifications: { read: false, create: false, update: false, delete: false },
          settings: { read: false, create: false, update: false, delete: false },
        },
      }),
    });
    assert.equal(staffCreateRes.status, 201);

    const staffCookie = await loginAs(baseUrl, 'limitedstaff@waha.sa', 'StaffPass123456');
    // Allowed: properties.read, maintenance.read
    assert.equal((await fetch(`${baseUrl}/api/properties`, { headers: { Cookie: staffCookie } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/maintenance`, { headers: { Cookie: staffCookie } })).status, 200);
    // Forbidden: accounting.read, collections.read, properties.create
    assert.equal((await fetch(`${baseUrl}/api/accounting/overview`, { headers: { Cookie: staffCookie } })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/collections`, { headers: { Cookie: staffCookie } })).status, 403);
    assert.equal(
      (
        await fetch(`${baseUrl}/api/properties`, {
          method: 'POST',
          headers: { Cookie: staffCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'غير مصرح', propertyType: 'سكني', address: 'الرياض', owners: [] }),
        })
      ).status,
      403,
    );
  });
});

test('FR-PTY-03/06, FR-SVC-10, FR-POR-02, FR-EVC-08, FR-ACC-07/08 & FR-ATT-01: Full extended workflows keep GL balanced', async () => {
  await withTestServer(async (baseUrl, db) => {
    const ownerCookie = await loginAs(baseUrl, 'owner@waha.sa', 'OwnerPass123456');
    const renterCookie = await loginAs(baseUrl, 'renter@waha.sa', 'RenterPass123456');
    const collectorCookie = await loginAs(baseUrl, 'collector@waha.sa', 'CollectorPass123456');

    // 1. Party Merge & Ledger Statement
    const dupPartyRes = await fetch(`${baseUrl}/api/parties`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'خالد السبيعي (مكرر)',
        phone: '0550000111',
        nationalId: '1099887766',
        roles: ['UNIT_OWNER'],
      }),
    });
    assert.equal(dupPartyRes.status, 201);
    const { partyId: srcPartyId } = (await dupPartyRes.json()) as any;

    const mergeRes = await fetch(`${baseUrl}/api/parties/merge`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePartyId: srcPartyId, targetPartyId: 'pty_waha_renter1' }),
    });
    assert.equal(mergeRes.status, 200);

    const stmtRes = await fetch(`${baseUrl}/api/parties/pty_waha_renter1/statement`, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(stmtRes.status, 200);
    const stmtJson = (await stmtRes.json()) as any;
    assert.ok(stmtJson.statement.rows.length >= 4);

    // 2. Tiered service tariff + Meter reading -> Bill -> Void Bill
    const tieredSvcRes = await fetch(`${baseUrl}/api/services/definitions`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'WATER_TIER',
        name: 'مياه شرائح',
        serviceType: 'METERED',
        unitPrice: '1.00',
        fixedFee: '10.00',
        tiers: [
          { fromQty: '0', toQty: '10', unitPrice: '2.00' },
          { fromQty: '10', toQty: null, unitPrice: '5.00' },
        ],
      }),
    });
    assert.equal(tieredSvcRes.status, 201);
    const { id: svcId } = (await tieredSvcRes.json()) as any;

    const meterRes = await fetch(`${baseUrl}/api/services/meters`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceId: svcId,
        scope: 'UNIT',
        propertyId: 'prop_waha_1',
        unitId: 'unit_101',
        meterNumber: 'WT-TIER-101',
        initialReading: '100',
      }),
    });
    assert.equal(meterRes.status, 201);
    const { id: meterId } = (await meterRes.json()) as any;

    // Consumption = 25 (10*2 + 15*5 + 10 fixed = 105.00)
    const rdgRes = await fetch(`${baseUrl}/api/services/readings`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meterId,
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        currentReading: '125',
      }),
    });
    assert.equal(rdgRes.status, 201);
    const rdgJson = (await rdgRes.json()) as any;
    assert.equal(rdgJson.totalAmount, '105.00');

    const voidRes = await fetch(`${baseUrl}/api/services/bills/${rdgJson.issuedBillIds[0]}/void`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'خطأ في قراءة الشرائح' }),
    });
    assert.equal(voidRes.status, 200);

    // 3. Renter maintenance request -> Owner convert -> Collector collect MAINTENANCE
    const renterPortalRes = await fetch(`${baseUrl}/api/portal/renter`, { headers: { Cookie: renterCookie } });
    const renterPortal = (await renterPortalRes.json()) as any;
    const agrId = renterPortal.agreements[0].id;

    const reqMaintRes = await fetch(`${baseUrl}/api/portal/renter/maintenance-requests`, {
      method: 'POST',
      headers: { Cookie: renterCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agreementId: agrId,
        maintenanceType: 'سباكة',
        description: 'تسريب تحت المغسلة',
      }),
    });
    assert.equal(reqMaintRes.status, 201);
    const { requestId } = (await reqMaintRes.json()) as any;

    const convRes = await fetch(`${baseUrl}/api/maintenance/requests/${requestId}/convert`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'CONVERT',
        cost: '250.00',
        chargeTo: 'TENANT',
        cause: 'TENANT_DAMAGE',
        vendorName: 'شركة الصيانة السريعة',
      }),
    });
    assert.equal(convRes.status, 200);
    const { maintenanceId } = (await convRes.json()) as any;

    const colMaintRes = await fetch(`${baseUrl}/api/portal/collector/collect`, {
      method: 'POST',
      headers: { Cookie: collectorCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        referenceType: 'MAINTENANCE',
        referenceId: maintenanceId,
        amount: '250.00',
        voucherDate: '2026-11-14',
      }),
    });
    assert.equal(colMaintRes.status, 201);

    // 4. Eviction -> Extend Grace -> Withdraw with restoreGraceRent
    const evInitRes = await fetch(`${baseUrl}/api/evictions`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agreementId: agrId,
        reason: 'تأخر سداد',
        noticeDate: '2026-11-01',
        graceDays: 10,
      }),
    });
    assert.equal(evInitRes.status, 201);
    const { evictionId } = (await evInitRes.json()) as any;

    const extRes = await fetch(`${baseUrl}/api/evictions/${evictionId}/extend`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ extendedUntil: '2026-11-25', reason: 'تعهد بالسداد' }),
    });
    assert.equal(extRes.status, 200);

    const withdrawRes = await fetch(`${baseUrl}/api/evictions/${evictionId}/withdraw`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ restoreGraceRent: true }),
    });
    assert.equal(withdrawRes.status, 200);

    // 5. Add custom account + Manual Journal Entry + Reversal + General Ledger
    const addAccRes = await fetch(`${baseUrl}/api/accounting/accounts`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '5600', name: 'مصروفات إدارية متنوعة', accountType: 'EXPENSE' }),
    });
    assert.equal(addAccRes.status, 201);

    const manualJeRes = await fetch(`${baseUrl}/api/accounting/journal-entries`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryDate: '2026-11-14',
        description: 'قيد تسوية تجريبي',
        lines: [
          { accountCode: '5600', debit: '100.00', memo: 'مصروف إداري' },
          { accountCode: '2120', credit: '100.00', memo: 'مستحقات دائنين' },
        ],
      }),
    });
    assert.equal(manualJeRes.status, 201);
    const { entryId } = (await manualJeRes.json()) as any;

    const revJeRes = await fetch(`${baseUrl}/api/accounting/journal-entries/${entryId}/reverse`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'عكس القيد التجريبي' }),
    });
    assert.equal(revJeRes.status, 201);

    const ledgerRes = await fetch(`${baseUrl}/api/accounting/ledger?accountCode=1210`, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(ledgerRes.status, 200);
    const ledgerJson = (await ledgerRes.json()) as any;
    assert.ok(ledgerJson.lines.length > 0);

    // 6. HMAC Signed URL for attachment serves file without cookie
    const signedRes = await fetch(`${baseUrl}/api/attachments/att_entry_101/signed-url`, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(signedRes.status, 200);
    const { url: signedPath } = (await signedRes.json()) as any;
    const contentRes = await fetch(`${baseUrl}${signedPath}`);
    assert.equal(contentRes.status, 200);
    assert.ok((await contentRes.text()).includes('<svg'));

    // Tampered HMAC signature is rejected
    const badContentRes = await fetch(`${baseUrl}${signedPath}tamper`);
    assert.equal(badContentRes.status, 403);

    // 7. Summary endpoint returns expiring contracts and pending maintenance for org_waha, isolated from org_madar
    const wahaSummaryRes = await fetch(`${baseUrl}/api/reports/summary`, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(wahaSummaryRes.status, 200);
    const wahaSummary = (await wahaSummaryRes.json()) as any;
    assert.ok(wahaSummary.expiringContracts.length >= 1);
    assert.ok(wahaSummary.pendingMaintenance.some((m: any) => m.id === 'mnt_seed_elev'));
    assert.ok(wahaSummary.pendingMaintenanceRequests.some((r: any) => r.id === 'tmr_seed_102'));

    const owner2Cookie = await loginAs(baseUrl, 'owner2@madar.sa', 'OwnerPass123456');
    const madarSummaryRes = await fetch(`${baseUrl}/api/reports/summary`, {
      headers: { Cookie: owner2Cookie },
    });
    assert.equal(madarSummaryRes.status, 200);
    const madarSummary = (await madarSummaryRes.json()) as any;
    assert.equal(madarSummary.expiringContracts.length, 0);
    assert.equal(madarSummary.pendingMaintenance.length, 0);
    assert.equal(madarSummary.pendingMaintenanceRequests.length, 0);

    // 8. Full Accounting Reconciliation holds after every operation
    const tenant1 = new TenantDb(db, { userId: 'usr_waha_owner', role: Role.OWNER, organizationId: 'org_waha' });
    const rec = reconcileOrganization(tenant1);
    assert.equal(rec.isBalanced, true, JSON.stringify(rec));
  });
});
