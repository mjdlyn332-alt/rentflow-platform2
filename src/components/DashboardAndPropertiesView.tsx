import React, { useEffect, useMemo, useState } from 'react';
import { Archive, BellRing, Building2, CheckCircle2, Edit3, Paperclip, Play, Plus, Trash2, Upload } from 'lucide-react';
import { buildDashboardAlertToasts } from '../domain/alerts';
import { apiFetch, AuthUser, formatDateDisplay, formatMoney, OrganizationInfo } from '../lib/api';
import { AttachmentsModal } from './DocumentAndAttachmentModals';
import { ToastNotificationsPanel } from './ToastNotificationsPanel';
import {
  dangerBtnCls,
  EmptyState,
  ErrorBanner,
  Field,
  inputCls,
  LoadingRows,
  Modal,
  Panel,
  primaryBtnCls,
  secondaryBtnCls,
  StatTile,
  StatusText,
  SuccessBanner,
} from './UiPrimitives';

export function DashboardView({
  org,
  onNavigate,
}: {
  org: OrganizationInfo;
  onNavigate: (tab: string) => void;
}) {
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jobMsg, setJobMsg] = useState<string | null>(null);
  const [dismissedToastIds, setDismissedToastIds] = useState<string[]>([]);
  const [toastsOpen, setToastsOpen] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/reports/summary');
      setSummary(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const alertData = useMemo(() => {
    const today = summary?.today ?? new Date().toISOString().slice(0, 10);
    return buildDashboardAlertToasts({
      today,
      expiringContracts: summary?.expiringContracts ?? [],
      pendingMaintenance: summary?.pendingMaintenance ?? [],
      pendingMaintenanceRequests: summary?.pendingMaintenanceRequests ?? [],
      dismissedIds: dismissedToastIds,
      maxVisible: 5,
    });
  }, [summary, dismissedToastIds]);

  async function runDailyJobs() {
    setError(null);
    setJobMsg(null);
    try {
      const [acc, ev] = await Promise.all([
        apiFetch<{ accruedCount: number; notificationsSent: number }>('/api/contracts/accrue-due', {
          method: 'POST',
          body: JSON.stringify({}),
        }),
        apiFetch<{ movedToOverdue: number }>('/api/evictions/check-daily', {
          method: 'POST',
          body: JSON.stringify({}),
        }),
      ]);
      setJobMsg(
        `تم تشغيل المهام اليومية: استحقاق ${acc.accruedCount} قسط، إرسال ${acc.notificationsSent} تنبيه، وتحديث ${ev.movedToOverdue} طلب إخلاء متأخر.`,
      );
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function handleDismissOneToast(id: string) {
    setDismissedToastIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  function handleDismissAllToasts() {
    setToastsOpen(false);
    setDismissedToastIds(alertData.allToasts.map((t) => t.id));
  }

  function handleToggleToasts() {
    if (toastsOpen && alertData.visibleToasts.length > 0) {
      setToastsOpen(false);
    } else {
      setDismissedToastIds([]);
      setToastsOpen(true);
    }
  }

  if (loading) return <LoadingRows rows={6} />;

  const occ = summary?.occupancy ?? {};
  const chg = summary?.chargeToSummary ?? {};
  const rec = summary?.reconciliation;
  const hasAnyAlerts = alertData.allToasts.length > 0;
  const hasVisibleToasts = toastsOpen && alertData.visibleToasts.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">لوحة المؤشرات والعمليات — {org.name}</h1>
          <p className="text-xs text-slate-500 mt-1">
            نظرة تنفيذية على الإشغال، المستحقات، جهة التحميل، ومطابقة الدفتر العام
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasAnyAlerts && (
            <button
              type="button"
              onClick={handleToggleToasts}
              className={secondaryBtnCls}
            >
              <BellRing className="w-4 h-4 text-amber-700" aria-hidden="true" />
              <span>
                {hasVisibleToasts
                  ? `إخفاء التنبيهات (${alertData.visibleToasts.length})`
                  : `عرض التنبيهات (${alertData.allToasts.length})`}
              </span>
            </button>
          )}
          <button type="button" onClick={runDailyJobs} className={secondaryBtnCls}>
            <Play className="w-4 h-4" aria-hidden="true" />
            <span>تشغيل المهام اليومية (الاستحقاق والإخلاء)</span>
          </button>
        </div>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={jobMsg} onDismiss={() => setJobMsg(null)} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile
          label="إشغال الوحدات الإيجارية"
          value={`${occ.rentedCount ?? 0} / ${occ.rentalUnits ?? 0}`}
          meta={`شاغر: ${occ.vacantCount ?? 0} · تمليك (مستثنى من الإيجار): ${occ.ownedCount ?? 0}`}
        />
        <StatTile
          label="على حساب المستأجر"
          value={formatMoney(chg.onTenantTotal, org.base_currency)}
          meta={`خدمات: ${formatMoney(chg.tenantServices, org.base_currency)}`}
        />
        <StatTile
          label="على حساب المالك"
          value={formatMoney(chg.onOwnerTotal, org.base_currency)}
          meta={`صيانة: ${formatMoney(chg.ownerMaintenance, org.base_currency)}`}
        />
        <StatTile
          label="مطابقة الدفتر العام (8.3)"
          value={rec?.isBalanced ? 'متطابق 100%' : 'يوجد فرق'}
          meta={`الذمم: ${formatMoney(rec?.receivables?.glArBalance, org.base_currency)}`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel
          title="الأقساط المتأخرة"
          subtitle="الأقساط المستحقة غير المسددة قبل تاريخ اليوم"
          action={
            <button type="button" onClick={() => onNavigate('collections')} className="text-xs font-medium text-teal-700 hover:underline">
              الذهاب للتحصيل
            </button>
          }
        >
          {(summary?.overdueInstallments ?? []).length === 0 ? (
            <EmptyState title="لا توجد أقساط متأخرة" description="جميع الأقساط المستحقة حتى اليوم مسددة." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-right">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2 font-medium">العقار / الوحدة</th>
                    <th className="py-2 font-medium">المستأجر</th>
                    <th className="py-2 font-medium">الاستحقاق</th>
                    <th className="py-2 font-medium">المبلغ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {summary.overdueInstallments.slice(0, 6).map((item: any) => (
                    <tr key={item.id}>
                      <td className="py-2.5 text-slate-900">
                        {item.property_name} · وحدة {item.unit_number}
                      </td>
                      <td className="py-2.5 text-slate-600">{item.tenant_name}</td>
                      <td className="py-2.5 font-mono text-xs text-red-700 whitespace-nowrap">
                        <span dir="ltr" className="inline-block">{item.due_date}</span>
                        {Boolean(org.show_hijri_dates) && (
                          <span className="block text-[11px] text-slate-500 whitespace-nowrap">
                            {formatDateDisplay(item.due_date, true).replace(item.due_date, '').trim()}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 font-mono tabular-nums font-medium whitespace-nowrap" dir="ltr">
                        {formatMoney(Number(item.amount) - Number(item.paid_amount) - Number(item.waived_amount ?? 0), org.base_currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="عقود قريبة الانتهاء وعمولات الإدارة"
          subtitle={`العقود التي تنتهي خلال ${org.contract_expiry_alert_days} يوماً`}
          action={
            <button type="button" onClick={() => onNavigate('accounting')} className="text-xs font-medium text-teal-700 hover:underline">
              كشف المطابقة والميزان
            </button>
          }
        >
          <div className="space-y-4">
            {(summary?.expiringContracts ?? []).length > 0 ? (
              <div className="space-y-2">
                {summary.expiringContracts.slice(0, 4).map((ag: any) => (
                  <div key={ag.id} className="flex items-center justify-between gap-2 text-sm py-2 border-b border-slate-100">
                    <span className="text-slate-800">
                      {ag.property_name} · وحدة {ag.unit_number} ({ag.tenant_name})
                    </span>
                    <span className="font-mono text-xs text-amber-700 whitespace-nowrap" dir="ltr">
                      {ag.end_date}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">لا توجد عقود تقترب من الانتهاء حالياً.</p>
            )}

            <div className="pt-3 border-t border-slate-200">
              <div className="text-xs font-semibold text-slate-700 mb-2">عمولة الإدارة المحسوبة من إعداد العقار</div>
              <div className="space-y-1.5">
                {(summary?.commissions ?? []).map((c: any) => (
                  <div key={c.propertyId} className="flex items-center justify-between text-xs text-slate-600">
                    <span>
                      {c.propertyName} ({c.commissionType === 'PERCENTAGE' ? `${c.commissionValue}%` : c.commissionType === 'FIXED' ? 'مبلغ ثابت' : 'بدون عمولة'})
                    </span>
                    <span className="font-mono tabular-nums text-slate-900 font-medium">
                      {formatMoney(c.commissionAmount, org.base_currency)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <ToastNotificationsPanel
        open={toastsOpen}
        toasts={alertData.visibleToasts}
        hiddenCount={alertData.hiddenCount}
        onDismissOne={handleDismissOneToast}
        onDismissAll={handleDismissAllToasts}
        onNavigate={(tab) => onNavigate(tab)}
      />
    </div>
  );
}

export function PropertiesView({
  user,
  org,
}: {
  user: AuthUser;
  org: OrganizationInfo;
}) {
  const [properties, setProperties] = useState<any[]>([]);
  const [slots, setSlots] = useState<any[]>([]);
  const [parties, setParties] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editProp, setEditProp] = useState<any>(null);
  const [editUnit, setEditUnit] = useState<any>(null);
  const [addUnitProp, setAddUnitProp] = useState<any>(null);
  const [ownedUnitTarget, setOwnedUnitTarget] = useState<any>(null);
  const [csvProp, setCsvProp] = useState<any>(null);
  const [attTarget, setAttTarget] = useState<{ entityType: string; entityId: string; label: string } | null>(null);
  const [csvText, setCsvText] = useState('301,شقة سكنية,الثالث,135,45000\n302,شقة سكنية,الثالث,140,47000');

  // Create Property Form (multi-owners + optional specs + units + initial meter)
  const [propForm, setPropForm] = useState({
    name: '',
    propertyType: 'سكني',
    address: '',
    commissionType: 'NONE',
    commissionValue: '0',
    guardName: '',
    guardPhone: '',
    guardSalary: '0',
    elevatorsCount: '',
    parkingSpots: '',
    areaSqm: '',
    propertyValue: '',
    ownerBankAccount: '',
  });
  const [propOwners, setPropOwners] = useState<Array<{ partyId: string; sharePercent: string; isPrimary: boolean }>>([
    { partyId: '', sharePercent: '100', isPrimary: true },
  ]);
  const [draftUnits, setDraftUnits] = useState<
    Array<{
      unitNumber: string;
      unitType: string;
      floorNumber: string;
      tenureType: string;
      unitOwnerPartyId: string;
      areaSqm: string;
      bedrooms: string;
      bathrooms: string;
      referenceRent: string;
      serviceId: string;
      meterNumber: string;
      initialReading: string;
    }>
  >([
    {
      unitNumber: '101',
      unitType: 'شقة سكنية',
      floorNumber: 'الأول',
      tenureType: 'RENTAL',
      unitOwnerPartyId: '',
      areaSqm: '120',
      bedrooms: '3',
      bathrooms: '2',
      referenceRent: '40000',
      serviceId: '',
      meterNumber: '',
      initialReading: '0',
    },
  ]);

  const [editPropForm, setEditPropForm] = useState<any>({});
  const [editPropOwners, setEditPropOwners] = useState<Array<{ partyId: string; sharePercent: string; isPrimary: boolean }>>([]);

  const [unitForm, setUnitForm] = useState({
    unitNumber: '',
    unitType: 'شقة سكنية',
    floorNumber: 'الأول',
    tenureType: 'RENTAL',
    unitOwnerPartyId: '',
    areaSqm: '120',
    bedrooms: '3',
    bathrooms: '2',
    referenceRent: '',
    notes: '',
  });
  const [editUnitForm, setEditUnitForm] = useState<any>({});
  const [assignOwnerPartyId, setAssignOwnerPartyId] = useState('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [pRes, paRes, svcRes] = await Promise.all([
        apiFetch('/api/properties'),
        apiFetch('/api/parties'),
        apiFetch('/api/services').catch(() => ({ services: [] })),
      ]);
      setProperties(pRes.properties);
      setSlots(pRes.slots);
      setParties(paRes.parties);
      setServices(svcRes.services ?? []);
      if (paRes.parties.length > 0 && !propOwners[0]?.partyId) {
        setPropOwners([{ partyId: paRes.parties[0].id, sharePercent: '100', isPrimary: true }]);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreateProperty(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/properties', {
        method: 'POST',
        idempotencyKey: `prop_${Date.now()}`,
        body: JSON.stringify({
          name: propForm.name,
          propertyType: propForm.propertyType,
          address: propForm.address,
          owners: propOwners,
          commissionType: propForm.commissionType,
          commissionValue: propForm.commissionValue,
          guardName: propForm.guardName || undefined,
          guardPhone: propForm.guardPhone || undefined,
          guardSalary: propForm.guardSalary,
          elevatorsCount: propForm.elevatorsCount || undefined,
          parkingSpots: propForm.parkingSpots || undefined,
          areaSqm: propForm.areaSqm || undefined,
          propertyValue: propForm.propertyValue || undefined,
          ownerBankAccount: propForm.ownerBankAccount || undefined,
          units: draftUnits.map((du) => ({
            unitNumber: du.unitNumber,
            unitType: du.unitType,
            floorNumber: du.floorNumber,
            tenureType: du.tenureType,
            unitOwnerPartyId: du.unitOwnerPartyId || undefined,
            areaSqm: du.areaSqm,
            bedrooms: du.bedrooms || undefined,
            bathrooms: du.bathrooms || undefined,
            referenceRent: du.referenceRent || undefined,
            meters: du.serviceId && du.meterNumber ? [{ serviceId: du.serviceId, meterNumber: du.meterNumber, initialReading: du.initialReading || '0' }] : undefined,
          })),
        }),
      });
      setCreateOpen(false);
      setPropForm({
        name: '',
        propertyType: 'سكني',
        address: '',
        commissionType: 'NONE',
        commissionValue: '0',
        guardName: '',
        guardPhone: '',
        guardSalary: '0',
        elevatorsCount: '',
        parkingSpots: '',
        areaSqm: '',
        propertyValue: '',
        ownerBankAccount: '',
      });
      setSuccess('تم إنشاء العقار ووحداته وملاكه في معاملة ذرية واحدة بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleEditProperty(e: React.FormEvent) {
    e.preventDefault();
    if (!editProp) return;
    setError(null);
    try {
      await apiFetch(`/api/properties/${editProp.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...editPropForm, owners: editPropOwners }),
      });
      setEditProp(null);
      setSuccess('تم تحديث بيانات العقار والملاك بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleEditUnit(e: React.FormEvent) {
    e.preventDefault();
    if (!editUnit) return;
    setError(null);
    try {
      await apiFetch(`/api/units/${editUnit.id}`, {
        method: 'PATCH',
        body: JSON.stringify(editUnitForm),
      });
      setEditUnit(null);
      setSuccess('تم تحديث بيانات الوحدة.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleAddUnit(e: React.FormEvent) {
    e.preventDefault();
    if (!addUnitProp) return;
    setError(null);
    try {
      await apiFetch(`/api/properties/${addUnitProp.id}/units`, {
        method: 'POST',
        body: JSON.stringify(unitForm),
      });
      setAddUnitProp(null);
      setUnitForm({
        unitNumber: '',
        unitType: 'شقة سكنية',
        floorNumber: 'الأول',
        tenureType: 'RENTAL',
        unitOwnerPartyId: '',
        areaSqm: '120',
        bedrooms: '3',
        bathrooms: '2',
        referenceRent: '',
        notes: '',
      });
      setSuccess('تمت إضافة الوحدة ضمن سقف الحصة بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleAssignOwned(e: React.FormEvent) {
    e.preventDefault();
    if (!ownedUnitTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/units/${ownedUnitTarget.id}/assign-owned`, {
        method: 'POST',
        body: JSON.stringify({ unitOwnerPartyId: assignOwnerPartyId }),
      });
      setOwnedUnitTarget(null);
      setSuccess('تم تعيين الوحدة كتمليك وتسجيل مالك الوحدة في سجل التدقيق.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleBulkImport(e: React.FormEvent) {
    e.preventDefault();
    if (!csvProp) return;
    setError(null);
    try {
      const rows = csvText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [unitNumber, unitType, floorNumber, areaSqm, referenceRent] = line.split(',').map((s) => s.trim());
          return { unitNumber, unitType, floorNumber, areaSqm, referenceRent };
        });
      const res = await apiFetch<{ importedCount: number }>(`/api/properties/${csvProp.id}/units/import`, {
        method: 'POST',
        body: JSON.stringify({ rows }),
      });
      setCsvProp(null);
      setSuccess(`تم استيراد ${res.importedCount} وحدة بنجاح.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function toggleArchive(prop: any) {
    try {
      await apiFetch(`/api/properties/${prop.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: prop.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE' }),
      });
      setSuccess('تم تحديث حالة العقار.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleSoftDelete(prop: any) {
    try {
      await apiFetch(`/api/properties/${prop.id}`, { method: 'DELETE' });
      setSuccess('تم حذف العقار ناعماً وتحرير حصته.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const usedSlots = slots.filter((s) => Boolean(s.property_id)).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">العقارات والوحدات</h1>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            الحصص المستخدمة: {usedSlots} من {slots.length} · حالة الوحدة تُشتق تلقائياً من العقود والصيانة
          </p>
        </div>
        <button type="button" onClick={() => setCreateOpen(true)} className={primaryBtnCls}>
          <Plus className="w-4 h-4" aria-hidden="true" />
          <span>عقار جديد بوحداته</span>
        </button>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} />

      {loading ? (
        <LoadingRows rows={5} />
      ) : properties.length === 0 ? (
        <EmptyState
          title="لا توجد عقارات مسجلة"
          description="أنشئ العقار الأول مع وحداته في خطوة واحدة."
          action={
            <button type="button" onClick={() => setCreateOpen(true)} className={primaryBtnCls}>
              إنشاء عقار
            </button>
          }
        />
      ) : (
        <div className="space-y-5">
          {properties.map((p) => (
            <Panel
              key={p.id}
              title={`${p.name} (${p.code})`}
              subtitle={`${p.property_type} · ${p.address} · المالك: ${p.owners.map((o: any) => `${o.party_name} (${o.share_percent}%)`).join('، ')}`}
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <StatusText status={p.status} />
                  <span className="text-xs font-mono text-slate-500">
                    الوحدات: {p.units.length}/{p.max_units ?? '∞'}
                  </span>
                  <button type="button" onClick={() => setAddUnitProp(p)} className={secondaryBtnCls}>
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>إضافة وحدة</span>
                  </button>
                  <button type="button" onClick={() => setCsvProp(p)} className={secondaryBtnCls}>
                    <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>استيراد CSV</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditProp(p);
                      setEditPropForm({
                        name: p.name,
                        propertyType: p.property_type,
                        address: p.address,
                        commissionType: p.commission_type,
                        commissionValue: p.commission_value,
                        guardName: p.guard_name || '',
                        guardPhone: p.guard_phone || '',
                        guardSalary: p.guard_salary || '0',
                        elevatorsCount: p.elevators_count ?? '',
                        parkingSpots: p.parking_spots ?? '',
                        areaSqm: p.area_sqm ?? '',
                        propertyValue: p.property_value ?? '',
                        ownerBankAccount: p.owner_bank_account || '',
                      });
                      setEditPropOwners(
                        (p.owners ?? []).map((o: any) => ({
                          partyId: o.party_id,
                          sharePercent: String(o.share_percent),
                          isPrimary: Boolean(o.is_primary),
                        })),
                      );
                    }}
                    className={secondaryBtnCls}
                  >
                    <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>تعديل</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAttTarget({ entityType: 'PROPERTY', entityId: p.id, label: p.name })}
                    className={secondaryBtnCls}
                  >
                    <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>مرفقات</span>
                  </button>
                  <button type="button" onClick={() => toggleArchive(p)} className={secondaryBtnCls}>
                    <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{p.status === 'ACTIVE' ? 'أرشفة' : 'استعادة'}</span>
                  </button>
                  <button type="button" onClick={() => handleSoftDelete(p)} className={dangerBtnCls} aria-label={`حذف ${p.name}`}>
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>
              }
            >
              {(p.guard_name || p.elevators_count || p.parking_spots || p.area_sqm) && (
                <div className="mb-3 text-xs text-slate-600 flex flex-wrap gap-x-5 gap-y-1 bg-slate-50 px-3 py-2 rounded border border-slate-200">
                  {p.guard_name && <span>الحارس: {p.guard_name} ({formatMoney(p.guard_salary, org.base_currency)}/شهر)</span>}
                  {p.elevators_count !== null && <span>المصاعد: {p.elevators_count}</span>}
                  {p.parking_spots !== null && <span>المواقف: {p.parking_spots}</span>}
                  {p.area_sqm && <span>المساحة: {p.area_sqm} م²</span>}
                </div>
              )}
              {p.units.length === 0 ? (
                <p className="text-xs text-slate-500">لا توجد وحدات مضافة في هذا العقار.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-right">
                    <thead>
                      <tr className="border-b border-slate-200 text-xs text-slate-500">
                        <th className="py-2 px-3 font-medium">رقم الوحدة</th>
                        <th className="py-2 px-3 font-medium">النوع / الدور</th>
                        <th className="py-2 px-3 font-medium">الحيازة</th>
                        <th className="py-2 px-3 font-medium">الحالة المشتقة</th>
                        <th className="py-2 px-3 font-medium">المساحة / الغرف</th>
                        <th className="py-2 px-3 font-medium">السعر المرجعي / مالك التمليك</th>
                        <th className="py-2 px-3 font-medium">إجراء</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {p.units.map((u: any) => (
                        <tr key={u.id} className="hover:bg-slate-50/70">
                          <td className="py-2.5 px-3 font-mono font-medium text-slate-900">{u.unit_number}</td>
                          <td className="py-2.5 px-3 text-slate-600">
                            {u.unit_type} · {u.floor_number}
                          </td>
                          <td className="py-2.5 px-3 text-xs text-slate-700">
                            {u.tenure_type === 'OWNED' ? 'تمليك (OWNED)' : 'إيجار (RENTAL)'}
                          </td>
                          <td className="py-2.5 px-3">
                            <StatusText status={u.derived_status} />
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-xs">
                            {u.area_sqm} م² {u.bedrooms ? `· ${u.bedrooms} غرف` : ''}
                          </td>
                          <td className="py-2.5 px-3 text-xs text-slate-600 font-mono">
                            {u.tenure_type === 'OWNED'
                              ? `مالك: ${u.unit_owner_name || '—'}`
                              : u.reference_rent
                                ? formatMoney(u.reference_rent, org.base_currency)
                                : '—'}
                          </td>
                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditUnit(u);
                                  setEditUnitForm({
                                    unitNumber: u.unit_number,
                                    unitType: u.unit_type,
                                    floorNumber: u.floor_number,
                                    areaSqm: u.area_sqm,
                                    bedrooms: u.bedrooms ?? '',
                                    bathrooms: u.bathrooms ?? '',
                                    referenceRent: u.reference_rent ?? '',
                                    notes: u.notes ?? '',
                                  });
                                }}
                                className="text-xs text-slate-700 hover:underline whitespace-nowrap"
                              >
                                تعديل
                              </button>
                              <button
                                type="button"
                                onClick={() => setAttTarget({ entityType: 'UNIT', entityId: u.id, label: `${p.name} - وحدة ${u.unit_number}` })}
                                className="text-xs text-slate-600 hover:underline whitespace-nowrap"
                              >
                                مرفقات
                              </button>
                              {user.role === 'OWNER' && u.tenure_type === 'RENTAL' && u.derived_status === 'VACANT' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOwnedUnitTarget(u);
                                    setAssignOwnerPartyId(parties[0]?.id ?? '');
                                  }}
                                  className="text-xs font-medium text-teal-700 hover:underline whitespace-nowrap"
                                >
                                  تعيين كتمليك
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          ))}
        </div>
      )}

      {/* Atomic Property + Units Modal */}
      <Modal open={createOpen} title="إنشاء عقار جديد بوحداته وملاكه (معاملة ذرية)" onClose={() => setCreateOpen(false)} wide>
        <form onSubmit={handleCreateProperty} className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="اسم العقار / البرج" id="prp-name" required>
              <input id="prp-name" required value={propForm.name} onChange={(e) => setPropForm({ ...propForm, name: e.target.value })} className={inputCls} />
            </Field>
            <Field label="نوع العقار" id="prp-type" required>
              <input id="prp-type" required value={propForm.propertyType} onChange={(e) => setPropForm({ ...propForm, propertyType: e.target.value })} className={inputCls} />
            </Field>
            <Field label="العنوان" id="prp-addr" required>
              <input id="prp-addr" required value={propForm.address} onChange={(e) => setPropForm({ ...propForm, address: e.target.value })} className={inputCls} />
            </Field>
            <Field label="عمولة الإدارة" id="prp-comm-type">
              <select id="prp-comm-type" value={propForm.commissionType} onChange={(e) => setPropForm({ ...propForm, commissionType: e.target.value })} className={inputCls}>
                <option value="NONE">بدون عمولة (0)</option>
                <option value="PERCENTAGE">نسبة مئوية (%)</option>
                <option value="FIXED">مبلغ ثابت</option>
              </select>
            </Field>
            <Field label="قيمة العمولة" id="prp-comm-val">
              <input id="prp-comm-val" type="number" step="0.01" value={propForm.commissionValue} onChange={(e) => setPropForm({ ...propForm, commissionValue: e.target.value })} className={inputCls} />
            </Field>
            <Field label="رقم الحساب البنكي للمالك" id="prp-bank">
              <input id="prp-bank" dir="ltr" value={propForm.ownerBankAccount} onChange={(e) => setPropForm({ ...propForm, ownerBankAccount: e.target.value })} className={inputCls} />
            </Field>
            <Field label="اسم الحارس (اختياري)" id="prp-gname">
              <input id="prp-gname" value={propForm.guardName} onChange={(e) => setPropForm({ ...propForm, guardName: e.target.value })} className={inputCls} />
            </Field>
            <Field label="جوال الحارس" id="prp-gphone">
              <input id="prp-gphone" value={propForm.guardPhone} onChange={(e) => setPropForm({ ...propForm, guardPhone: e.target.value })} className={inputCls} />
            </Field>
            <Field label="راتب الحارس الشهري" id="prp-gsal">
              <input id="prp-gsal" type="number" step="0.01" value={propForm.guardSalary} onChange={(e) => setPropForm({ ...propForm, guardSalary: e.target.value })} className={inputCls} />
            </Field>
            <Field label="عدد المصاعد" id="prp-elev">
              <input id="prp-elev" type="number" min={0} value={propForm.elevatorsCount} onChange={(e) => setPropForm({ ...propForm, elevatorsCount: e.target.value })} className={inputCls} />
            </Field>
            <Field label="المواقف" id="prp-park">
              <input id="prp-park" type="number" min={0} value={propForm.parkingSpots} onChange={(e) => setPropForm({ ...propForm, parkingSpots: e.target.value })} className={inputCls} />
            </Field>
            <Field label="المساحة الكلية (م²) / القيمة" id="prp-area">
              <div className="flex gap-1.5">
                <input placeholder="م²" type="number" value={propForm.areaSqm} onChange={(e) => setPropForm({ ...propForm, areaSqm: e.target.value })} className={inputCls} />
                <input placeholder="القيمة" type="number" value={propForm.propertyValue} onChange={(e) => setPropForm({ ...propForm, propertyValue: e.target.value })} className={inputCls} />
              </div>
            </Field>
          </div>

          <div className="border-t border-slate-200 pt-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-slate-900">ملاك العقار ونسب التملك (يجب أن تساوي 100%)</h4>
              <button
                type="button"
                onClick={() => setPropOwners([...propOwners, { partyId: parties[0]?.id ?? '', sharePercent: '0', isPrimary: false }])}
                className={secondaryBtnCls}
              >
                + إضافة شريك
              </button>
            </div>
            <div className="space-y-2">
              {propOwners.map((ow, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center bg-slate-50 p-2 rounded">
                  <select
                    value={ow.partyId}
                    onChange={(e) => {
                      const next = [...propOwners];
                      next[idx].partyId = e.target.value;
                      setPropOwners(next);
                    }}
                    className={`${inputCls} col-span-6`}
                    required
                  >
                    <option value="">اختر المالك...</option>
                    {parties.map((pa) => (
                      <option key={pa.id} value={pa.id}>
                        {pa.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    value={ow.sharePercent}
                    onChange={(e) => {
                      const next = [...propOwners];
                      next[idx].sharePercent = e.target.value;
                      setPropOwners(next);
                    }}
                    className={`${inputCls} col-span-3`}
                    placeholder="%"
                  />
                  <label className="col-span-2 text-xs flex items-center gap-1">
                    <input
                      type="radio"
                      name="create-primary-owner"
                      checked={ow.isPrimary}
                      onChange={() => setPropOwners(propOwners.map((x, j) => ({ ...x, isPrimary: j === idx })))}
                    />
                    أساسي
                  </label>
                  {propOwners.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setPropOwners(propOwners.filter((_, j) => j !== idx))}
                      className="text-xs text-red-700 col-span-1"
                    >
                      حذف
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-slate-200 pt-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-slate-900">الوحدات الأولية والعدادات</h4>
              <button
                type="button"
                onClick={() =>
                  setDraftUnits([
                    ...draftUnits,
                    {
                      unitNumber: String(101 + draftUnits.length),
                      unitType: 'شقة سكنية',
                      floorNumber: 'الأول',
                      tenureType: 'RENTAL',
                      unitOwnerPartyId: '',
                      areaSqm: '120',
                      bedrooms: '3',
                      bathrooms: '2',
                      referenceRent: '40000',
                      serviceId: '',
                      meterNumber: '',
                      initialReading: '0',
                    },
                  ])
                }
                className={secondaryBtnCls}
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>سطر وحدة</span>
              </button>
            </div>
            <div className="space-y-2">
              {draftUnits.map((du, idx) => (
                <div key={idx} className="grid grid-cols-2 sm:grid-cols-8 gap-2 items-center bg-slate-50 p-2 rounded-md">
                  <input
                    aria-label={`رقم الوحدة ${idx + 1}`}
                    value={du.unitNumber}
                    onChange={(e) => {
                      const next = [...draftUnits];
                      next[idx].unitNumber = e.target.value;
                      setDraftUnits(next);
                    }}
                    className={inputCls}
                    placeholder="رقم"
                  />
                  <input
                    aria-label={`النوع ${idx + 1}`}
                    value={du.unitType}
                    onChange={(e) => {
                      const next = [...draftUnits];
                      next[idx].unitType = e.target.value;
                      setDraftUnits(next);
                    }}
                    className={inputCls}
                    placeholder="النوع"
                  />
                  <select
                    aria-label={`الحيازة ${idx + 1}`}
                    value={du.tenureType}
                    onChange={(e) => {
                      const next = [...draftUnits];
                      next[idx].tenureType = e.target.value;
                      setDraftUnits(next);
                    }}
                    className={inputCls}
                  >
                    <option value="RENTAL">إيجار</option>
                    <option value="OWNED">تمليك</option>
                  </select>
                  <input
                    aria-label={`المساحة ${idx + 1}`}
                    type="number"
                    value={du.areaSqm}
                    onChange={(e) => {
                      const next = [...draftUnits];
                      next[idx].areaSqm = e.target.value;
                      setDraftUnits(next);
                    }}
                    className={inputCls}
                    placeholder="م²"
                  />
                  {du.tenureType === 'OWNED' ? (
                    <select
                      aria-label={`مالك الوحدة ${idx + 1}`}
                      value={du.unitOwnerPartyId}
                      onChange={(e) => {
                        const next = [...draftUnits];
                        next[idx].unitOwnerPartyId = e.target.value;
                        setDraftUnits(next);
                      }}
                      className={inputCls}
                    >
                      <option value="">مالك الوحدة...</option>
                      {parties.map((pa) => (
                        <option key={pa.id} value={pa.id}>
                          {pa.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={`الإيجار المرجعي ${idx + 1}`}
                      type="number"
                      value={du.referenceRent}
                      onChange={(e) => {
                        const next = [...draftUnits];
                        next[idx].referenceRent = e.target.value;
                        setDraftUnits(next);
                      }}
                      className={inputCls}
                      placeholder="الإيجار"
                    />
                  )}
                  <select
                    aria-label={`خدمة العداد ${idx + 1}`}
                    value={du.serviceId}
                    onChange={(e) => {
                      const next = [...draftUnits];
                      next[idx].serviceId = e.target.value;
                      setDraftUnits(next);
                    }}
                    className={inputCls}
                  >
                    <option value="">بدون عداد</option>
                    {services
                      .filter((s) => s.service_type === 'METERED')
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                  <input
                    aria-label={`رقم العداد ${idx + 1}`}
                    value={du.meterNumber}
                    onChange={(e) => {
                      const next = [...draftUnits];
                      next[idx].meterNumber = e.target.value;
                      setDraftUnits(next);
                    }}
                    className={inputCls}
                    placeholder="رقم العداد"
                  />
                  <button
                    type="button"
                    onClick={() => setDraftUnits(draftUnits.filter((_, i) => i !== idx))}
                    className="text-xs text-red-700 hover:underline justify-self-center"
                  >
                    إزالة
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCreateOpen(false)} className={secondaryBtnCls}>
              إلغاء
            </button>
            <button type="submit" className={primaryBtnCls}>
              <Building2 className="w-4 h-4" aria-hidden="true" />
              <span>حفظ العقار والوحدات</span>
            </button>
          </div>
        </form>
      </Modal>

      {/* Add single unit modal */}
      <Modal open={Boolean(addUnitProp)} title={`إضافة وحدة إلى ${addUnitProp?.name ?? ''}`} onClose={() => setAddUnitProp(null)}>
        <form onSubmit={handleAddUnit} className="space-y-4">
          <Field label="رقم الوحدة" id="add-u-num" required>
            <input
              id="add-u-num"
              required
              value={unitForm.unitNumber}
              onChange={(e) => setUnitForm({ ...unitForm, unitNumber: e.target.value })}
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="النوع" id="add-u-type">
              <input
                id="add-u-type"
                value={unitForm.unitType}
                onChange={(e) => setUnitForm({ ...unitForm, unitType: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label="الدور" id="add-u-floor">
              <input
                id="add-u-floor"
                value={unitForm.floorNumber}
                onChange={(e) => setUnitForm({ ...unitForm, floorNumber: e.target.value })}
                className={inputCls}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="الحيازة" id="add-u-tenure">
              <select
                id="add-u-tenure"
                value={unitForm.tenureType}
                onChange={(e) => setUnitForm({ ...unitForm, tenureType: e.target.value })}
                className={inputCls}
              >
                <option value="RENTAL">إيجار</option>
                <option value="OWNED">تمليك</option>
              </select>
            </Field>
            <Field label="المساحة (م²)" id="add-u-area">
              <input
                id="add-u-area"
                type="number"
                value={unitForm.areaSqm}
                onChange={(e) => setUnitForm({ ...unitForm, areaSqm: e.target.value })}
                className={inputCls}
              />
            </Field>
          </div>
          {unitForm.tenureType === 'OWNED' ? (
            <Field label="مالك الوحدة" id="add-u-owner" required>
              <select
                id="add-u-owner"
                required
                value={unitForm.unitOwnerPartyId}
                onChange={(e) => setUnitForm({ ...unitForm, unitOwnerPartyId: e.target.value })}
                className={inputCls}
              >
                <option value="">اختر مالك الوحدة...</option>
                {parties.map((pa) => (
                  <option key={pa.id} value={pa.id}>
                    {pa.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="سعر الإيجار المرجعي" id="add-u-rent">
              <input
                id="add-u-rent"
                type="number"
                value={unitForm.referenceRent}
                onChange={(e) => setUnitForm({ ...unitForm, referenceRent: e.target.value })}
                className={inputCls}
              />
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAddUnitProp(null)} className={secondaryBtnCls}>
              إلغاء
            </button>
            <button type="submit" className={primaryBtnCls}>
              إضافة الوحدة
            </button>
          </div>
        </form>
      </Modal>

      {/* Assign OWNED unit */}
      <Modal open={Boolean(ownedUnitTarget)} title={`تعيين الوحدة ${ownedUnitTarget?.unit_number ?? ''} كتمليك`} onClose={() => setOwnedUnitTarget(null)}>
        <form onSubmit={handleAssignOwned} className="space-y-4">
          <p className="text-xs text-slate-600">
            وحدة التمليك تُستثنى من الشواغر ودخل الإيجار ولا يُنشأ عليها عقد إيجار، وتصدر فواتير خدماتها باسم مالك الوحدة.
          </p>
          <Field label="مالك الوحدة" id="assign-owned-party" required>
            <select
              id="assign-owned-party"
              required
              value={assignOwnerPartyId}
              onChange={(e) => setAssignOwnerPartyId(e.target.value)}
              className={inputCls}
            >
              {parties.map((pa) => (
                <option key={pa.id} value={pa.id}>
                  {pa.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOwnedUnitTarget(null)} className={secondaryBtnCls}>
              إلغاء
            </button>
            <button type="submit" className={primaryBtnCls}>
              <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
              <span>اعتماد التمليك</span>
            </button>
          </div>
        </form>
      </Modal>

      {/* CSV Import */}
      <Modal open={Boolean(csvProp)} title={`استيراد وحدات CSV إلى ${csvProp?.name ?? ''}`} onClose={() => setCsvProp(null)}>
        <form onSubmit={handleBulkImport} className="space-y-4">
          <p className="text-xs text-slate-500">الصيغة: رقم_الوحدة, النوع, الدور, المساحة, الإيجار_المرجعي</p>
          <textarea
            rows={5}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            className={`${inputCls} font-mono text-xs`}
            dir="ltr"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCsvProp(null)} className={secondaryBtnCls}>
              إلغاء
            </button>
            <button type="submit" className={primaryBtnCls}>
              استيراد ضمن السقف
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Property Modal */}
      <Modal open={Boolean(editProp)} title={`تعديل العقار: ${editProp?.name ?? ''}`} onClose={() => setEditProp(null)} wide>
        <form onSubmit={handleEditProperty} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="اسم العقار" id="ed-prp-name" required>
              <input id="ed-prp-name" required value={editPropForm.name || ''} onChange={(e) => setEditPropForm({ ...editPropForm, name: e.target.value })} className={inputCls} />
            </Field>
            <Field label="النوع" id="ed-prp-type" required>
              <input id="ed-prp-type" required value={editPropForm.propertyType || ''} onChange={(e) => setEditPropForm({ ...editPropForm, propertyType: e.target.value })} className={inputCls} />
            </Field>
            <Field label="العنوان" id="ed-prp-addr" required>
              <input id="ed-prp-addr" required value={editPropForm.address || ''} onChange={(e) => setEditPropForm({ ...editPropForm, address: e.target.value })} className={inputCls} />
            </Field>
            <Field label="نوع العمولة" id="ed-prp-ct">
              <select id="ed-prp-ct" value={editPropForm.commissionType || 'NONE'} onChange={(e) => setEditPropForm({ ...editPropForm, commissionType: e.target.value })} className={inputCls}>
                <option value="NONE">بدون عمولة</option>
                <option value="PERCENTAGE">نسبة (%)</option>
                <option value="FIXED">مبلغ ثابت</option>
              </select>
            </Field>
            <Field label="قيمة العمولة" id="ed-prp-cv">
              <input id="ed-prp-cv" type="number" step="0.01" value={editPropForm.commissionValue || '0'} onChange={(e) => setEditPropForm({ ...editPropForm, commissionValue: e.target.value })} className={inputCls} />
            </Field>
            <Field label="اسم الحارس / الراتب" id="ed-prp-guard">
              <div className="flex gap-1.5">
                <input placeholder="الاسم" value={editPropForm.guardName || ''} onChange={(e) => setEditPropForm({ ...editPropForm, guardName: e.target.value })} className={inputCls} />
                <input placeholder="الراتب" type="number" value={editPropForm.guardSalary || '0'} onChange={(e) => setEditPropForm({ ...editPropForm, guardSalary: e.target.value })} className={inputCls} />
              </div>
            </Field>
            <Field label="المصاعد / المواقف" id="ed-prp-elev">
              <div className="flex gap-1.5">
                <input placeholder="مصاعد" type="number" value={editPropForm.elevatorsCount ?? ''} onChange={(e) => setEditPropForm({ ...editPropForm, elevatorsCount: e.target.value })} className={inputCls} />
                <input placeholder="مواقف" type="number" value={editPropForm.parkingSpots ?? ''} onChange={(e) => setEditPropForm({ ...editPropForm, parkingSpots: e.target.value })} className={inputCls} />
              </div>
            </Field>
            <Field label="المساحة (م²)" id="ed-prp-area">
              <input id="ed-prp-area" type="number" value={editPropForm.areaSqm ?? ''} onChange={(e) => setEditPropForm({ ...editPropForm, areaSqm: e.target.value })} className={inputCls} />
            </Field>
            <Field label="حساب البنك للمالك" id="ed-prp-bank">
              <input id="ed-prp-bank" dir="ltr" value={editPropForm.ownerBankAccount || ''} onChange={(e) => setEditPropForm({ ...editPropForm, ownerBankAccount: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditProp(null)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ التعديلات</button>
          </div>
        </form>
      </Modal>

      {/* Edit Unit Modal */}
      <Modal open={Boolean(editUnit)} title={`تعديل الوحدة ${editUnit?.unit_number ?? ''}`} onClose={() => setEditUnit(null)}>
        <form onSubmit={handleEditUnit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="رقم الوحدة" id="ed-u-num" required>
              <input id="ed-u-num" required value={editUnitForm.unitNumber || ''} onChange={(e) => setEditUnitForm({ ...editUnitForm, unitNumber: e.target.value })} className={inputCls} />
            </Field>
            <Field label="النوع" id="ed-u-type">
              <input id="ed-u-type" value={editUnitForm.unitType || ''} onChange={(e) => setEditUnitForm({ ...editUnitForm, unitType: e.target.value })} className={inputCls} />
            </Field>
            <Field label="الدور" id="ed-u-floor">
              <input id="ed-u-floor" value={editUnitForm.floorNumber || ''} onChange={(e) => setEditUnitForm({ ...editUnitForm, floorNumber: e.target.value })} className={inputCls} />
            </Field>
            <Field label="المساحة (م²)" id="ed-u-area">
              <input id="ed-u-area" type="number" value={editUnitForm.areaSqm || ''} onChange={(e) => setEditUnitForm({ ...editUnitForm, areaSqm: e.target.value })} className={inputCls} />
            </Field>
            <Field label="الغرف / دورات المياه" id="ed-u-rooms">
              <div className="flex gap-1.5">
                <input placeholder="غرف" type="number" value={editUnitForm.bedrooms ?? ''} onChange={(e) => setEditUnitForm({ ...editUnitForm, bedrooms: e.target.value })} className={inputCls} />
                <input placeholder="حمامات" type="number" value={editUnitForm.bathrooms ?? ''} onChange={(e) => setEditUnitForm({ ...editUnitForm, bathrooms: e.target.value })} className={inputCls} />
              </div>
            </Field>
            <Field label="الإيجار المرجعي" id="ed-u-rent">
              <input id="ed-u-rent" type="number" value={editUnitForm.referenceRent || ''} onChange={(e) => setEditUnitForm({ ...editUnitForm, referenceRent: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <Field label="ملاحظات" id="ed-u-notes">
            <input id="ed-u-notes" value={editUnitForm.notes || ''} onChange={(e) => setEditUnitForm({ ...editUnitForm, notes: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditUnit(null)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ الوحدة</button>
          </div>
        </form>
      </Modal>

      <AttachmentsModal
        target={attTarget}
        defaultType={attTarget?.entityType === 'PROPERTY' ? 'PROPERTY_DOC' : 'UNIT_DOC'}
        allowedTypes={['PROPERTY_DOC', 'UNIT_DOC', 'ENTRY_PHOTO', 'OTHER']}
        onClose={() => setAttTarget(null)}
      />
    </div>
  );
}
