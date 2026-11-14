import React, { useEffect, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  DoorOpen,
  History,
  Paperclip,
  Plus,
  Printer,
  RefreshCw,
  Settings,
  Trash2,
  Wrench,
} from 'lucide-react';
import { apiFetch, AuthUser, formatDateDisplay, formatMoney, OrganizationInfo } from '../lib/api';
import { AttachmentsModal, PrintableDocPayload, PrintableDocumentModal } from './DocumentAndAttachmentModals';
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
  StatusText,
  SuccessBanner,
} from './UiPrimitives';

export function MaintenanceView({ org }: { org: OrganizationInfo }) {
  const [data, setData] = useState<{ records: any[]; types: any[]; recurring: any[]; requests: any[] }>({
    records: [],
    types: [],
    recurring: [],
    requests: [],
  });
  const [properties, setProperties] = useState<any[]>([]);
  const [cashboxes, setCashboxes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [tab, setTab] = useState<'records' | 'recurring' | 'requests'>('records');

  const [createOpen, setCreateOpen] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const [recOpen, setRecOpen] = useState(false);
  const [convertTarget, setConvertTarget] = useState<any>(null);
  const [attTarget, setAttTarget] = useState<{ entityType: string; entityId: string; label: string } | null>(null);

  const [form, setForm] = useState({
    propertyId: '',
    unitId: '',
    maintenanceType: 'سباكة وكهرباء',
    cause: 'NORMAL',
    description: '',
    cost: '',
    chargeTo: 'OWNER',
    vendorName: '',
    maintenanceDate: '2026-11-14',
    isPeriodic: false,
    payFromCashboxId: '',
  });

  const [typeForm, setTypeForm] = useState({ name: '', defaultChargeTo: 'OWNER', defaultCause: 'NORMAL' });
  const [recForm, setRecForm] = useState({
    propertyId: '',
    unitId: '',
    maintenanceType: 'صيانة مصاعد دورية',
    description: '',
    cost: '',
    chargeTo: 'OWNER',
    vendorName: '',
    frequency: 'MONTHLY',
    nextDate: '2026-12-01',
  });
  const [convertForm, setConvertForm] = useState({
    cost: '',
    chargeTo: 'OWNER',
    cause: 'NORMAL',
    vendorName: '',
    description: '',
  });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [mRes, pRes, cRes] = await Promise.all([
        apiFetch('/api/maintenance'),
        apiFetch('/api/properties'),
        apiFetch('/api/collections'),
      ]);
      setData({
        records: mRes.records ?? [],
        types: mRes.types ?? [],
        recurring: mRes.recurring ?? [],
        requests: mRes.requests ?? [],
      });
      setProperties(pRes.properties);
      setCashboxes(cRes.cashboxes);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/maintenance', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          unitId: form.unitId || undefined,
          payFromCashboxId: form.payFromCashboxId || undefined,
        }),
      });
      setCreateOpen(false);
      setSuccess('تم تسجيل سجل الصيانة وتحديث القيود المحاسبية.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function updateStatus(id: string, status: string) {
    setError(null);
    try {
      await apiFetch(`/api/maintenance/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleCreateType(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/maintenance/types', { method: 'POST', body: JSON.stringify(typeForm) });
      setTypeForm({ name: '', defaultChargeTo: 'OWNER', defaultCause: 'NORMAL' });
      setSuccess('تمت إضافة نوع الصيانة.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleDeleteType(id: string) {
    setError(null);
    try {
      await apiFetch(`/api/maintenance/types/${id}`, { method: 'DELETE' });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleCreateRecurring(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/maintenance/recurring', {
        method: 'POST',
        body: JSON.stringify({ ...recForm, unitId: recForm.unitId || undefined }),
      });
      setRecOpen(false);
      setSuccess('تم إنشاء عقد الصيانة الدورية.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function toggleRecurring(rc: any) {
    setError(null);
    try {
      await apiFetch(`/api/maintenance/recurring/${rc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !rc.is_active }),
      });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function generateDueRecurring() {
    setError(null);
    try {
      const res = await apiFetch<{ generatedCount: number }>('/api/maintenance/recurring/generate-due', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setSuccess(`تم توليد ${res.generatedCount} سجل صيانة دورية مستحق.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleConvertRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!convertTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/maintenance/requests/${convertTarget.id}/convert`, {
        method: 'POST',
        body: JSON.stringify({ action: 'CONVERT', ...convertForm }),
      });
      setConvertTarget(null);
      setSuccess('تم تحويل طلب المستأجر إلى سجل صيانة رسمي.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleRejectRequest(reqId: string) {
    setError(null);
    try {
      await apiFetch(`/api/maintenance/requests/${reqId}/convert`, {
        method: 'POST',
        body: JSON.stringify({ action: 'REJECT' }),
      });
      setSuccess('تم رفض طلب الصيانة.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const propUnits = properties.find((p) => p.id === form.propertyId)?.units ?? [];
  const recPropUnits = properties.find((p) => p.id === recForm.propertyId)?.units ?? [];
  const showHijri = Boolean(org.show_hijri_dates);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">الصيانة وجهة التحميل وطلبات المستأجرين</h1>
          <p className="text-xs text-slate-500 mt-1">
            تلف المستأجر يُربط تلقائياً بعقده النشط · صيانة دورية تلقائية · معالجة طلبات المستأجرين
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setTypesOpen(true)} className={secondaryBtnCls}>
            <Settings className="w-4 h-4" aria-hidden="true" />
            <span>أنواع الصيانة ({data.types.length})</span>
          </button>
          <button type="button" onClick={() => setCreateOpen(true)} className={primaryBtnCls}>
            <Wrench className="w-4 h-4" aria-hidden="true" />
            <span>تسجيل صيانة</span>
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setTab('records')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === 'records' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
        >
          سجلات الصيانة ({data.records.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('recurring')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === 'recurring' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
        >
          الصيانة الدورية ({data.recurring.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('requests')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === 'requests' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
        >
          طلبات المستأجرين ({data.requests.filter((r) => r.status === 'PENDING').length})
        </button>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} />

      {loading ? (
        <LoadingRows />
      ) : tab === 'records' ? (
        data.records.length === 0 ? (
          <EmptyState title="لا توجد سجلات صيانة" description="سجّل أعمال الصيانة العادية أو تلفيات المستأجرين هنا." />
        ) : (
          <Panel>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-right">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2.5 px-3 font-medium">العقار / الوحدة</th>
                    <th className="py-2.5 px-3 font-medium">النوع والسبب</th>
                    <th className="py-2.5 px-3 font-medium">الوصف والمقاول</th>
                    <th className="py-2.5 px-3 font-medium">التاريخ</th>
                    <th className="py-2.5 px-3 font-medium">التكلفة</th>
                    <th className="py-2.5 px-3 font-medium">جهة التحميل</th>
                    <th className="py-2.5 px-3 font-medium">الحالة</th>
                    <th className="py-2.5 px-3 font-medium">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.records.map((m) => (
                    <tr key={m.id}>
                      <td className="py-2.5 px-3 font-medium">
                        {m.property_name} {m.unit_number ? `· وحدة ${m.unit_number}` : '(مرفق عام)'}
                      </td>
                      <td className="py-2.5 px-3 text-xs">
                        {m.maintenance_type} · {m.cause === 'TENANT_DAMAGE' ? 'تلف مستأجر' : 'صيانة عادية'}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700">
                        <div>{m.description}</div>
                        {m.vendor_name && <div className="text-xs text-slate-400">الفني/المقاول: {m.vendor_name}</div>}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-xs whitespace-nowrap">{formatDateDisplay(m.maintenance_date, showHijri)}</td>
                      <td className="py-2.5 px-3 font-mono tabular-nums font-medium whitespace-nowrap">{formatMoney(m.cost, org.base_currency)}</td>
                      <td className="py-2.5 px-3"><StatusText status={m.charge_to} /></td>
                      <td className="py-2.5 px-3"><StatusText status={m.status} /></td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setAttTarget({ entityType: 'MAINTENANCE', entityId: m.id, label: m.maintenance_type })}
                            className={secondaryBtnCls}
                          >
                            <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>صور</span>
                          </button>
                          {m.status !== 'COMPLETED' && (
                            <button type="button" onClick={() => updateStatus(m.id, 'COMPLETED')} className={secondaryBtnCls}>
                              إكمال
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )
      ) : tab === 'recurring' ? (
        <Panel
          title="عقود الصيانة الدورية المجدولة"
          action={
            <div className="flex items-center gap-2">
              <button type="button" onClick={generateDueRecurring} className={secondaryBtnCls}>
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
                <span>توليد الصيانة المستحقة</span>
              </button>
              <button type="button" onClick={() => setRecOpen(true)} className={primaryBtnCls}>
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>جدول صيانة دورية</span>
              </button>
            </div>
          }
        >
          {data.recurring.length === 0 ? (
            <EmptyState title="لا توجد صيانة دورية مجدولة" description="أضف جداول صيانة دورية للمصاعد والتكييف والخزانات." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-right">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2 px-3 font-medium">العقار / الوحدة</th>
                    <th className="py-2 px-3 font-medium">النوع / الوصف</th>
                    <th className="py-2 px-3 font-medium">التكلفة</th>
                    <th className="py-2 px-3 font-medium">الدورية</th>
                    <th className="py-2 px-3 font-medium">الموعد القادم</th>
                    <th className="py-2 px-3 font-medium">الحالة</th>
                    <th className="py-2 px-3 font-medium">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.recurring.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2.5 px-3 font-medium">
                        {r.property_name} {r.unit_number ? `· وحدة ${r.unit_number}` : '(عام)'}
                      </td>
                      <td className="py-2.5 px-3 text-xs">
                        {r.maintenance_type} — {r.description}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums">{formatMoney(r.cost, org.base_currency)}</td>
                      <td className="py-2.5 px-3 text-xs">{r.frequency}</td>
                      <td className="py-2.5 px-3 font-mono text-xs">{r.next_date}</td>
                      <td className="py-2.5 px-3"><StatusText status={r.is_active ? 'ACTIVE' : 'SUSPENDED'} /></td>
                      <td className="py-2.5 px-3">
                        <button type="button" onClick={() => toggleRecurring(r)} className={secondaryBtnCls}>
                          {r.is_active ? 'إيقاف' : 'تفعيل'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : (
        <Panel title="طلبات الصيانة المرسلة من المستأجرين">
          {data.requests.length === 0 ? (
            <EmptyState title="لا توجد طلبات صيانة واردة" description="تظهر هنا الطلبات المرسلة من بوابة المستأجر." />
          ) : (
            <div className="space-y-3">
              {data.requests.map((r) => (
                <div key={r.id} className="border border-slate-200 rounded-md p-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold text-slate-900 text-sm">
                      {r.property_name} · وحدة {r.unit_number} — {r.tenant_name}
                    </div>
                    <div className="text-xs text-slate-600 mt-1">
                      <strong>{r.maintenance_type}:</strong> {r.description}
                    </div>
                    <div className="text-xs text-slate-400 font-mono mt-1">{r.created_at?.slice(0, 10)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusText status={r.status} />
                    {r.status === 'PENDING' && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setConvertTarget(r);
                            setConvertForm({
                              cost: '150',
                              chargeTo: 'OWNER',
                              cause: 'NORMAL',
                              vendorName: '',
                              description: r.description,
                            });
                          }}
                          className={primaryBtnCls}
                        >
                          تحويل إلى سجل صيانة
                        </button>
                        <button type="button" onClick={() => handleRejectRequest(r.id)} className={dangerBtnCls}>
                          رفض
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {/* Create Maintenance Record Modal */}
      <Modal open={createOpen} title="تسجيل عملية صيانة" onClose={() => setCreateOpen(false)}>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="العقار" id="mnt-prop" required>
              <select id="mnt-prop" required value={form.propertyId} onChange={(e) => setForm({ ...form, propertyId: e.target.value, unitId: '' })} className={inputCls}>
                <option value="">اختر...</option>
                {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="الوحدة (اختياري)" id="mnt-unit">
              <select id="mnt-unit" value={form.unitId} onChange={(e) => setForm({ ...form, unitId: e.target.value })} className={inputCls}>
                <option value="">مرفق عام بالعقار</option>
                {propUnits.map((u: any) => <option key={u.id} value={u.id}>وحدة {u.unit_number}</option>)}
              </select>
            </Field>
          </div>
          {data.types.length > 0 && (
            <Field label="اختيار نوع صيانة محفوظ (يملأ الإعدادات)" id="mnt-preset">
              <select
                id="mnt-preset"
                value=""
                onChange={(e) => {
                  const t = data.types.find((x) => x.id === e.target.value);
                  if (t) {
                    setForm({
                      ...form,
                      maintenanceType: t.name,
                      chargeTo: t.default_charge_to,
                      cause: t.default_cause,
                    });
                  }
                }}
                className={inputCls}
              >
                <option value="">— اختر نوعاً من الكتالوج —</option>
                {data.types.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="السبب" id="mnt-cause">
              <select
                id="mnt-cause"
                value={form.cause}
                onChange={(e) => setForm({ ...form, cause: e.target.value, chargeTo: e.target.value === 'TENANT_DAMAGE' ? 'TENANT' : form.chargeTo })}
                className={inputCls}
              >
                <option value="NORMAL">صيانة عادية</option>
                <option value="TENANT_DAMAGE">تلف من المستأجر</option>
              </select>
            </Field>
            <Field label="جهة التحميل" id="mnt-chg">
              <select id="mnt-chg" value={form.chargeTo} onChange={(e) => setForm({ ...form, chargeTo: e.target.value })} className={inputCls}>
                <option value="OWNER">على المالك</option>
                <option value="TENANT">على المستأجر</option>
                <option value="SHARED">مشترك</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="نوع الصيانة" id="mnt-type" required>
              <input id="mnt-type" required value={form.maintenanceType} onChange={(e) => setForm({ ...form, maintenanceType: e.target.value })} className={inputCls} />
            </Field>
            <Field label="اسم الفني / المقاول" id="mnt-vendor">
              <input id="mnt-vendor" value={form.vendorName} onChange={(e) => setForm({ ...form, vendorName: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <Field label="الوصف" id="mnt-desc" required>
            <input id="mnt-desc" required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="التكلفة" id="mnt-cost" required>
              <input id="mnt-cost" type="number" step="0.01" required value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} className={inputCls} />
            </Field>
            <Field label="تاريخ الصيانة" id="mnt-date" required>
              <input id="mnt-date" type="date" required value={form.maintenanceDate} onChange={(e) => setForm({ ...form, maintenanceDate: e.target.value })} className={inputCls} />
            </Field>
            <Field label="صرف فوري من صندوق" id="mnt-cb">
              <select id="mnt-cb" value={form.payFromCashboxId} onChange={(e) => setForm({ ...form, payFromCashboxId: e.target.value })} className={inputCls}>
                <option value="">آجل (بدون صرف نقدي)</option>
                {cashboxes.map((cb) => <option key={cb.id} value={cb.id}>{cb.name} ({formatMoney(cb.balance, org.base_currency)})</option>)}
              </select>
            </Field>
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={form.isPeriodic} onChange={(e) => setForm({ ...form, isPeriodic: e.target.checked })} />
            <span>وسم كعمل صيانة دورية</span>
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCreateOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ الصيانة</button>
          </div>
        </form>
      </Modal>

      {/* Maintenance Types Catalog Modal */}
      <Modal open={typesOpen} title="إدارة أنواع الصيانة" onClose={() => setTypesOpen(false)}>
        <div className="space-y-4">
          <form onSubmit={handleCreateType} className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-3">
            <Field label="اسم النوع" id="mt-name" required>
              <input id="mt-name" required value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} className={inputCls} placeholder="تكييف وتبريد" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="التحميل الافتراضي" id="mt-chg">
                <select id="mt-chg" value={typeForm.defaultChargeTo} onChange={(e) => setTypeForm({ ...typeForm, defaultChargeTo: e.target.value })} className={inputCls}>
                  <option value="OWNER">على المالك</option>
                  <option value="TENANT">على المستأجر</option>
                </select>
              </Field>
              <Field label="السبب الافتراضي" id="mt-cause">
                <select id="mt-cause" value={typeForm.defaultCause} onChange={(e) => setTypeForm({ ...typeForm, defaultCause: e.target.value })} className={inputCls}>
                  <option value="NORMAL">صيانة عادية</option>
                  <option value="TENANT_DAMAGE">تلف مستأجر</option>
                </select>
              </Field>
            </div>
            <div className="flex justify-end">
              <button type="submit" className={primaryBtnCls}>إضافة نوع</button>
            </div>
          </form>
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
            {data.types.map((t) => (
              <div key={t.id} className="p-2.5 flex items-center justify-between text-xs">
                <div>
                  <span className="font-semibold text-slate-900">{t.name}</span>
                  <span className="text-slate-500 mx-2">· {t.default_charge_to === 'TENANT' ? 'على المستأجر' : 'على المالك'}</span>
                </div>
                <button type="button" onClick={() => handleDeleteType(t.id)} className={dangerBtnCls}>
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      {/* Recurring Maintenance Modal */}
      <Modal open={recOpen} title="إنشاء عقد صيانة دورية" onClose={() => setRecOpen(false)}>
        <form onSubmit={handleCreateRecurring} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="العقار" id="rm-prop" required>
              <select id="rm-prop" required value={recForm.propertyId} onChange={(e) => setRecForm({ ...recForm, propertyId: e.target.value, unitId: '' })} className={inputCls}>
                <option value="">اختر...</option>
                {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="الوحدة (اختياري)" id="rm-unit">
              <select id="rm-unit" value={recForm.unitId} onChange={(e) => setRecForm({ ...recForm, unitId: e.target.value })} className={inputCls}>
                <option value="">مرفق عام</option>
                {recPropUnits.map((u: any) => <option key={u.id} value={u.id}>وحدة {u.unit_number}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="النوع" id="rm-type" required>
              <input id="rm-type" required value={recForm.maintenanceType} onChange={(e) => setRecForm({ ...recForm, maintenanceType: e.target.value })} className={inputCls} />
            </Field>
            <Field label="المقاول" id="rm-vnd">
              <input id="rm-vnd" value={recForm.vendorName} onChange={(e) => setRecForm({ ...recForm, vendorName: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <Field label="الوصف" id="rm-desc" required>
            <input id="rm-desc" required value={recForm.description} onChange={(e) => setRecForm({ ...recForm, description: e.target.value })} className={inputCls} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="التكلفة" id="rm-cost" required>
              <input id="rm-cost" type="number" step="0.01" required value={recForm.cost} onChange={(e) => setRecForm({ ...recForm, cost: e.target.value })} className={inputCls} />
            </Field>
            <Field label="التكرار" id="rm-freq">
              <select id="rm-freq" value={recForm.frequency} onChange={(e) => setRecForm({ ...recForm, frequency: e.target.value })} className={inputCls}>
                <option value="MONTHLY">شهري</option>
                <option value="QUARTERLY">ربع سنوي</option>
                <option value="SEMI_ANNUAL">نصف سنوي</option>
                <option value="ANNUAL">سنوي</option>
              </select>
            </Field>
            <Field label="التاريخ القادم" id="rm-next" required>
              <input id="rm-next" type="date" required value={recForm.nextDate} onChange={(e) => setRecForm({ ...recForm, nextDate: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRecOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ الجدول</button>
          </div>
        </form>
      </Modal>

      {/* Convert Tenant Request Modal */}
      <Modal open={Boolean(convertTarget)} title="تحويل طلب المستأجر إلى سجل صيانة" onClose={() => setConvertTarget(null)}>
        <form onSubmit={handleConvertRequest} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="السبب" id="cv-cause">
              <select
                id="cv-cause"
                value={convertForm.cause}
                onChange={(e) => setConvertForm({ ...convertForm, cause: e.target.value, chargeTo: e.target.value === 'TENANT_DAMAGE' ? 'TENANT' : convertForm.chargeTo })}
                className={inputCls}
              >
                <option value="NORMAL">صيانة عادية</option>
                <option value="TENANT_DAMAGE">تلف مستأجر</option>
              </select>
            </Field>
            <Field label="جهة التحميل" id="cv-chg">
              <select id="cv-chg" value={convertForm.chargeTo} onChange={(e) => setConvertForm({ ...convertForm, chargeTo: e.target.value })} className={inputCls}>
                <option value="OWNER">على المالك</option>
                <option value="TENANT">على المستأجر</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="التكلفة" id="cv-cost" required>
              <input id="cv-cost" type="number" step="0.01" required value={convertForm.cost} onChange={(e) => setConvertForm({ ...convertForm, cost: e.target.value })} className={inputCls} />
            </Field>
            <Field label="المقاول" id="cv-vnd">
              <input id="cv-vnd" value={convertForm.vendorName} onChange={(e) => setConvertForm({ ...convertForm, vendorName: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <Field label="وصف العمل" id="cv-desc" required>
            <input id="cv-desc" required value={convertForm.description} onChange={(e) => setConvertForm({ ...convertForm, description: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConvertTarget(null)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>اعتماد التحويل</button>
          </div>
        </form>
      </Modal>

      <AttachmentsModal
        target={attTarget}
        defaultType="BEFORE_PHOTO"
        allowedTypes={['BEFORE_PHOTO', 'AFTER_PHOTO', 'OTHER']}
        onClose={() => setAttTarget(null)}
      />
    </div>
  );
}

interface DamageRowInput {
  description: string;
  cost: string;
  vendorName: string;
  photoBase64: string;
  photoName: string;
}

export function EvictionSettlementView({ user, org }: { user: AuthUser; org: OrganizationInfo }) {
  const [data, setData] = useState<{ evictions: any[]; deposits: any[] } | null>(null);
  const [agreements, setAgreements] = useState<any[]>([]);
  const [cashboxes, setCashboxes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [initOpen, setInitOpen] = useState(false);
  const [initForm, setInitForm] = useState({
    agreementId: '',
    noticeDate: '2026-11-14',
    graceDays: String(org.default_grace_days ?? 15),
    reason: 'إنهاء العقد بالاتفاق',
  });

  const [extendTarget, setExtendTarget] = useState<any>(null);
  const [extendForm, setExtendForm] = useState({ extendedUntil: '', reason: '' });

  const [withdrawTarget, setWithdrawTarget] = useState<any>(null);
  const [restoreGraceRent, setRestoreGraceRent] = useState(true);

  const [handoverTarget, setHandoverTarget] = useState<any>(null);
  const [handoverForm, setHandoverForm] = useState({
    handoverDate: '2026-11-14',
    keysReturned: true,
    tenantAcknowledged: true,
    notes: '',
    exitPhotoBase64: '',
    exitPhotoName: '',
    finalReadings: {} as Record<string, string>,
    damages: [] as DamageRowInput[],
  });

  const [forfeitTarget, setForfeitTarget] = useState<any>(null);
  const [forfeitForm, setForfeitForm] = useState({ amount: '', reason: '' });
  const [movementsTarget, setMovementsTarget] = useState<any>(null);
  const [printDoc, setPrintDoc] = useState<PrintableDocPayload>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [ev, ctr, col] = await Promise.all([
        apiFetch('/api/evictions'),
        apiFetch('/api/contracts'),
        apiFetch('/api/collections'),
      ]);
      setData(ev);
      setAgreements(ctr.agreements);
      setCashboxes(col.cashboxes);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleInitiateEviction(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<any>('/api/evictions', {
        method: 'POST',
        body: JSON.stringify({ ...initForm, graceDays: Number(initForm.graceDays) }),
      });
      setInitOpen(false);
      setSuccess(
        `تم إصدار إشعار الإخلاء (آخر موعد: ${res.graceEndDate}). تم إعفاء ${formatMoney(res.waivedUnpaidRent, org.base_currency)} من الإيجار، ورصيد الإيجار المقدم: ${formatMoney(res.advanceRentCredit, org.base_currency)}.`,
      );
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleExtend(e: React.FormEvent) {
    e.preventDefault();
    if (!extendTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/evictions/${extendTarget.id}/extend`, {
        method: 'POST',
        body: JSON.stringify(extendForm),
      });
      setExtendTarget(null);
      setSuccess('تم تمديد مهلة الإخلاء وتوثيق السبب في سجل التدقيق.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleWithdraw(e: React.FormEvent) {
    e.preventDefault();
    if (!withdrawTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/evictions/${withdrawTarget.id}/withdraw`, {
        method: 'POST',
        body: JSON.stringify({ restoreGraceRent }),
      });
      setWithdrawTarget(null);
      setSuccess('تم سحب طلب الإخلاء وإعادة العقد إلى نشط.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function openHandover(ev: any) {
    const initialReadings: Record<string, string> = {};
    for (const m of ev.meters ?? []) {
      initialReadings[m.id] = String(m.last_reading ?? '0');
    }
    setHandoverTarget(ev);
    setHandoverForm({
      handoverDate: '2026-11-14',
      keysReturned: true,
      tenantAcknowledged: true,
      notes: '',
      exitPhotoBase64: '',
      exitPhotoName: '',
      finalReadings: initialReadings,
      damages: [],
    });
  }

  async function handleHandover(e: React.FormEvent) {
    e.preventDefault();
    if (!handoverTarget) return;
    setError(null);
    try {
      if (handoverForm.exitPhotoBase64) {
        await apiFetch('/api/attachments', {
          method: 'POST',
          body: JSON.stringify({
            attachmentType: 'EXIT_PHOTO',
            fileName: handoverForm.exitPhotoName || 'exit_photo.png',
            mimeType: 'image/png',
            dataBase64: handoverForm.exitPhotoBase64,
            entityType: 'EVICTION',
            entityId: handoverTarget.id,
          }),
        });
      }

      const damagesPayload: any[] = [];
      for (const d of handoverForm.damages) {
        if (!d.description || Number(d.cost) <= 0) continue;
        if (!d.photoBase64) {
          throw new Error(`بند التلف "${d.description}" يتطلب إرفاق صورة موثّقة للتلف`);
        }
        const attRes = await apiFetch<{ attachmentId: string }>('/api/attachments', {
          method: 'POST',
          body: JSON.stringify({
            attachmentType: 'DAMAGE_PHOTO',
            fileName: d.photoName || 'damage_evidence.png',
            mimeType: 'image/png',
            dataBase64: d.photoBase64,
            entityType: 'EVICTION',
            entityId: handoverTarget.id,
          }),
        });
        damagesPayload.push({
          description: d.description,
          cost: d.cost,
          vendorName: d.vendorName || undefined,
          photoAttachmentId: attRes.attachmentId,
        });
      }

      const finalReadings = Object.entries(handoverForm.finalReadings)
        .filter(([, val]) => val !== '')
        .map(([meterId, reading]) => ({ meterId, reading }));

      const res = await apiFetch<any>(`/api/evictions/${handoverTarget.id}/handover`, {
        method: 'POST',
        body: JSON.stringify({
          handoverDate: handoverForm.handoverDate,
          keysReturned: handoverForm.keysReturned,
          tenantAcknowledged: handoverForm.tenantAcknowledged,
          notes: handoverForm.notes,
          finalReadings,
          damages: damagesPayload,
        }),
      });
      setHandoverTarget(null);
      setSuccess(`تم اعتماد محضر التسليم وإعداد كشف التسوية (الصافي: ${formatMoney(res.netPayable, org.base_currency)}). الوحدة أصبحت شاغرة.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleApproveSettlement(settlementId: string) {
    setError(null);
    try {
      const mainCb = cashboxes.find((c) => c.cashbox_type === 'MAIN');
      await apiFetch(`/api/settlements/${settlementId}/approve-post`, {
        method: 'POST',
        body: JSON.stringify({ cashboxId: mainCb?.id }),
      });
      setSuccess('تم اعتماد وترحيل كشف التسوية وتصفير التأمين وإغلاق العقد بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleForfeit(e: React.FormEvent) {
    e.preventDefault();
    if (!forfeitTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/deposits/${forfeitTarget.id}/forfeit`, {
        method: 'POST',
        body: JSON.stringify(forfeitForm),
      });
      setForfeitTarget(null);
      setSuccess('تمت مصادرة التأمين المحددة بقيد محاسبي موثّق.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const activeAgreements = agreements.filter((a) => a.status === 'ACTIVE');
  const showHijri = Boolean(org.show_hijri_dates);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">الإخلاء والمهلة والتسليم وتسوية التأمين</h1>
          <p className="text-xs text-slate-500 mt-1">
            لا إيجار خلال فترة المهلة · مقارنة صور الدخول والخروج · قراءات ختامية · خصم الأضرار موثّق بالصور
          </p>
        </div>
        <button type="button" onClick={() => setInitOpen(true)} className={primaryBtnCls}>
          <DoorOpen className="w-4 h-4" aria-hidden="true" />
          <span>طلب إخلاء جديد</span>
        </button>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} />

      {loading ? (
        <LoadingRows />
      ) : (
        <div className="space-y-6">
          <Panel title="طلبات الإخلاء ومحاضر التسليم والتسويات">
            {(data?.evictions ?? []).length === 0 ? (
              <EmptyState title="لا توجد طلبات إخلاء" description="عند رغبة المستأجر أو المالك في إنهاء عقد عليه حركات مالية، يبدأ الإجراء من هنا." />
            ) : (
              <div className="space-y-4">
                {data!.evictions.map((ev) => (
                  <div key={ev.id} className="border border-slate-200 rounded-lg p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold text-slate-900">
                          {ev.property_name} · وحدة {ev.unit_number} — {ev.tenant_name}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5 font-mono">
                          الإشعار: {formatDateDisplay(ev.notice_date, showHijri)} · المهلة: {ev.grace_days} يوم (حتى {formatDateDisplay(ev.extended_until || ev.grace_end_date, showHijri)}) · معفى: {formatMoney(ev.waived_unpaid_rent, org.base_currency)} · مقدم مهلة: {formatMoney(ev.advance_rent_credit, org.base_currency)}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusText status={ev.status} />
                        {['IN_GRACE', 'OVERDUE'].includes(ev.status) && (
                          <>
                            <button type="button" onClick={() => openHandover(ev)} className={primaryBtnCls}>
                              <ClipboardCheck className="w-4 h-4" aria-hidden="true" />
                              <span>محضر التسليم</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setExtendTarget(ev);
                                setExtendForm({ extendedUntil: ev.extended_until || ev.grace_end_date, reason: '' });
                              }}
                              className={secondaryBtnCls}
                            >
                              <CalendarClock className="w-4 h-4" aria-hidden="true" />
                              <span>تمديد المهلة</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setWithdrawTarget(ev);
                                setRestoreGraceRent(true);
                              }}
                              className={secondaryBtnCls}
                            >
                              سحب الطلب
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {((ev.entryPhotos ?? []).length > 0 || (ev.exitPhotos ?? []).length > 0) && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-slate-100">
                        <div>
                          <div className="text-xs font-semibold text-slate-700 mb-1.5">صور الاستلام عند الدخول ({ev.entryPhotos.length})</div>
                          <div className="flex flex-wrap gap-2">
                            {ev.entryPhotos.map((ph: any) => (
                              <img key={ph.id} src={`/api/attachments/${ph.id}/content`} alt={ph.file_name} className="w-24 h-20 object-cover rounded border border-slate-200" />
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-slate-700 mb-1.5">صور التسليم عند الخروج ({ev.exitPhotos.length})</div>
                          <div className="flex flex-wrap gap-2">
                            {ev.exitPhotos.map((ph: any) => (
                              <img key={ph.id} src={`/api/attachments/${ph.id}/content`} alt={ph.file_name} className="w-24 h-20 object-cover rounded border border-slate-200" />
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {ev.settlement && (
                      <div className="bg-slate-50 border border-slate-200 rounded-md p-3 text-xs flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1">
                          <div className="font-semibold text-slate-800">
                            كشف التسوية ({ev.settlement.status === 'POSTED' ? 'مرحّل ومعتمد' : 'مسودة بانتظار اعتماد المالك'})
                          </div>
                          <div className="font-mono text-slate-600">
                            التأمين المحتجز: {formatMoney(ev.settlement.held_deposit, org.base_currency)} + مقدم: {formatMoney(ev.settlement.advance_rent_credit, org.base_currency)} − تلفيات: {formatMoney(ev.settlement.damages_total, org.base_currency)} − إيجار مستحق: {formatMoney(ev.settlement.unpaid_rent_total, org.base_currency)} − خدمات: {formatMoney(ev.settlement.unpaid_services_total, org.base_currency)} ={' '}
                            <strong className="text-slate-900">الصافي: {formatMoney(ev.settlement.net_payable, org.base_currency)}</strong>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setPrintDoc({
                                kind: 'SETTLEMENT',
                                eviction: ev,
                                currency: org.base_currency,
                                orgName: org.name,
                                showHijri,
                              })
                            }
                            className={secondaryBtnCls}
                          >
                            <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>طباعة التسوية</span>
                          </button>
                          {ev.settlement.status !== 'POSTED' && user.role === 'OWNER' && (
                            <button type="button" onClick={() => handleApproveSettlement(ev.settlement.id)} className={primaryBtnCls}>
                              <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                              <span>اعتماد وترحيل التسوية</span>
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="سجل التأمينات المحتجزة" subtitle="التأمين التزام على المنشأة، رصيده لا يقل عن صفر ويصبح صفراً بعد التسوية">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-right">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2 px-3 font-medium">العقار / الوحدة</th>
                    <th className="py-2 px-3 font-medium">المستأجر</th>
                    <th className="py-2 px-3 font-medium">المستلم</th>
                    <th className="py-2 px-3 font-medium">الرصيد المحتجز</th>
                    <th className="py-2 px-3 font-medium">الحالة</th>
                    <th className="py-2 px-3 font-medium">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(data?.deposits ?? []).map((d) => (
                    <tr key={d.id}>
                      <td className="py-2.5 px-3">{d.property_name} · وحدة {d.unit_number}</td>
                      <td className="py-2.5 px-3">{d.tenant_name}</td>
                      <td className="py-2.5 px-3 font-mono tabular-nums">{formatMoney(d.received_amount, org.base_currency)}</td>
                      <td className="py-2.5 px-3 font-mono tabular-nums font-semibold">{formatMoney(d.held_balance, org.base_currency)}</td>
                      <td className="py-2.5 px-3"><StatusText status={d.status} /></td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-1.5">
                          <button type="button" onClick={() => setMovementsTarget(d)} className={secondaryBtnCls}>
                            <History className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>الحركات ({d.movements?.length ?? 0})</span>
                          </button>
                          {user.role === 'OWNER' && Number(d.held_balance) > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setForfeitTarget(d);
                                setForfeitForm({ amount: d.held_balance, reason: '' });
                              }}
                              className={dangerBtnCls}
                            >
                              مصادرة لإخلال
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}

      {/* Initiate Eviction */}
      <Modal open={initOpen} title="إنشاء طلب إخلاء ومهلة بلا إيجار" onClose={() => setInitOpen(false)}>
        <form onSubmit={handleInitiateEviction} className="space-y-4">
          <Field label="العقد النشط" id="ev-agr" required>
            <select id="ev-agr" required value={initForm.agreementId} onChange={(e) => setInitForm({ ...initForm, agreementId: e.target.value })} className={inputCls}>
              <option value="">اختر العقد...</option>
              {activeAgreements.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.property_name} · وحدة {a.unit_number} ({a.tenant_name})
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="تاريخ الإشعار" id="ev-nd" required>
              <input id="ev-nd" type="date" required value={initForm.noticeDate} onChange={(e) => setInitForm({ ...initForm, noticeDate: e.target.value })} className={inputCls} />
            </Field>
            <Field label="أيام المهلة (بلا إيجار)" id="ev-gd" required>
              <input id="ev-gd" type="number" min={0} required value={initForm.graceDays} onChange={(e) => setInitForm({ ...initForm, graceDays: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <Field label="سبب الإخلاء" id="ev-reason" required>
            <input id="ev-reason" required value={initForm.reason} onChange={(e) => setInitForm({ ...initForm, reason: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setInitOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>إصدار الإشعار</button>
          </div>
        </form>
      </Modal>

      {/* Extend Grace Modal */}
      <Modal open={Boolean(extendTarget)} title="تمديد مهلة الإخلاء" onClose={() => setExtendTarget(null)}>
        <form onSubmit={handleExtend} className="space-y-4">
          <Field label="تاريخ انتهاء المهلة الجديد" id="ext-date" required>
            <input id="ext-date" type="date" required value={extendForm.extendedUntil} onChange={(e) => setExtendForm({ ...extendForm, extendedUntil: e.target.value })} className={inputCls} />
          </Field>
          <Field label="سبب التمديد الموثق" id="ext-reason" required>
            <input id="ext-reason" required value={extendForm.reason} onChange={(e) => setExtendForm({ ...extendForm, reason: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setExtendTarget(null)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ التمديد</button>
          </div>
        </form>
      </Modal>

      {/* Withdraw Eviction Modal */}
      <Modal open={Boolean(withdrawTarget)} title="تأكيد سحب طلب الإخلاء" onClose={() => setWithdrawTarget(null)}>
        <form onSubmit={handleWithdraw} className="space-y-4">
          <p className="text-xs text-slate-600">سيعود العقد إلى حالة نشط (ACTIVE).</p>
          <label className="flex items-center gap-2 text-xs text-slate-800">
            <input type="checkbox" checked={restoreGraceRent} onChange={(e) => setRestoreGraceRent(e.target.checked)} />
            <span>استرجاع الإيجار المعفى خلال فترة المهلة وإلغاء الإشعار الدائن</span>
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setWithdrawTarget(null)} className={secondaryBtnCls}>تراجع</button>
            <button type="submit" className={primaryBtnCls}>تأكيد السحب</button>
          </div>
        </form>
      </Modal>

      {/* Handover Inspection Modal */}
      <Modal open={Boolean(handoverTarget)} title="محضر التسليم وتقييم الأضرار والقراءات الختامية" onClose={() => setHandoverTarget(null)} wide>
        <form onSubmit={handleHandover} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="تاريخ التسليم الفعلي" id="ho-date" required>
              <input id="ho-date" type="date" required value={handoverForm.handoverDate} onChange={(e) => setHandoverForm({ ...handoverForm, handoverDate: e.target.value })} className={inputCls} />
            </Field>
            <Field label="صورة استلام الخروج (اختياري)" id="ho-exit-photo">
              <input
                id="ho-exit-photo"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => setHandoverForm((f) => ({ ...f, exitPhotoBase64: String(reader.result || ''), exitPhotoName: file.name }));
                  reader.readAsDataURL(file);
                }}
                className="text-xs text-slate-600"
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-4 text-xs">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={handoverForm.keysReturned} onChange={(e) => setHandoverForm({ ...handoverForm, keysReturned: e.target.checked })} />
              <span>تم استلام المفاتيح</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={handoverForm.tenantAcknowledged} onChange={(e) => setHandoverForm({ ...handoverForm, tenantAcknowledged: e.target.checked })} />
              <span>إقرار المستأجر بالمحضر</span>
            </label>
          </div>
          <Field label="ملاحظات المحضر" id="ho-notes">
            <input id="ho-notes" value={handoverForm.notes} onChange={(e) => setHandoverForm({ ...handoverForm, notes: e.target.value })} className={inputCls} />
          </Field>

          {(handoverTarget?.meters ?? []).length > 0 && (
            <div className="border-t border-slate-200 pt-3 space-y-2">
              <div className="text-xs font-semibold text-slate-800">قراءات العدادات الختامية للوحدة</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {handoverTarget.meters.map((m: any) => (
                  <Field key={m.id} label={`${m.service_name} (${m.meter_number}) — السابق ${m.last_reading}`} id={`ho-mtr-${m.id}`}>
                    <input
                      id={`ho-mtr-${m.id}`}
                      type="number"
                      step="0.01"
                      value={handoverForm.finalReadings[m.id] ?? ''}
                      onChange={(e) =>
                        setHandoverForm((f) => ({
                          ...f,
                          finalReadings: { ...f.finalReadings, [m.id]: e.target.value },
                        }))
                      }
                      className={inputCls}
                    />
                  </Field>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-slate-200 pt-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-slate-800">بنود الأضرار والتلفيات (يتطلب صورة موثّقة لكل بند)</div>
              <button
                type="button"
                onClick={() =>
                  setHandoverForm((f) => ({
                    ...f,
                    damages: [...f.damages, { description: '', cost: '', vendorName: '', photoBase64: '', photoName: '' }],
                  }))
                }
                className={secondaryBtnCls}
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>إضافة بند تلف</span>
              </button>
            </div>
            {handoverForm.damages.map((dmg, idx) => (
              <div key={idx} className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Field label="وصف التلف" id={`dmg-d-${idx}`} required>
                    <input
                      id={`dmg-d-${idx}`}
                      required
                      value={dmg.description}
                      onChange={(e) => {
                        const next = [...handoverForm.damages];
                        next[idx] = { ...dmg, description: e.target.value };
                        setHandoverForm({ ...handoverForm, damages: next });
                      }}
                      className={inputCls}
                    />
                  </Field>
                  <Field label="التكلفة المقدرة" id={`dmg-c-${idx}`} required>
                    <input
                      id={`dmg-c-${idx}`}
                      type="number"
                      step="0.01"
                      required
                      value={dmg.cost}
                      onChange={(e) => {
                        const next = [...handoverForm.damages];
                        next[idx] = { ...dmg, cost: e.target.value };
                        setHandoverForm({ ...handoverForm, damages: next });
                      }}
                      className={inputCls}
                    />
                  </Field>
                  <Field label="المقاول (اختياري)" id={`dmg-v-${idx}`}>
                    <input
                      id={`dmg-v-${idx}`}
                      value={dmg.vendorName}
                      onChange={(e) => {
                        const next = [...handoverForm.damages];
                        next[idx] = { ...dmg, vendorName: e.target.value };
                        setHandoverForm({ ...handoverForm, damages: next });
                      }}
                      className={inputCls}
                    />
                  </Field>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => {
                        const next = [...handoverForm.damages];
                        next[idx] = { ...dmg, photoBase64: String(reader.result || ''), photoName: file.name };
                        setHandoverForm((f) => ({ ...f, damages: next }));
                      };
                      reader.readAsDataURL(file);
                    }}
                    className="text-xs text-slate-600"
                  />
                  <button
                    type="button"
                    onClick={() => setHandoverForm({ ...handoverForm, damages: handoverForm.damages.filter((_, i) => i !== idx) })}
                    className={dangerBtnCls}
                  >
                    حذف البند
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setHandoverTarget(null)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ المحضر وإعداد التسوية</button>
          </div>
        </form>
      </Modal>

      {/* Deposit Movements Modal */}
      <Modal open={Boolean(movementsTarget)} title={`حركات تأمين وحدة ${movementsTarget?.unit_number ?? ''}`} onClose={() => setMovementsTarget(null)}>
        <div className="space-y-3">
          {(movementsTarget?.movements ?? []).length === 0 ? (
            <p className="text-xs text-slate-500">لا توجد حركات مسجلة على هذا التأمين بعد.</p>
          ) : (
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
              {movementsTarget.movements.map((mv: any) => (
                <div key={mv.id} className="p-3 flex items-center justify-between text-xs">
                  <div>
                    <div className="font-semibold text-slate-900">{mv.movement_type}</div>
                    <div className="text-slate-500">{mv.notes || '—'} · {mv.created_at?.slice(0, 10)}</div>
                  </div>
                  <div className="font-mono font-semibold">{formatMoney(mv.amount, org.base_currency)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {/* Forfeit Deposit */}
      <Modal open={Boolean(forfeitTarget)} title="مصادرة التأمين لإخلال بالعقد" onClose={() => setForfeitTarget(null)}>
        <form onSubmit={handleForfeit} className="space-y-4">
          <Field label="المبلغ المصادَر" id="ff-amt" required>
            <input id="ff-amt" type="number" step="0.01" required value={forfeitForm.amount} onChange={(e) => setForfeitForm({ ...forfeitForm, amount: e.target.value })} className={inputCls} />
          </Field>
          <Field label="السبب المكتوب للإخلال" id="ff-reason" required>
            <input id="ff-reason" required value={forfeitForm.reason} onChange={(e) => setForfeitForm({ ...forfeitForm, reason: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setForfeitTarget(null)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={dangerBtnCls}>تأكيد المصادرة</button>
          </div>
        </form>
      </Modal>

      <PrintableDocumentModal doc={printDoc} onClose={() => setPrintDoc(null)} />
    </div>
  );
}
