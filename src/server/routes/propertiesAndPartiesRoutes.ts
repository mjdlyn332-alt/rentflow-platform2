import { Router } from 'express';
import Decimal from 'decimal.js';
import { D, toFixedMoney } from '../../domain/money';
import { buildPartyLedgerStatement, validatePropertyOwners } from '../../domain/rules';
import { CommissionType, Role, TenureType } from '../../domain/types';
import { AuthenticatedRequest, getTenantDb, hashPassword, requireOrgPermission, requireRole } from '../auth';
import { HttpError, newId, nowIso } from '../db';
import { deriveUnitStatus } from '../domainService';

export function createPropertiesAndPartiesRouter(): Router {
  const router = Router();

  // --- PROPERTIES & UNITS (FR-PRP-01..11) ---

  router.get('/properties', requireOrgPermission('properties', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const properties = tenant.db
        .prepare(
          `SELECT p.*, ps.id AS slot_id, ps.max_units
           FROM properties p
           LEFT JOIN property_slots ps ON ps.property_id = p.id
           WHERE p.organization_id = ? AND p.deleted_at IS NULL
           ORDER BY p.created_at DESC`,
        )
        .all(tenant.organizationId) as any[];

      const slots = tenant.db
        .prepare(`SELECT id, max_units, property_id FROM property_slots WHERE organization_id = ?`)
        .all(tenant.organizationId);

      const enriched = properties.map((p) => {
        const owners = tenant.db
          .prepare(
            `SELECT po.*, pa.name AS party_name, pa.phone AS party_phone
             FROM property_owners po
             JOIN parties pa ON pa.id = po.party_id
             WHERE po.property_id = ? AND po.organization_id = ?`,
          )
          .all(p.id, tenant.organizationId);

        const rawUnits = tenant.db
          .prepare(
            `SELECT u.*, pa.name AS unit_owner_name
             FROM units u
             LEFT JOIN parties pa ON pa.id = u.unit_owner_party_id
             WHERE u.property_id = ? AND u.organization_id = ? AND u.deleted_at IS NULL
             ORDER BY u.unit_number`,
          )
          .all(p.id, tenant.organizationId) as any[];

        const units = rawUnits.map((u) => ({
          ...u,
          derived_status: deriveUnitStatus(tenant, u.id, u.tenure_type),
        }));

        return { ...p, owners, units };
      });

      res.json({ properties: enriched, slots });
    } catch (err) {
      next(err);
    }
  });

  // FR-PRP-01, FR-PRP-03, FR-PRP-06: Atomic Property + Owners + Units + Meters creation
  router.post('/properties', requireOrgPermission('properties', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const idemKey = req.headers['idempotency-key'] as string | undefined;
      const {
        name,
        propertyType,
        address,
        owners,
        commissionType = CommissionType.NONE,
        commissionValue = '0',
        guardName,
        guardPhone,
        guardSalary = '0',
        elevatorsCount,
        parkingSpots,
        areaSqm,
        propertyValue,
        ownerBankAccount,
        units = [],
      } = req.body ?? {};

      if (!name || !propertyType || !address || !Array.isArray(owners) || owners.length === 0) {
        throw new HttpError(400, 'الحقول الإلزامية للعقار: الاسم، النوع، العنوان، والمالك');
      }

      validatePropertyOwners(owners);

      const result = tenant.runAtomic('POST_PROPERTIES', idemKey, () => {
        // Consume a free slot
        const freeSlot = tenant.db
          .prepare(
            `SELECT * FROM property_slots WHERE organization_id = ? AND property_id IS NULL ORDER BY max_units DESC LIMIT 1`,
          )
          .get(tenant.organizationId) as any;

        if (!freeSlot) {
          throw new HttpError(403, 'تم استهلاك جميع حصص العقارات المسموحة في الخطة الحالية');
        }

        if (units.length > freeSlot.max_units) {
          throw new HttpError(
            400,
            `عدد الوحدات (${units.length}) يتجاوز سقف الحصة المسموح (${freeSlot.max_units})`,
          );
        }

        const propId = newId('prp');
        const seq = tenant.nextSequence('property_seq');
        const code = `PRP-${String(seq).padStart(4, '0')}`;
        const now = nowIso();

        tenant.db
          .prepare(
            `INSERT INTO properties
             (id, organization_id, code, name, property_type, address, status, commission_type, commission_value, guard_name, guard_phone, guard_salary, elevators_count, parking_spots, area_sqm, property_value, owner_bank_account, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            propId,
            tenant.organizationId,
            code,
            String(name).trim(),
            String(propertyType).trim(),
            String(address).trim(),
            commissionType,
            toFixedMoney(commissionValue),
            guardName ?? null,
            guardPhone ?? null,
            toFixedMoney(guardSalary),
            elevatorsCount !== undefined && elevatorsCount !== '' ? Number(elevatorsCount) : null,
            parkingSpots !== undefined && parkingSpots !== '' ? Number(parkingSpots) : null,
            areaSqm ? toFixedMoney(areaSqm) : null,
            propertyValue ? toFixedMoney(propertyValue) : null,
            ownerBankAccount ?? null,
            now,
          );

        tenant.db
          .prepare(`UPDATE property_slots SET property_id = ? WHERE id = ? AND organization_id = ?`)
          .run(propId, freeSlot.id, tenant.organizationId);

        for (const o of owners) {
          const party = tenant.assertOwnedRow(
            tenant.db
              .prepare(`SELECT * FROM parties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
              .get(o.partyId, tenant.organizationId) as any,
            'المالك',
          );
          tenant.db
            .prepare(
              `INSERT INTO property_owners (id, organization_id, property_id, party_id, share_percent, is_primary)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(newId('po'), tenant.organizationId, propId, party.id, toFixedMoney(o.sharePercent), o.isPrimary ? 1 : 0);
        }

        const createdUnitIds: string[] = [];
        const seenNums = new Set<string>();
        for (const u of units) {
          const num = String(u.unitNumber ?? '').trim();
          if (!num) throw new HttpError(400, 'رقم الوحدة مطلوب');
          if (seenNums.has(num)) throw new HttpError(400, `رقم الوحدة مكرر: ${num}`);
          seenNums.add(num);

          const tenure = u.tenureType === TenureType.OWNED ? TenureType.OWNED : TenureType.RENTAL;
          if (tenure === TenureType.OWNED && !u.unitOwnerPartyId) {
            throw new HttpError(400, `وحدة التمليك ${num} تتطلب تحديد مالك الوحدة`);
          }
          const unitId = newId('unt');
          tenant.db
            .prepare(
              `INSERT INTO units (id, organization_id, property_id, unit_number, unit_type, floor_number, tenure_type, unit_owner_party_id, area_sqm, bedrooms, bathrooms, reference_rent, notes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              unitId,
              tenant.organizationId,
              propId,
              num,
              String(u.unitType ?? 'شقة سكنية'),
              String(u.floorNumber ?? 'الأول'),
              tenure,
              u.unitOwnerPartyId ?? null,
              toFixedMoney(u.areaSqm ?? '100'),
              u.bedrooms ? Number(u.bedrooms) : null,
              u.bathrooms ? Number(u.bathrooms) : null,
              u.referenceRent ? toFixedMoney(u.referenceRent) : null,
              u.notes ?? null,
              now,
            );
          createdUnitIds.push(unitId);

          if (Array.isArray(u.meters)) {
            for (const m of u.meters) {
              tenant.assertOwnedRow(
                tenant.db
                  .prepare(`SELECT * FROM service_definitions WHERE id = ? AND organization_id = ?`)
                  .get(m.serviceId, tenant.organizationId) as any,
                'الخدمة',
              );
              tenant.db
                .prepare(
                  `INSERT INTO service_meters (id, organization_id, service_id, scope, property_id, unit_id, meter_number, last_reading, created_at)
                   VALUES (?, ?, ?, 'UNIT', ?, ?, ?, ?, ?)`,
                )
                .run(
                  newId('mtr'),
                  tenant.organizationId,
                  m.serviceId,
                  propId,
                  unitId,
                  String(m.meterNumber),
                  toFixedMoney(m.initialReading ?? '0'),
                  now,
                );
            }
          }
        }

        tenant.audit({
          entityType: 'Property',
          entityId: propId,
          action: 'CREATE',
          newValue: { code, name, unitsCount: createdUnitIds.length },
        });

        return { propertyId: propId, code, unitIds: createdUnitIds };
      });

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Update property metadata, optional specs, multi-owners, or archive (FR-PRP-03, FR-PRP-04, FR-PRP-05)
  router.patch('/properties/:id', requireOrgPermission('properties', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const result = tenant.runAtomic('PATCH_PROPERTY', undefined, () => {
        const prop = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM properties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
            .get(req.params.id, tenant.organizationId) as any,
          'العقار',
        );

        const {
          name,
          propertyType,
          address,
          status,
          commissionType,
          commissionValue,
          guardName,
          guardPhone,
          guardSalary,
          elevatorsCount,
          parkingSpots,
          areaSqm,
          propertyValue,
          ownerBankAccount,
          owners,
        } = req.body ?? {};

        if (owners !== undefined) {
          if (!Array.isArray(owners)) throw new HttpError(400, 'قائمة الملاك غير صالحة');
          validatePropertyOwners(owners);
          tenant.db
            .prepare(`DELETE FROM property_owners WHERE property_id = ? AND organization_id = ?`)
            .run(prop.id, tenant.organizationId);
          for (const o of owners) {
            const party = tenant.assertOwnedRow(
              tenant.db
                .prepare(`SELECT * FROM parties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
                .get(o.partyId, tenant.organizationId) as any,
              'المالك',
            );
            tenant.db
              .prepare(
                `INSERT INTO property_owners (id, organization_id, property_id, party_id, share_percent, is_primary)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(newId('po'), tenant.organizationId, prop.id, party.id, toFixedMoney(o.sharePercent), o.isPrimary ? 1 : 0);
          }
        }

        tenant.db
          .prepare(
            `UPDATE properties SET
              name = COALESCE(?, name),
              property_type = COALESCE(?, property_type),
              address = COALESCE(?, address),
              status = COALESCE(?, status),
              commission_type = COALESCE(?, commission_type),
              commission_value = COALESCE(?, commission_value),
              guard_name = COALESCE(?, guard_name),
              guard_phone = COALESCE(?, guard_phone),
              guard_salary = COALESCE(?, guard_salary),
              elevators_count = COALESCE(?, elevators_count),
              parking_spots = COALESCE(?, parking_spots),
              area_sqm = COALESCE(?, area_sqm),
              property_value = COALESCE(?, property_value),
              owner_bank_account = COALESCE(?, owner_bank_account)
             WHERE id = ? AND organization_id = ?`,
          )
          .run(
            name ?? null,
            propertyType ?? null,
            address ?? null,
            status ?? null,
            commissionType ?? null,
            commissionValue !== undefined ? toFixedMoney(commissionValue) : null,
            guardName !== undefined ? (guardName || null) : null,
            guardPhone !== undefined ? (guardPhone || null) : null,
            guardSalary !== undefined ? toFixedMoney(guardSalary) : null,
            elevatorsCount !== undefined && elevatorsCount !== '' ? Number(elevatorsCount) : null,
            parkingSpots !== undefined && parkingSpots !== '' ? Number(parkingSpots) : null,
            areaSqm !== undefined && areaSqm !== '' ? toFixedMoney(areaSqm) : null,
            propertyValue !== undefined && propertyValue !== '' ? toFixedMoney(propertyValue) : null,
            ownerBankAccount !== undefined ? (ownerBankAccount || null) : null,
            prop.id,
            tenant.organizationId,
          );

        tenant.audit({
          entityType: 'Property',
          entityId: prop.id,
          action: 'UPDATE',
          oldValue: { status: prop.status, commissionValue: prop.commission_value },
          newValue: { status: status ?? prop.status, commissionValue: commissionValue ?? prop.commission_value },
        });
        return { ok: true };
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-PRP-05: Soft-delete property ONLY if zero financial transactions, freeing slot
  router.delete('/properties/:id', requireOrgPermission('properties', 'delete'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const result = tenant.runAtomic('DELETE_PROPERTY', undefined, () => {
        const prop = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM properties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
            .get(req.params.id, tenant.organizationId) as any,
          'العقار',
        );

        const hasTx =
          tenant.db
            .prepare(`SELECT id FROM rent_agreements WHERE property_id = ? AND organization_id = ? LIMIT 1`)
            .get(prop.id, tenant.organizationId) ||
          tenant.db
            .prepare(`SELECT id FROM vouchers WHERE property_id = ? AND organization_id = ? LIMIT 1`)
            .get(prop.id, tenant.organizationId) ||
          tenant.db
            .prepare(`SELECT id FROM service_bills WHERE property_id = ? AND organization_id = ? LIMIT 1`)
            .get(prop.id, tenant.organizationId) ||
          tenant.db
            .prepare(`SELECT id FROM maintenance_records WHERE property_id = ? AND organization_id = ? LIMIT 1`)
            .get(prop.id, tenant.organizationId);

        if (hasTx) {
          throw new HttpError(409, 'لا يمكن حذف عقار عليه عقود أو حركات مالية؛ يمكنك أرشفته بدلاً من ذلك');
        }

        const now = nowIso();
        tenant.db
          .prepare(`UPDATE units SET deleted_at = ? WHERE property_id = ? AND organization_id = ?`)
          .run(now, prop.id, tenant.organizationId);
        tenant.db
          .prepare(`UPDATE properties SET deleted_at = ? WHERE id = ? AND organization_id = ?`)
          .run(now, prop.id, tenant.organizationId);
        tenant.db
          .prepare(`UPDATE property_slots SET property_id = NULL WHERE property_id = ? AND organization_id = ?`)
          .run(prop.id, tenant.organizationId);

        tenant.audit({
          entityType: 'Property',
          entityId: prop.id,
          action: 'SOFT_DELETE',
          oldValue: { name: prop.name },
        });
        return { ok: true };
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-PRP-07: Add unit to existing property respecting slot cap (atomic)
  router.post('/properties/:id/units', requireOrgPermission('properties', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const result = tenant.runAtomic('ADD_UNIT', undefined, () => {
        const prop = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM properties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
            .get(req.params.id, tenant.organizationId) as any,
          'العقار',
        );
        const slot = tenant.db
          .prepare(`SELECT * FROM property_slots WHERE property_id = ? AND organization_id = ?`)
          .get(prop.id, tenant.organizationId) as any;
        const countRow = tenant.db
          .prepare(`SELECT COUNT(*) AS cnt FROM units WHERE property_id = ? AND organization_id = ? AND deleted_at IS NULL`)
          .get(prop.id, tenant.organizationId) as { cnt: number };

        if (slot && countRow.cnt >= slot.max_units) {
          throw new HttpError(403, `تم بلوغ الحد الأقصى للوحدات في هذه الحصة (${slot.max_units})`);
        }

        const {
          unitNumber,
          unitType = 'شقة سكنية',
          floorNumber = 'الأول',
          tenureType = TenureType.RENTAL,
          unitOwnerPartyId,
          areaSqm = '100',
          bedrooms,
          bathrooms,
          referenceRent,
          notes,
        } = req.body ?? {};

        if (!unitNumber) throw new HttpError(400, 'رقم الوحدة مطلوب');
        if (tenureType === TenureType.OWNED && !unitOwnerPartyId) {
          throw new HttpError(400, 'وحدة التمليك تتطلب تحديد مالك الوحدة');
        }

        const dup = tenant.db
          .prepare(
            `SELECT id FROM units WHERE property_id = ? AND unit_number = ? AND deleted_at IS NULL`,
          )
          .get(prop.id, String(unitNumber).trim());
        if (dup) throw new HttpError(409, 'رقم الوحدة موجود مسبقاً في هذا العقار');

        const unitId = newId('unt');
        tenant.db
          .prepare(
            `INSERT INTO units (id, organization_id, property_id, unit_number, unit_type, floor_number, tenure_type, unit_owner_party_id, area_sqm, bedrooms, bathrooms, reference_rent, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            unitId,
            tenant.organizationId,
            prop.id,
            String(unitNumber).trim(),
            unitType,
            floorNumber,
            tenureType,
            unitOwnerPartyId ?? null,
            toFixedMoney(areaSqm),
            bedrooms ? Number(bedrooms) : null,
            bathrooms ? Number(bathrooms) : null,
            referenceRent ? toFixedMoney(referenceRent) : null,
            notes ?? null,
            nowIso(),
          );

        tenant.audit({
          entityType: 'Unit',
          entityId: unitId,
          action: 'CREATE',
          newValue: { propertyId: prop.id, unitNumber, tenureType },
        });
        return { unitId };
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-PRP-11: Bulk CSV unit import
  router.post('/properties/:id/units/import', requireOrgPermission('properties', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { rows } = req.body ?? {};
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new HttpError(400, 'قائمة الوحدات للاستيراد فارغة');
      }
      const result = tenant.runAtomic('IMPORT_UNITS', undefined, () => {
        const prop = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM properties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
            .get(req.params.id, tenant.organizationId) as any,
          'العقار',
        );
        const slot = tenant.db
          .prepare(`SELECT * FROM property_slots WHERE property_id = ? AND organization_id = ?`)
          .get(prop.id, tenant.organizationId) as any;
        const countRow = tenant.db
          .prepare(`SELECT COUNT(*) AS cnt FROM units WHERE property_id = ? AND organization_id = ? AND deleted_at IS NULL`)
          .get(prop.id, tenant.organizationId) as { cnt: number };

        if (slot && countRow.cnt + rows.length > slot.max_units) {
          throw new HttpError(
            403,
            `الاستيراد يتجاوز سقف الحصة (${slot.max_units})؛ المتاح حالياً ${slot.max_units - countRow.cnt}`,
          );
        }

        const imported: string[] = [];
        for (const r of rows) {
          const num = String(r.unitNumber ?? '').trim();
          if (!num) throw new HttpError(400, 'صف بدون رقم وحدة');
          const unitId = newId('unt');
          tenant.db
            .prepare(
              `INSERT INTO units (id, organization_id, property_id, unit_number, unit_type, floor_number, tenure_type, area_sqm, reference_rent, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'RENTAL', ?, ?, ?)`,
            )
            .run(
              unitId,
              tenant.organizationId,
              prop.id,
              num,
              String(r.unitType ?? 'شقة سكنية'),
              String(r.floorNumber ?? 'الأول'),
              toFixedMoney(r.areaSqm ?? '100'),
              r.referenceRent ? toFixedMoney(r.referenceRent) : null,
              nowIso(),
            );
          imported.push(unitId);
        }
        return { importedCount: imported.length };
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Update Unit specs & metadata (FR-PRP-10)
  router.patch('/units/:id', requireOrgPermission('properties', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const unit = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM units WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
          .get(req.params.id, tenant.organizationId) as any,
        'الوحدة',
      );
      const { unitNumber, unitType, floorNumber, areaSqm, bedrooms, bathrooms, referenceRent, notes } = req.body ?? {};
      if (unitNumber && String(unitNumber).trim() !== unit.unit_number) {
        const dup = tenant.db
          .prepare(`SELECT id FROM units WHERE property_id = ? AND unit_number = ? AND id != ? AND deleted_at IS NULL`)
          .get(unit.property_id, String(unitNumber).trim(), unit.id);
        if (dup) throw new HttpError(409, 'رقم الوحدة موجود مسبقاً في هذا العقار');
      }

      tenant.db
        .prepare(
          `UPDATE units SET
            unit_number = COALESCE(?, unit_number),
            unit_type = COALESCE(?, unit_type),
            floor_number = COALESCE(?, floor_number),
            area_sqm = COALESCE(?, area_sqm),
            bedrooms = ?,
            bathrooms = ?,
            reference_rent = ?,
            notes = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .run(
          unitNumber ? String(unitNumber).trim() : null,
          unitType ?? null,
          floorNumber ?? null,
          areaSqm ? toFixedMoney(areaSqm) : null,
          bedrooms !== undefined && bedrooms !== '' ? Number(bedrooms) : unit.bedrooms,
          bathrooms !== undefined && bathrooms !== '' ? Number(bathrooms) : unit.bathrooms,
          referenceRent !== undefined ? (referenceRent ? toFixedMoney(referenceRent) : null) : unit.reference_rent,
          notes !== undefined ? (notes || null) : unit.notes,
          unit.id,
          tenant.organizationId,
        );

      tenant.audit({
        entityType: 'Unit',
        entityId: unit.id,
        action: 'UPDATE',
        oldValue: { unitNumber: unit.unit_number, referenceRent: unit.reference_rent },
        newValue: { unitNumber: unitNumber ?? unit.unit_number, referenceRent },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // FR-PRP-09: Assign unit as OWNED (OWNER only, forbidden if active contract exists)
  router.post('/units/:id/assign-owned', requireRole(Role.OWNER), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { unitOwnerPartyId } = req.body ?? {};
      if (!unitOwnerPartyId) {
        throw new HttpError(400, 'يجب تحديد مالك الوحدة');
      }
      const unit = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM units WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
          .get(req.params.id, tenant.organizationId) as any,
        'الوحدة',
      );
      const activeAg = tenant.db
        .prepare(
          `SELECT id FROM rent_agreements WHERE organization_id = ? AND unit_id = ? AND status IN ('ACTIVE', 'NOTICE')`,
        )
        .get(tenant.organizationId, unit.id);
      if (activeAg) {
        throw new HttpError(409, 'ممنوع تعيين الوحدة كتمليك مع وجود عقد إيجار نشط');
      }
      const party = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM parties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
          .get(unitOwnerPartyId, tenant.organizationId) as any,
        'مالك الوحدة',
      );

      tenant.db
        .prepare(`UPDATE units SET tenure_type = 'OWNED', unit_owner_party_id = ? WHERE id = ? AND organization_id = ?`)
        .run(party.id, unit.id, tenant.organizationId);

      const roles: string[] = JSON.parse(party.roles_json);
      if (!roles.includes('UNIT_OWNER')) {
        roles.push('UNIT_OWNER');
        tenant.db
          .prepare(`UPDATE parties SET roles_json = ? WHERE id = ? AND organization_id = ?`)
          .run(JSON.stringify(roles), party.id, tenant.organizationId);
      }

      tenant.audit({
        entityType: 'Unit',
        entityId: unit.id,
        action: 'ASSIGN_OWNED',
        oldValue: { tenureType: unit.tenure_type, unitOwnerPartyId: unit.unit_owner_party_id },
        newValue: { tenureType: 'OWNED', unitOwnerPartyId: party.id },
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- PARTIES (FR-PTY-01..06) ---

  router.get('/parties', requireOrgPermission('parties', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const parties = tenant.db
        .prepare(`SELECT * FROM parties WHERE organization_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`)
        .all(tenant.organizationId) as any[];

      const enriched = parties.map((p) => {
        const portalUser = tenant.db
          .prepare(`SELECT id, email, role, is_active FROM users WHERE party_id = ? AND organization_id = ?`)
          .get(p.id, tenant.organizationId);

        // Compute AR balance from GL 1210/1220 for this party
        const arRow = tenant.db
          .prepare(
            `SELECT debit, credit FROM journal_lines WHERE organization_id = ? AND party_id = ? AND account_code IN ('1210', '1220')`,
          )
          .all(tenant.organizationId, p.id) as Array<{ debit: string; credit: string }>;
        let balance = new Decimal(0);
        for (const r of arRow) {
          balance = balance.plus(D(r.debit)).minus(D(r.credit));
        }

        return {
          ...p,
          roles: JSON.parse(p.roles_json),
          portalUser: portalUser ?? null,
          receivableBalance: balance.toFixed(2),
        };
      });

      res.json({ parties: enriched });
    } catch (err) {
      next(err);
    }
  });

  router.post('/parties', requireOrgPermission('parties', 'create'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { name, nationalId, phone, email, emergencyPhone, roles = ['RENTER'], notes } = req.body ?? {};
      if (!name || !Array.isArray(roles) || roles.length === 0) {
        throw new HttpError(400, 'اسم الطرف ودوره مطلوبان');
      }
      if (roles.includes('RENTER') && (!nationalId || !phone)) {
        throw new HttpError(400, 'رقم الهوية ورقم الهاتف إلزاميان للمستأجر');
      }

      if (nationalId) {
        const dup = tenant.db
          .prepare(
            `SELECT id, name FROM parties WHERE organization_id = ? AND national_id = ? AND deleted_at IS NULL`,
          )
          .get(tenant.organizationId, String(nationalId).trim()) as { id: string; name: string } | undefined;
        if (dup) {
          throw new HttpError(409, `يوجد طرف مسجل بنفس رقم الهوية (${dup.name})`);
        }
      }

      const partyId = newId('pty');
      tenant.db
        .prepare(
          `INSERT INTO parties (id, organization_id, name, national_id, phone, email, emergency_phone, roles_json, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          partyId,
          tenant.organizationId,
          String(name).trim(),
          nationalId ? String(nationalId).trim() : null,
          phone ? String(phone).trim() : null,
          email ? String(email).trim().toLowerCase() : null,
          emergencyPhone ?? null,
          JSON.stringify(roles),
          notes ?? null,
          nowIso(),
        );

      tenant.audit({
        entityType: 'Party',
        entityId: partyId,
        action: 'CREATE',
        newValue: { name, roles },
      });

      res.status(201).json({ partyId });
    } catch (err) {
      next(err);
    }
  });

  // FR-PTY-05: Party full history
  router.get('/parties/:id/history', requireOrgPermission('parties', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const party = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM parties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
          .get(req.params.id, tenant.organizationId) as any,
        'الطرف',
      );
      const contracts = tenant.db
        .prepare(
          `SELECT a.*, u.unit_number, p.name AS property_name
           FROM rent_agreements a
           JOIN units u ON u.id = a.unit_id
           JOIN properties p ON p.id = a.property_id
           WHERE a.organization_id = ? AND a.tenant_party_id = ?
           ORDER BY a.start_date DESC`,
        )
        .all(tenant.organizationId, party.id);

      const vouchers = tenant.db
        .prepare(
          `SELECT * FROM vouchers WHERE organization_id = ? AND party_id = ? ORDER BY voucher_date DESC`,
        )
        .all(tenant.organizationId, party.id);

      const bills = tenant.db
        .prepare(
          `SELECT b.*, sd.name AS service_name, u.unit_number
           FROM service_bills b
           JOIN service_definitions sd ON sd.id = b.service_id
           JOIN units u ON u.id = b.unit_id
           WHERE b.organization_id = ? AND b.payer_party_id = ?
           ORDER BY b.created_at DESC`,
        )
        .all(tenant.organizationId, party.id);

      const notifications = tenant.db
        .prepare(
          `SELECT n.*, nr.read_at
           FROM notification_recipients nr
           JOIN notifications n ON n.id = nr.notification_id
           WHERE nr.organization_id = ? AND nr.party_id = ?
           ORDER BY n.created_at DESC`,
        )
        .all(tenant.organizationId, party.id);

      res.json({ party, contracts, vouchers, bills, notifications });
    } catch (err) {
      next(err);
    }
  });

  // FR-PTY-04: Create portal account for a Party (RENTER | UNIT_OWNER)
  router.post('/parties/:id/portal-account', requireOrgPermission('parties', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const party = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM parties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
          .get(req.params.id, tenant.organizationId) as any,
        'الطرف',
      );
      const { email, password, role } = req.body ?? {};
      if (!email || !password || (role !== Role.RENTER && role !== Role.UNIT_OWNER)) {
        throw new HttpError(400, 'البريد وكلمة المرور والدور (RENTER أو UNIT_OWNER) مطلوبة');
      }

      const settings = tenant.db
        .prepare(`SELECT min_password_length FROM platform_settings WHERE id = 'default'`)
        .get() as { min_password_length: number } | undefined;
      const hash = hashPassword(String(password), settings?.min_password_length ?? 12);
      const normalizedEmail = String(email).trim().toLowerCase();

      const dup = tenant.db.prepare(`SELECT id FROM users WHERE lower(email) = ?`).get(normalizedEmail);
      if (dup) throw new HttpError(409, 'البريد الإلكتروني مستخدم بالفعل');

      const userId = newId('usr');
      tenant.db
        .prepare(
          `INSERT INTO users (id, organization_id, role, email, full_name, password_hash, is_active, token_version, party_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
        )
        .run(userId, tenant.organizationId, role, normalizedEmail, party.name, hash, party.id, nowIso());

      tenant.audit({
        entityType: 'Party',
        entityId: party.id,
        action: 'CREATE_PORTAL_ACCOUNT',
        newValue: { userId, email: normalizedEmail, role },
      });
      res.status(201).json({ userId });
    } catch (err) {
      next(err);
    }
  });

  // Update Party details
  router.patch('/parties/:id', requireOrgPermission('parties', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const party = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM parties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
          .get(req.params.id, tenant.organizationId) as any,
        'الطرف',
      );
      const { name, nationalId, phone, email, emergencyPhone, roles, notes } = req.body ?? {};
      const nextRoles = Array.isArray(roles) && roles.length > 0 ? roles : JSON.parse(party.roles_json);
      const nextNatId = nationalId !== undefined ? (nationalId ? String(nationalId).trim() : null) : party.national_id;
      const nextPhone = phone !== undefined ? (phone ? String(phone).trim() : null) : party.phone;

      if (nextRoles.includes('RENTER') && (!nextNatId || !nextPhone)) {
        throw new HttpError(400, 'رقم الهوية ورقم الهاتف إلزاميان للمستأجر');
      }
      if (nextNatId && nextNatId !== party.national_id) {
        const dup = tenant.db
          .prepare(`SELECT id, name FROM parties WHERE organization_id = ? AND national_id = ? AND id != ? AND deleted_at IS NULL`)
          .get(tenant.organizationId, nextNatId, party.id) as { id: string; name: string } | undefined;
        if (dup) throw new HttpError(409, `يوجد طرف آخر مسجل بنفس رقم الهوية (${dup.name})`);
      }

      tenant.db
        .prepare(
          `UPDATE parties SET
            name = COALESCE(?, name),
            national_id = ?,
            phone = ?,
            email = ?,
            emergency_phone = ?,
            roles_json = ?,
            notes = ?
           WHERE id = ? AND organization_id = ?`,
        )
        .run(
          name ? String(name).trim() : null,
          nextNatId,
          nextPhone,
          email !== undefined ? (email ? String(email).trim().toLowerCase() : null) : party.email,
          emergencyPhone !== undefined ? (emergencyPhone || null) : party.emergency_phone,
          JSON.stringify(nextRoles),
          notes !== undefined ? (notes || null) : party.notes,
          party.id,
          tenant.organizationId,
        );

      tenant.audit({
        entityType: 'Party',
        entityId: party.id,
        action: 'UPDATE',
        oldValue: { name: party.name, phone: party.phone },
        newValue: { name: name ?? party.name, phone: nextPhone },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // FR-PTY-03: Merge duplicate or related party records into target party
  router.post('/parties/merge', requireOrgPermission('parties', 'update'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const { sourcePartyId, targetPartyId } = req.body ?? {};
      if (!sourcePartyId || !targetPartyId || sourcePartyId === targetPartyId) {
        throw new HttpError(400, 'يجب تحديد طرف مصدر وطرف هدف مختلفين للدمج');
      }
      const result = tenant.runAtomic('MERGE_PARTIES', undefined, () => {
        const src = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM parties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
            .get(sourcePartyId, tenant.organizationId) as any,
          'الطرف المصدر',
        );
        const tgt = tenant.assertOwnedRow(
          tenant.db
            .prepare(`SELECT * FROM parties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
            .get(targetPartyId, tenant.organizationId) as any,
          'الطرف الهدف',
        );

        const srcRoles: string[] = JSON.parse(src.roles_json);
        const tgtRoles: string[] = JSON.parse(tgt.roles_json);
        const mergedRoles = Array.from(new Set([...tgtRoles, ...srcRoles]));

        tenant.db
          .prepare(`UPDATE rent_agreements SET tenant_party_id = ? WHERE tenant_party_id = ? AND organization_id = ?`)
          .run(tgt.id, src.id, tenant.organizationId);
        tenant.db
          .prepare(`UPDATE service_bills SET payer_party_id = ? WHERE payer_party_id = ? AND organization_id = ?`)
          .run(tgt.id, src.id, tenant.organizationId);
        tenant.db
          .prepare(`UPDATE vouchers SET party_id = ? WHERE party_id = ? AND organization_id = ?`)
          .run(tgt.id, src.id, tenant.organizationId);
        tenant.db
          .prepare(`UPDATE units SET unit_owner_party_id = ? WHERE unit_owner_party_id = ? AND organization_id = ?`)
          .run(tgt.id, src.id, tenant.organizationId);
        tenant.db
          .prepare(`UPDATE journal_lines SET party_id = ? WHERE party_id = ? AND organization_id = ?`)
          .run(tgt.id, src.id, tenant.organizationId);
        tenant.db
          .prepare(`UPDATE notification_recipients SET party_id = ? WHERE party_id = ? AND organization_id = ?`)
          .run(tgt.id, src.id, tenant.organizationId);
        tenant.db
          .prepare(`UPDATE tenant_maintenance_requests SET tenant_party_id = ? WHERE tenant_party_id = ? AND organization_id = ?`)
          .run(tgt.id, src.id, tenant.organizationId);
        tenant.db
          .prepare(`UPDATE users SET party_id = ? WHERE party_id = ? AND organization_id = ?`)
          .run(tgt.id, src.id, tenant.organizationId);

        const srcOwners = tenant.db
          .prepare(`SELECT * FROM property_owners WHERE party_id = ? AND organization_id = ?`)
          .all(src.id, tenant.organizationId) as any[];
        for (const so of srcOwners) {
          const existingTgt = tenant.db
            .prepare(`SELECT * FROM property_owners WHERE property_id = ? AND party_id = ? AND organization_id = ?`)
            .get(so.property_id, tgt.id, tenant.organizationId) as any;
          if (existingTgt) {
            const combined = D(existingTgt.share_percent).plus(D(so.share_percent)).toFixed(2);
            tenant.db
              .prepare(`UPDATE property_owners SET share_percent = ?, is_primary = ? WHERE id = ?`)
              .run(combined, existingTgt.is_primary || so.is_primary ? 1 : 0, existingTgt.id);
            tenant.db.prepare(`DELETE FROM property_owners WHERE id = ?`).run(so.id);
          } else {
            tenant.db.prepare(`UPDATE property_owners SET party_id = ? WHERE id = ?`).run(tgt.id, so.id);
          }
        }

        tenant.db
          .prepare(
            `UPDATE parties SET
              roles_json = ?,
              national_id = COALESCE(national_id, ?),
              phone = COALESCE(phone, ?),
              email = COALESCE(email, ?),
              emergency_phone = COALESCE(emergency_phone, ?)
             WHERE id = ? AND organization_id = ?`,
          )
          .run(
            JSON.stringify(mergedRoles),
            src.national_id,
            src.phone,
            src.email,
            src.emergency_phone,
            tgt.id,
            tenant.organizationId,
          );

        tenant.db
          .prepare(`UPDATE parties SET deleted_at = ? WHERE id = ? AND organization_id = ?`)
          .run(nowIso(), src.id, tenant.organizationId);

        tenant.audit({
          entityType: 'Party',
          entityId: tgt.id,
          action: 'MERGE',
          oldValue: { mergedSourceId: src.id, sourceName: src.name },
          newValue: { targetPartyId: tgt.id, targetName: tgt.name },
        });
        return { ok: true, targetPartyId: tgt.id };
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // FR-PTY-06 & FR-ACC-08: Party Account Statement (AR & Liabilities ledger with running balance)
  router.get('/parties/:id/statement', requireOrgPermission('parties', 'read'), (req: AuthenticatedRequest, res, next) => {
    try {
      const tenant = getTenantDb(req);
      const party = tenant.assertOwnedRow(
        tenant.db
          .prepare(`SELECT * FROM parties WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
          .get(req.params.id, tenant.organizationId) as any,
        'الطرف',
      );
      const rawLines = tenant.db
        .prepare(
          `SELECT je.entry_date AS date, je.entry_number AS entryNumber, je.source_type AS sourceType,
                  COALESCE(jl.memo, je.description) AS description, jl.account_code AS accountCode,
                  jl.debit, jl.credit
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.journal_entry_id
           WHERE jl.organization_id = ? AND jl.party_id = ? AND jl.account_code IN ('1210', '1220')
           ORDER BY je.entry_date ASC, je.created_at ASC, jl.id ASC`,
        )
        .all(tenant.organizationId, party.id) as any[];

      const statement = buildPartyLedgerStatement(rawLines);
      res.json({ party, statement });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
