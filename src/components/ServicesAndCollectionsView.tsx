import React, { useEffect, useState } from 'react';
import {
  ArrowLeftRight,
  Ban,
  Edit3,
  Gauge,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  RotateCcw,
  Split,
  Trash2,
  Wallet,
} from 'lucide-react';
import {
  apiFetch,
  CASHBOX_TYPE_LABELS,
  formatDateDisplay,
  formatMoney,
  OrganizationInfo,
  REFERENCE_TYPE_LABELS,
  VOUCHER_TYPE_LABELS,
} from '../lib/api';
import { PrintableDocPayload, PrintableDocumentModal } from './DocumentAndAttachmentModals';
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

interface TierRow {
  fromQty: string;
  toQty: string;
  unitPrice: string;
}

export function ServicesView({ org }: { org: OrganizationInfo }) {
  const [data, setData] = useState<any>(null);
  const [properties, setProperties] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [tab, setTab] = useState<'bills' | 'meters' | 'readings' | 'defs' | 'policies' | 'recurring'>('bills');

  const [defOpen, setDefOpen] = useState(false);
  const [editingDef, setEditingDef] = useState<any>(null);
  const [defForm, setDefForm] = useState({
    code: '',
    name: '',
    serviceType: 'METERED',
    unitPrice: '0.25',
    fixedFee: '10',
    defaultChargeTo: 'TENANT',
    tiers: [] as TierRow[],
  });

  const [meterOpen, setMeterOpen] = useState(false);
  const [meterForm, setMeterForm] = useState({
    serviceId: '',
    scope: 'UNIT',
    propertyId: '',
    unitId: '',
    meterNumber: '',
    initialReading: '0',
  });

  const [readingMeter, setReadingMeter] = useState<any>(null);
  const [readingForm, setReadingForm] = useState({
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    currentReading: '',
    isReset: false,
    resetNote: '',
    chargeToOverride: '',
    distributionMethod: 'EQUAL',
    includeOwnedUnits: true,
  });

  const [sharedOpen, setSharedOpen] = useState(false);
  const [sharedForm, setSharedForm] = useState({
    propertyId: '',
    serviceId: '',
    totalCost: '900',
    method: 'EQUAL',
    includeOwnedUnits: true,
    excludedUnitIds: [] as string[],
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
  });

  const [recOpen, setRecOpen] = useState(false);
  const [recForm, setRecForm] = useState({
    propertyId: '',
    unitId: '',
    serviceId: '',
    amount: '150',
    chargeTo: 'TENANT',
    frequency: 'MONTHLY',
    startDate: '2026-11-01',
  });

  const [voidTarget, setVoidTarget] = useState<any>(null);
  const [voidReason, setVoidReason] = useState('');
  const [printDoc, setPrintDoc] = useState<PrintableDocPayload>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [sRes, pRes] = await Promise.all([apiFetch('/api/services'), apiFetch('/api/properties')]);
      setData(sRes);
      setProperties(pRes.properties);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openNewDef() {
    setEditingDef(null);
    setDefForm({
      code: '',
      name: '',
      serviceType: 'METERED',
      unitPrice: '0.25',
      fixedFee: '10',
      defaultChargeTo: 'TENANT',
      tiers: [],
    });
    setDefOpen(true);
  }

  function openEditDef(sd: any) {
    setEditingDef(sd);
    setDefForm({
      code: sd.code,
      name: sd.name,
      serviceType: sd.service_type,
      unitPrice: String(sd.unit_price ?? '0'),
      fixedFee: String(sd.fixed_fee ?? '0'),
      defaultChargeTo: sd.default_charge_to ?? 'TENANT',
      tiers: Array.isArray(sd.tiers)
        ? sd.tiers.map((t: any) => ({
            fromQty: String(t.fromQty ?? '0'),
            toQty: t.toQty !== null && t.toQty !== undefined ? String(t.toQty) : '',
            unitPrice: String(t.unitPrice ?? '0'),
          }))
        : [],
    });
    setDefOpen(true);
  }

  async function handleSaveDef(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const payload = {
        ...defForm,
        tiers: defForm.tiers.map((t) => ({
          fromQty: t.fromQty || '0',
          toQty: t.toQty === '' ? null : t.toQty,
          unitPrice: t.unitPrice || '0',
        })),
      };
      if (editingDef) {
        await apiFetch(`/api/services/definitions/${editingDef.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setSuccess('تم تحديث تعريف الخدمة والشرائح بنجاح.');
      } else {
        await apiFetch('/api/services/definitions', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setSuccess('تم تعريف الخدمة بنجاح.');
      }
      setDefOpen(false);
      setEditingDef(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleCreateMeter(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/services/meters', { method: 'POST', body: JSON.stringify(meterForm) });
      setMeterOpen(false);
      setSuccess('تمت إضافة العداد بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleRecordReading(e: React.FormEvent) {
    e.preventDefault();
    if (!readingMeter) return;
    setError(null);
    try {
      const res = await apiFetch<{ consumption: string; totalAmount: string; issuedBillIds: string[] }>('/api/services/readings', {
        method: 'POST',
        body: JSON.stringify({
          meterId: readingMeter.id,
          ...readingForm,
          chargeToOverride: readingForm.chargeToOverride || undefined,
        }),
      });
      setReadingMeter(null);
      setSuccess(
        `تم تسجيل القراءة (الاستهلاك: ${res.consumption}) وإصدار ${res.issuedBillIds.length} فاتورة بإجمالي ${formatMoney(res.totalAmount, org.base_currency)}.`,
      );
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleSharedDistribute(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<{ billIds: string[] }>('/api/services/shared-distribute', {
        method: 'POST',
        body: JSON.stringify(sharedForm),
      });
      setSharedOpen(false);
      setSuccess(`تم توزيع التكلفة المشتركة وحفظ السياسة وإصدار ${res.billIds.length} فاتورة للوحدات المشاركة.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleVoidBill(e: React.FormEvent) {
    e.preventDefault();
    if (!voidTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/services/bills/${voidTarget.id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: voidReason || 'إلغاء فاتورة خدمة' }),
      });
      setVoidTarget(null);
      setVoidReason('');
      setSuccess('تم إلغاء الفاتورة وعكس قيدها المحاسبي.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleCreateRecurring(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/services/recurring', {
        method: 'POST',
        body: JSON.stringify(recForm),
      });
      setRecOpen(false);
      setSuccess('تم إنشاء عقد الخدمة المتكرر وإصدار الفاتورة الأولى.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function toggleRecurring(rc: any) {
    setError(null);
    try {
      await apiFetch(`/api/services/recurring/${rc.id}`, {
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
      const res = await apiFetch<{ generatedCount: number }>('/api/services/recurring/generate-due', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setSuccess(`تم توليد ${res.generatedCount} فاتورة مستحقة من عقود الخدمات المتكررة.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const showHijri = Boolean(org.show_hijri_dates);
  const selectedPropUnits = properties.find((p) => p.id === meterForm.propertyId)?.units ?? [];
  const sharedPropUnits = properties.find((p) => p.id === sharedForm.propertyId)?.units ?? [];
  const recPropUnits = properties.find((p) => p.id === recForm.propertyId)?.units ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">الخدمات والعدادات والتكاليف المشتركة</h1>
          <p className="text-xs text-slate-500 mt-1">
            شرائح تسعير تدريجية · القراءة السابقة آلية · سياسات التوزيع المشترك · عقود الخدمات المتكررة
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setSharedOpen(true)} className={secondaryBtnCls}>
            <Split className="w-4 h-4" aria-hidden="true" />
            <span>توزيع تكلفة مشتركة</span>
          </button>
          <button type="button" onClick={() => setMeterOpen(true)} className={secondaryBtnCls}>
            <Gauge className="w-4 h-4" aria-hidden="true" />
            <span>عداد جديد</span>
          </button>
          <button type="button" onClick={openNewDef} className={primaryBtnCls}>
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>تعريف خدمة</span>
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {[
          { id: 'bills', label: `الفواتير (${data?.bills?.length ?? 0})` },
          { id: 'meters', label: `العدادات (${data?.meters?.length ?? 0})` },
          { id: 'readings', label: `سجل القراءات (${data?.readings?.length ?? 0})` },
          { id: 'defs', label: `تعريف الخدمات (${data?.definitions?.length ?? 0})` },
          { id: 'policies', label: `سياسات التوزيع (${data?.policies?.length ?? 0})` },
          { id: 'recurring', label: `الخدمات المتكررة (${data?.recurring?.length ?? 0})` },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as any)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} />

      {loading ? (
        <LoadingRows />
      ) : tab === 'bills' ? (
        <Panel>
          {(data?.bills ?? []).length === 0 ? (
            <EmptyState title="لا توجد فواتير خدمات" description="سجّل قراءة عداد أو وزّع تكلفة مشتركة لإصدار الفواتير." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-right">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2.5 px-3 font-medium">الرقم</th>
                    <th className="py-2.5 px-3 font-medium">الخدمة</th>
                    <th className="py-2.5 px-3 font-medium">العقار / الوحدة</th>
                    <th className="py-2.5 px-3 font-medium">الدافع</th>
                    <th className="py-2.5 px-3 font-medium">الفترة</th>
                    <th className="py-2.5 px-3 font-medium">المبلغ / المسدد</th>
                    <th className="py-2.5 px-3 font-medium">الحالة</th>
                    <th className="py-2.5 px-3 font-medium">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.bills.map((b: any) => (
                    <tr key={b.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-3 font-mono text-xs whitespace-nowrap">{b.bill_number}</td>
                      <td className="py-2.5 px-3 font-medium text-slate-900 whitespace-nowrap">{b.service_name}</td>
                      <td className="py-2.5 px-3 text-slate-700 min-w-[140px]">
                        <div className="font-medium text-slate-800">{b.property_name}</div>
                        <div className="text-xs text-slate-500">وحدة {b.unit_number}</div>
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-600 min-w-[130px]">
                        <div>{b.payer_name}</div>
                        <div className="text-slate-400">
                          {b.payer_role === 'UNIT_OWNER' ? 'مالك وحدة' : b.payer_role === 'OWNER' ? 'مالك عقار' : 'مستأجر'}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                        <div>من: {formatDateDisplay(b.period_start, showHijri)}</div>
                        <div>إلى: {formatDateDisplay(b.period_end, showHijri)}</div>
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums whitespace-nowrap">
                        <div className="font-medium text-slate-900">{formatMoney(b.amount, org.base_currency)}</div>
                        <div className="text-[11px] text-slate-500">مسدد: {formatMoney(b.paid_amount, org.base_currency)}</div>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <StatusText status={b.status} />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              setPrintDoc({
                                kind: 'BILL',
                                bill: b,
                                currency: org.base_currency,
                                orgName: org.name,
                                showHijri,
                              })
                            }
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                            title="طباعة الفاتورة"
                          >
                            <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>طباعة</span>
                          </button>
                          {b.status === 'ISSUED' && Number(b.paid_amount) === 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setVoidTarget(b);
                                setVoidReason('');
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                            >
                              <Ban className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>إلغاء</span>
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
      ) : tab === 'meters' ? (
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-2.5 px-3 font-medium">رقم العداد</th>
                  <th className="py-2.5 px-3 font-medium">الخدمة</th>
                  <th className="py-2.5 px-3 font-medium">النطاق</th>
                  <th className="py-2.5 px-3 font-medium">العقار / الوحدة</th>
                  <th className="py-2.5 px-3 font-medium">آخر قراءة</th>
                  <th className="py-2.5 px-3 font-medium">إجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(data?.meters ?? []).map((m: any) => (
                  <tr key={m.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-3 font-mono font-medium">{m.meter_number}</td>
                    <td className="py-2.5 px-3">{m.service_name}</td>
                    <td className="py-2.5 px-3 text-xs">{m.scope === 'PROPERTY' ? 'مشترك للعقار' : 'وحدة'}</td>
                    <td className="py-2.5 px-3">
                      {m.property_name} {m.unit_number ? `· وحدة ${m.unit_number}` : ''}
                    </td>
                    <td className="py-2.5 px-3 font-mono tabular-nums whitespace-nowrap">
                      {m.last_reading} {m.last_reading_date ? `(${m.last_reading_date})` : ''}
                    </td>
                    <td className="py-2.5 px-3">
                      <button
                        type="button"
                        onClick={() => {
                          setReadingMeter(m);
                          setReadingForm((f) => ({
                            ...f,
                            currentReading: m.last_reading,
                            isReset: false,
                            resetNote: '',
                            chargeToOverride: '',
                          }));
                        }}
                        className={secondaryBtnCls}
                      >
                        تسجيل قراءة وإصدار فاتورة
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : tab === 'readings' ? (
        <Panel title="سجل القراءات المعتمدة">
          {(data?.readings ?? []).length === 0 ? (
            <EmptyState title="لا توجد قراءات مسجلة" description="سجّل أول قراءة من تبويب العدادات." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-right">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2.5 px-3 font-medium">العداد / الخدمة</th>
                    <th className="py-2.5 px-3 font-medium">العقار / الوحدة</th>
                    <th className="py-2.5 px-3 font-medium">الفترة</th>
                    <th className="py-2.5 px-3 font-medium">السابقة</th>
                    <th className="py-2.5 px-3 font-medium">الحالية</th>
                    <th className="py-2.5 px-3 font-medium">الاستهلاك</th>
                    <th className="py-2.5 px-3 font-medium">ملاحظة الضبط</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(data?.readings ?? []).map((r: any) => (
                    <tr key={r.id}>
                      <td className="py-2.5 px-3 font-mono text-xs">
                        {r.meter_number} · {r.service_name}
                      </td>
                      <td className="py-2.5 px-3 text-xs">
                        {r.property_name} {r.unit_number ? `· وحدة ${r.unit_number}` : '(مشترك)'}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-xs whitespace-nowrap">
                        {r.period_start} ← {r.period_end}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums">{r.previous_reading}</td>
                      <td className="py-2.5 px-3 font-mono tabular-nums">{r.current_reading}</td>
                      <td className="py-2.5 px-3 font-mono tabular-nums font-semibold text-teal-800">{r.consumption}</td>
                      <td className="py-2.5 px-3 text-xs text-slate-500">
                        {r.is_reset ? `إعادة ضبط: ${r.reset_note || '—'}` : 'عادي'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : tab === 'defs' ? (
        <Panel title="تعريف الخدمات وشرائح التعرفة">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-2.5 px-3 font-medium">الرمز</th>
                  <th className="py-2.5 px-3 font-medium">الاسم</th>
                  <th className="py-2.5 px-3 font-medium">النوع</th>
                  <th className="py-2.5 px-3 font-medium">سعر الوحدة</th>
                  <th className="py-2.5 px-3 font-medium">الرسم الثابت</th>
                  <th className="py-2.5 px-3 font-medium">الشرائح</th>
                  <th className="py-2.5 px-3 font-medium">التحميل الافتراضي</th>
                  <th className="py-2.5 px-3 font-medium">تعديل</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(data?.definitions ?? []).map((sd: any) => (
                  <tr key={sd.id}>
                    <td className="py-2.5 px-3 font-mono">{sd.code}</td>
                    <td className="py-2.5 px-3 font-medium">{sd.name}</td>
                    <td className="py-2.5 px-3 text-xs">{sd.service_type === 'METERED' ? 'بعدّاد' : 'ثابتة'}</td>
                    <td className="py-2.5 px-3 font-mono tabular-nums">{formatMoney(sd.unit_price, org.base_currency)}</td>
                    <td className="py-2.5 px-3 font-mono tabular-nums">{formatMoney(sd.fixed_fee, org.base_currency)}</td>
                    <td className="py-2.5 px-3 text-xs font-mono">
                      {(sd.tiers ?? []).length > 0 ? `${sd.tiers.length} شرائح` : 'تسعير موحد'}
                    </td>
                    <td className="py-2.5 px-3">
                      <StatusText status={sd.default_charge_to} />
                    </td>
                    <td className="py-2.5 px-3">
                      <button type="button" onClick={() => openEditDef(sd)} className={secondaryBtnCls}>
                        <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>تعديل / شرائح</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : tab === 'policies' ? (
        <Panel
          title="سياسات التوزيع المشترك المحفوظة"
          action={
            <button type="button" onClick={() => setSharedOpen(true)} className={primaryBtnCls}>
              <Split className="w-4 h-4" aria-hidden="true" />
              <span>توزيع وسياسة جديدة</span>
            </button>
          }
        >
          {(data?.policies ?? []).length === 0 ? (
            <EmptyState title="لا توجد سياسات مسجلة" description="عند تنفيذ توزيع تكلفة مشتركة تُوثَّق السياسة والوحدات المستثناة هنا." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-right">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2 px-3 font-medium">العقار</th>
                    <th className="py-2 px-3 font-medium">الخدمة</th>
                    <th className="py-2 px-3 font-medium">الطريقة</th>
                    <th className="py-2 px-3 font-medium">وحدات التمليك</th>
                    <th className="py-2 px-3 font-medium">تاريخ الإنشاء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.policies.map((p: any) => (
                    <tr key={p.id}>
                      <td className="py-2.5 px-3 font-medium">{p.property_name}</td>
                      <td className="py-2.5 px-3">{p.service_name}</td>
                      <td className="py-2.5 px-3 text-xs">
                        {p.method === 'AREA' ? 'حسب المساحة' : p.method === 'CONSUMPTION' ? 'حسب الاستهلاك' : 'بالتساوي'}
                      </td>
                      <td className="py-2.5 px-3 text-xs">{p.include_owned_units ? 'مشمولة' : 'مستثناة'}</td>
                      <td className="py-2.5 px-3 font-mono text-xs">{p.created_at?.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : (
        <Panel
          title="عقود الخدمات المتكررة (الشهرية / الربع سنوية)"
          action={
            <div className="flex items-center gap-2">
              <button type="button" onClick={generateDueRecurring} className={secondaryBtnCls}>
                <RefreshCw className="w-4 h-4" aria-hidden="true" />
                <span>توليد المستحق الآن</span>
              </button>
              <button type="button" onClick={() => setRecOpen(true)} className={primaryBtnCls}>
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>عقد خدمة متكرر</span>
              </button>
            </div>
          }
        >
          {(data?.recurring ?? []).length === 0 ? (
            <EmptyState title="لا توجد خدمات متكررة" description="عرّف خدمة ثابتة متكررة لوحدة ليتم إصدار فواتيرها دورياً." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-right">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2 px-3 font-medium">العقار / الوحدة</th>
                    <th className="py-2 px-3 font-medium">الخدمة</th>
                    <th className="py-2 px-3 font-medium">المبلغ</th>
                    <th className="py-2 px-3 font-medium">التكرار</th>
                    <th className="py-2 px-3 font-medium">الفاتورة القادمة</th>
                    <th className="py-2 px-3 font-medium">التحميل</th>
                    <th className="py-2 px-3 font-medium">الحالة</th>
                    <th className="py-2 px-3 font-medium">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.recurring.map((rc: any) => (
                    <tr key={rc.id}>
                      <td className="py-2.5 px-3 font-medium">
                        {rc.property_name} · وحدة {rc.unit_number}
                      </td>
                      <td className="py-2.5 px-3">{rc.service_name}</td>
                      <td className="py-2.5 px-3 font-mono tabular-nums">{formatMoney(rc.amount, org.base_currency)}</td>
                      <td className="py-2.5 px-3 text-xs">{rc.frequency === 'QUARTERLY' ? 'ربع سنوي' : 'شهري'}</td>
                      <td className="py-2.5 px-3 font-mono text-xs">{rc.next_bill_date}</td>
                      <td className="py-2.5 px-3"><StatusText status={rc.charge_to} /></td>
                      <td className="py-2.5 px-3"><StatusText status={rc.is_active ? 'ACTIVE' : 'SUSPENDED'} /></td>
                      <td className="py-2.5 px-3">
                        <button type="button" onClick={() => toggleRecurring(rc)} className={secondaryBtnCls}>
                          {rc.is_active ? 'إيقاف' : 'تفعيل'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {/* Define / Edit Service Modal with Tariff Tiers */}
      <Modal
        open={defOpen}
        title={editingDef ? `تعديل خدمة: ${editingDef.name}` : 'تعريف خدمة جديدة وشرائح التعرفة'}
        onClose={() => setDefOpen(false)}
        wide
      >
        <form onSubmit={handleSaveDef} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="الرمز (فريد)" id="sd-code" required>
              <input
                id="sd-code"
                required
                disabled={Boolean(editingDef)}
                value={defForm.code}
                onChange={(e) => setDefForm({ ...defForm, code: e.target.value })}
                className={inputCls}
                dir="ltr"
                placeholder="GAS"
              />
            </Field>
            <Field label="اسم الخدمة" id="sd-name" required>
              <input id="sd-name" required value={defForm.name} onChange={(e) => setDefForm({ ...defForm, name: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="النوع" id="sd-type">
              <select
                id="sd-type"
                disabled={Boolean(editingDef)}
                value={defForm.serviceType}
                onChange={(e) => setDefForm({ ...defForm, serviceType: e.target.value })}
                className={inputCls}
              >
                <option value="METERED">بعدّاد</option>
                <option value="FIXED">رسوم ثابتة</option>
              </select>
            </Field>
            <Field label="جهة التحميل الافتراضية" id="sd-chg">
              <select id="sd-chg" value={defForm.defaultChargeTo} onChange={(e) => setDefForm({ ...defForm, defaultChargeTo: e.target.value })} className={inputCls}>
                <option value="TENANT">على المستأجر</option>
                <option value="OWNER">على المالك</option>
                <option value="SHARED">مشترك</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="سعر الوحدة الافتراضي" id="sd-price">
              <input id="sd-price" type="number" step="0.01" value={defForm.unitPrice} onChange={(e) => setDefForm({ ...defForm, unitPrice: e.target.value })} className={inputCls} />
            </Field>
            <Field label="الرسم الثابت" id="sd-fixed">
              <input id="sd-fixed" type="number" step="0.01" value={defForm.fixedFee} onChange={(e) => setDefForm({ ...defForm, fixedFee: e.target.value })} className={inputCls} />
            </Field>
          </div>

          <div className="border-t border-slate-200 pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-800">شرائح التسعير التدريجي (اختياري)</span>
              <button
                type="button"
                onClick={() =>
                  setDefForm((f) => ({
                    ...f,
                    tiers: [
                      ...f.tiers,
                      {
                        fromQty: f.tiers.length === 0 ? '0' : f.tiers[f.tiers.length - 1].toQty || '0',
                        toQty: '',
                        unitPrice: f.unitPrice,
                      },
                    ],
                  }))
                }
                className={secondaryBtnCls}
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>إضافة شريحة</span>
              </button>
            </div>
            {defForm.tiers.map((t, idx) => (
              <div key={idx} className="grid grid-cols-4 gap-2 items-end bg-slate-50 p-2 rounded">
                <Field label="من استهلاك" id={`tier-from-${idx}`}>
                  <input
                    id={`tier-from-${idx}`}
                    type="number"
                    step="0.01"
                    value={t.fromQty}
                    onChange={(e) => {
                      const next = [...defForm.tiers];
                      next[idx] = { ...t, fromQty: e.target.value };
                      setDefForm({ ...defForm, tiers: next });
                    }}
                    className={inputCls}
                  />
                </Field>
                <Field label="إلى (فارغ = مفتوح)" id={`tier-to-${idx}`}>
                  <input
                    id={`tier-to-${idx}`}
                    type="number"
                    step="0.01"
                    value={t.toQty}
                    onChange={(e) => {
                      const next = [...defForm.tiers];
                      next[idx] = { ...t, toQty: e.target.value };
                      setDefForm({ ...defForm, tiers: next });
                    }}
                    className={inputCls}
                  />
                </Field>
                <Field label="سعر الوحدة" id={`tier-price-${idx}`}>
                  <input
                    id={`tier-price-${idx}`}
                    type="number"
                    step="0.01"
                    value={t.unitPrice}
                    onChange={(e) => {
                      const next = [...defForm.tiers];
                      next[idx] = { ...t, unitPrice: e.target.value };
                      setDefForm({ ...defForm, tiers: next });
                    }}
                    className={inputCls}
                  />
                </Field>
                <button
                  type="button"
                  onClick={() =>
                    setDefForm({ ...defForm, tiers: defForm.tiers.filter((_, i) => i !== idx) })
                  }
                  className={dangerBtnCls}
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setDefOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ الخدمة</button>
          </div>
        </form>
      </Modal>

      {/* Add Meter Modal */}
      <Modal open={meterOpen} title="إضافة عدّاد جديد" onClose={() => setMeterOpen(false)}>
        <form onSubmit={handleCreateMeter} className="space-y-4">
          <Field label="الخدمة" id="mtr-svc" required>
            <select id="mtr-svc" required value={meterForm.serviceId} onChange={(e) => setMeterForm({ ...meterForm, serviceId: e.target.value })} className={inputCls}>
              <option value="">اختر الخدمة...</option>
              {(data?.definitions ?? []).map((sd: any) => (
                <option key={sd.id} value={sd.id}>{sd.name}</option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="النطاق" id="mtr-scope">
              <select id="mtr-scope" value={meterForm.scope} onChange={(e) => setMeterForm({ ...meterForm, scope: e.target.value })} className={inputCls}>
                <option value="UNIT">وحدة محددة</option>
                <option value="PROPERTY">مشترك للعقار</option>
              </select>
            </Field>
            <Field label="العقار" id="mtr-prop" required>
              <select id="mtr-prop" required value={meterForm.propertyId} onChange={(e) => setMeterForm({ ...meterForm, propertyId: e.target.value, unitId: '' })} className={inputCls}>
                <option value="">اختر العقار...</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
          </div>
          {meterForm.scope === 'UNIT' && (
            <Field label="الوحدة" id="mtr-unit" required>
              <select id="mtr-unit" required value={meterForm.unitId} onChange={(e) => setMeterForm({ ...meterForm, unitId: e.target.value })} className={inputCls}>
                <option value="">اختر الوحدة...</option>
                {selectedPropUnits.map((u: any) => (
                  <option key={u.id} value={u.id}>وحدة {u.unit_number}</option>
                ))}
              </select>
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="رقم العداد" id="mtr-num" required>
              <input id="mtr-num" required value={meterForm.meterNumber} onChange={(e) => setMeterForm({ ...meterForm, meterNumber: e.target.value })} className={inputCls} />
            </Field>
            <Field label="القراءة الافتتاحية" id="mtr-init">
              <input id="mtr-init" type="number" step="0.01" value={meterForm.initialReading} onChange={(e) => setMeterForm({ ...meterForm, initialReading: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setMeterOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ العداد</button>
          </div>
        </form>
      </Modal>

      {/* Record Reading Modal */}
      <Modal open={Boolean(readingMeter)} title={`تسجيل قراءة: ${readingMeter?.meter_number ?? ''}`} onClose={() => setReadingMeter(null)}>
        {readingMeter && (
          <form onSubmit={handleRecordReading} className="space-y-4">
            <div className="text-xs text-slate-600 bg-slate-50 p-3 rounded-md font-mono">
              القراءة السابقة المسجلة: {readingMeter.last_reading} · السعر: {readingMeter.unit_price} + ثابت: {readingMeter.fixed_fee}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="بداية الفترة" id="rdg-ps" required>
                <input id="rdg-ps" type="date" required value={readingForm.periodStart} onChange={(e) => setReadingForm({ ...readingForm, periodStart: e.target.value })} className={inputCls} />
              </Field>
              <Field label="نهاية الفترة" id="rdg-pe" required>
                <input id="rdg-pe" type="date" required value={readingForm.periodEnd} onChange={(e) => setReadingForm({ ...readingForm, periodEnd: e.target.value })} className={inputCls} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="القراءة الحالية" id="rdg-curr" required>
                <input id="rdg-curr" type="number" step="0.01" required value={readingForm.currentReading} onChange={(e) => setReadingForm({ ...readingForm, currentReading: e.target.value })} className={inputCls} />
              </Field>
              <Field label="تخصيص جهة التحميل (اختياري)" id="rdg-chg">
                <select id="rdg-chg" value={readingForm.chargeToOverride} onChange={(e) => setReadingForm({ ...readingForm, chargeToOverride: e.target.value })} className={inputCls}>
                  <option value="">حسب افتراضي الخدمة</option>
                  <option value="TENANT">على المستأجر / مالك الوحدة</option>
                  <option value="OWNER">على مالك العقار</option>
                </select>
              </Field>
            </div>
            {readingMeter.scope === 'PROPERTY' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="طريقة التوزيع المشترك" id="rdg-dist">
                  <select id="rdg-dist" value={readingForm.distributionMethod} onChange={(e) => setReadingForm({ ...readingForm, distributionMethod: e.target.value })} className={inputCls}>
                    <option value="EQUAL">بالتساوي</option>
                    <option value="AREA">بالمساحة</option>
                    <option value="CONSUMPTION">حسب استهلاك الوحدات</option>
                  </select>
                </Field>
                <label className="flex items-center gap-2 text-xs text-slate-700 self-end pb-2">
                  <input type="checkbox" checked={readingForm.includeOwnedUnits} onChange={(e) => setReadingForm({ ...readingForm, includeOwnedUnits: e.target.checked })} />
                  <span>شمل وحدات التمليك</span>
                </label>
              </div>
            )}
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={readingForm.isReset} onChange={(e) => setReadingForm({ ...readingForm, isReset: e.target.checked })} />
              <span>إعادة ضبط العداد (Reset) مع توثيق السبب</span>
            </label>
            {readingForm.isReset && (
              <Field label="سبب إعادة الضبط" id="rdg-reset-note" required>
                <input id="rdg-reset-note" required value={readingForm.resetNote} onChange={(e) => setReadingForm({ ...readingForm, resetNote: e.target.value })} className={inputCls} />
              </Field>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setReadingMeter(null)} className={secondaryBtnCls}>إلغاء</button>
              <button type="submit" className={primaryBtnCls}>حفظ القراءة وإصدار الفاتورة</button>
            </div>
          </form>
        )}
      </Modal>

      {/* Shared Distribution Modal with Excluded Units + CONSUMPTION */}
      <Modal open={sharedOpen} title="توزيع تكلفة مشتركة على وحدات العقار" onClose={() => setSharedOpen(false)}>
        <form onSubmit={handleSharedDistribute} className="space-y-4">
          <Field label="العقار" id="sh-prop" required>
            <select
              id="sh-prop"
              required
              value={sharedForm.propertyId}
              onChange={(e) => setSharedForm({ ...sharedForm, propertyId: e.target.value, excludedUnitIds: [] })}
              className={inputCls}
            >
              <option value="">اختر العقار...</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="الخدمة" id="sh-svc" required>
            <select id="sh-svc" required value={sharedForm.serviceId} onChange={(e) => setSharedForm({ ...sharedForm, serviceId: e.target.value })} className={inputCls}>
              <option value="">اختر الخدمة...</option>
              {(data?.definitions ?? []).map((sd: any) => <option key={sd.id} value={sd.id}>{sd.name}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="إجمالي التكلفة" id="sh-cost" required>
              <input id="sh-cost" type="number" step="0.01" required value={sharedForm.totalCost} onChange={(e) => setSharedForm({ ...sharedForm, totalCost: e.target.value })} className={inputCls} />
            </Field>
            <Field label="طريقة التوزيع" id="sh-method">
              <select id="sh-method" value={sharedForm.method} onChange={(e) => setSharedForm({ ...sharedForm, method: e.target.value })} className={inputCls}>
                <option value="EQUAL">بالتساوي (الباقي على آخر وحدة)</option>
                <option value="AREA">حسب المساحة</option>
                <option value="CONSUMPTION">حسب استهلاك الوحدات</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="بداية الفترة" id="sh-ps">
              <input id="sh-ps" type="date" value={sharedForm.periodStart} onChange={(e) => setSharedForm({ ...sharedForm, periodStart: e.target.value })} className={inputCls} />
            </Field>
            <Field label="نهاية الفترة" id="sh-pe">
              <input id="sh-pe" type="date" value={sharedForm.periodEnd} onChange={(e) => setSharedForm({ ...sharedForm, periodEnd: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={sharedForm.includeOwnedUnits} onChange={(e) => setSharedForm({ ...sharedForm, includeOwnedUnits: e.target.checked })} />
            <span>إدراج وحدات التمليك في التوزيع (افتراضي)</span>
          </label>
          {sharedPropUnits.length > 0 && (
            <div className="border-t border-slate-200 pt-2 space-y-1.5">
              <span className="text-xs font-medium text-slate-700 block">استثناء وحدات محددة (اختياري):</span>
              <div className="flex flex-wrap gap-3">
                {sharedPropUnits.map((u: any) => (
                  <label key={u.id} className="inline-flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={sharedForm.excludedUnitIds.includes(u.id)}
                      onChange={(e) =>
                        setSharedForm((f) => ({
                          ...f,
                          excludedUnitIds: e.target.checked
                            ? [...f.excludedUnitIds, u.id]
                            : f.excludedUnitIds.filter((x) => x !== u.id),
                        }))
                      }
                    />
                    <span>وحدة {u.unit_number}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setSharedOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>توزيع وإصدار الفواتير</button>
          </div>
        </form>
      </Modal>

      {/* Recurring Service Modal */}
      <Modal open={recOpen} title="إنشاء عقد خدمة متكرر" onClose={() => setRecOpen(false)}>
        <form onSubmit={handleCreateRecurring} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="العقار" id="rec-prop" required>
              <select
                id="rec-prop"
                required
                value={recForm.propertyId}
                onChange={(e) => setRecForm({ ...recForm, propertyId: e.target.value, unitId: '' })}
                className={inputCls}
              >
                <option value="">اختر...</option>
                {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="الوحدة" id="rec-unit" required>
              <select id="rec-unit" required value={recForm.unitId} onChange={(e) => setRecForm({ ...recForm, unitId: e.target.value })} className={inputCls}>
                <option value="">اختر...</option>
                {recPropUnits.map((u: any) => <option key={u.id} value={u.id}>وحدة {u.unit_number}</option>)}
              </select>
            </Field>
          </div>
          <Field label="الخدمة" id="rec-svc" required>
            <select id="rec-svc" required value={recForm.serviceId} onChange={(e) => setRecForm({ ...recForm, serviceId: e.target.value })} className={inputCls}>
              <option value="">اختر...</option>
              {(data?.definitions ?? []).map((sd: any) => <option key={sd.id} value={sd.id}>{sd.name}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="المبلغ" id="rec-amt" required>
              <input id="rec-amt" type="number" step="0.01" required value={recForm.amount} onChange={(e) => setRecForm({ ...recForm, amount: e.target.value })} className={inputCls} />
            </Field>
            <Field label="التكرار" id="rec-freq">
              <select id="rec-freq" value={recForm.frequency} onChange={(e) => setRecForm({ ...recForm, frequency: e.target.value })} className={inputCls}>
                <option value="MONTHLY">شهري</option>
                <option value="QUARTERLY">ربع سنوي</option>
              </select>
            </Field>
            <Field label="التحميل" id="rec-chg">
              <select id="rec-chg" value={recForm.chargeTo} onChange={(e) => setRecForm({ ...recForm, chargeTo: e.target.value })} className={inputCls}>
                <option value="TENANT">المستأجر / مالك الوحدة</option>
                <option value="OWNER">المالك</option>
              </select>
            </Field>
          </div>
          <Field label="تاريخ البدء" id="rec-start" required>
            <input id="rec-start" type="date" required value={recForm.startDate} onChange={(e) => setRecForm({ ...recForm, startDate: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRecOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ وإصدار الفاتورة الأولى</button>
          </div>
        </form>
      </Modal>

      {/* Void Bill Modal */}
      <Modal open={Boolean(voidTarget)} title={`إلغاء الفاتورة ${voidTarget?.bill_number ?? ''}`} onClose={() => setVoidTarget(null)}>
        <form onSubmit={handleVoidBill} className="space-y-4">
          <p className="text-xs text-slate-600">يتم إلغاء الفاتورة بعكس القيد المحاسبي الصادر لها، ولا يمكن إلغاء الفواتير المسدّدة.</p>
          <Field label="سبب الإلغاء" id="void-reason" required>
            <input id="void-reason" required value={voidReason} onChange={(e) => setVoidReason(e.target.value)} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setVoidTarget(null)} className={secondaryBtnCls}>تراجع</button>
            <button type="submit" className={dangerBtnCls}>تأكيد الإلغاء</button>
          </div>
        </form>
      </Modal>

      <PrintableDocumentModal doc={printDoc} onClose={() => setPrintDoc(null)} />
    </div>
  );
}

export function CollectionsView({ org }: { org: OrganizationInfo }) {
  const [data, setData] = useState<any>(null);
  const [contractsData, setContractsData] = useState<any>(null);
  const [servicesData, setServicesData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [cashboxOpen, setCashboxOpen] = useState(false);
  const [cashboxForm, setCashboxForm] = useState({ name: '', cashboxType: 'BANK' });

  const [collectOpen, setCollectOpen] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<any>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [printDoc, setPrintDoc] = useState<PrintableDocPayload>(null);

  const [collectForm, setCollectForm] = useState({
    cashboxId: '',
    referenceType: 'INSTALLMENT',
    referenceId: '',
    amount: '',
    voucherDate: '2026-11-14',
    description: '',
  });

  const [expenseForm, setExpenseForm] = useState({
    cashboxId: '',
    propertyId: '',
    expenseKind: 'GUARD_SALARY',
    collectorId: '',
    amount: '',
    voucherDate: '2026-11-14',
    description: '',
  });

  const [transferForm, setTransferForm] = useState({
    cashboxId: '',
    targetCashboxId: '',
    amount: '',
    description: 'تحويل بين الصناديق',
  });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [col, ctr, svc] = await Promise.all([
        apiFetch('/api/collections'),
        apiFetch('/api/contracts'),
        apiFetch('/api/services'),
      ]);
      setData(col);
      setContractsData(ctr);
      setServicesData(svc);
      if (col.cashboxes.length > 0 && !collectForm.cashboxId) {
        setCollectForm((f) => ({ ...f, cashboxId: col.cashboxes[0].id }));
        setExpenseForm((f) => ({ ...f, cashboxId: col.cashboxes[0].id }));
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

  const openInstallments = (contractsData?.installments ?? []).filter((i: any) => i.status === 'PENDING' || i.status === 'PARTIAL');
  const openBills = (servicesData?.bills ?? []).filter((b: any) => b.status === 'ISSUED' || b.status === 'PARTIAL');
  const pendingDeposits = (contractsData?.agreements ?? []).filter(
    (a: any) => a.deposit_id && Number(a.deposit_expected) > Number(a.deposit_received),
  );
  const unpaidExpenses = data?.unpaidContractExpenses ?? [];
  const unpaidMaintenance = data?.unpaidTenantMaintenance ?? [];
  const colProperties = data?.properties ?? [];

  async function handleCreateCashbox(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/collections/cashboxes', {
        method: 'POST',
        body: JSON.stringify(cashboxForm),
      });
      setCashboxOpen(false);
      setCashboxForm({ name: '', cashboxType: 'BANK' });
      setSuccess('تم فتح الصندوق / الحساب البنكي بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleCollect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<{ voucherNumber: string }>('/api/collections/vouchers', {
        method: 'POST',
        idempotencyKey: `vch_${Date.now()}`,
        body: JSON.stringify({ voucherType: 'RECEIPT', ...collectForm }),
      });
      setCollectOpen(false);
      setSuccess(`تم إصدار سند القبض ${res.voucherNumber} وتحديث الصندوق والدفتر العام ذرياً.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleRecordExpense(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<{ voucherNumber: string }>('/api/collections/record-operating-expense', {
        method: 'POST',
        body: JSON.stringify(expenseForm),
      });
      setExpenseOpen(false);
      setSuccess(`تم ترحيل سند الصرف ${res.voucherNumber} وتحديث مصروفات العقار والصندوق.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<{ voucherNumber: string }>('/api/collections/vouchers', {
        method: 'POST',
        idempotencyKey: `tr_${Date.now()}`,
        body: JSON.stringify({
          voucherType: 'TRANSFER',
          referenceType: 'CASHBOX_TRANSFER',
          referenceId: transferForm.cashboxId,
          ...transferForm,
        }),
      });
      setTransferOpen(false);
      setSuccess(`تم تنفيذ التحويل بسند ${res.voucherNumber}.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleReverse(e: React.FormEvent) {
    e.preventDefault();
    if (!reverseTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/collections/vouchers/${reverseTarget.id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({ reason: reverseReason }),
      });
      setReverseTarget(null);
      setReverseReason('');
      setSuccess('تم عكس السند والقيد المحاسبي وإعادة حالة المستحق بدون حذف.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const showHijri = Boolean(org.show_hijri_dates);
  const selectedExpCollector = (data?.collectors ?? []).find((c: any) => c.id === expenseForm.collectorId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">التحصيل والصناديق والسندات</h1>
          <p className="text-xs text-slate-500 mt-1">
            تحصيل ذري بمفتاح عدم التكرار · العكس بسند وقيد عكسيين دون حذف · صرف رواتب الحراس ومكافآت المحصلين
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setCashboxOpen(true)} className={secondaryBtnCls}>
            <Wallet className="w-4 h-4" aria-hidden="true" />
            <span>صندوق / بنك جديد</span>
          </button>
          <button type="button" onClick={() => setExpenseOpen(true)} className={secondaryBtnCls}>
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>سند صرف (حارس / محصل)</span>
          </button>
          <button type="button" onClick={() => setTransferOpen(true)} className={secondaryBtnCls}>
            <ArrowLeftRight className="w-4 h-4" aria-hidden="true" />
            <span>تحويل بين الصناديق</span>
          </button>
          <button type="button" onClick={() => setCollectOpen(true)} className={primaryBtnCls}>
            <Receipt className="w-4 h-4" aria-hidden="true" />
            <span>سند قبض جديد</span>
          </button>
        </div>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} />

      {loading ? (
        <LoadingRows />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {(data?.cashboxes ?? []).map((cb: any) => (
              <StatTile
                key={cb.id}
                label={cb.name}
                value={formatMoney(cb.balance, org.base_currency)}
                meta={`حساب ${cb.account_code} · ${CASHBOX_TYPE_LABELS[cb.cashbox_type] ?? cb.cashbox_type}`}
              />
            ))}
          </div>

          <Panel title="سجل السندات المالية" subtitle="كل سند يرتبط بقيد محاسبي متوازن في الدفتر العام ويمكن طباعته">
            {(data?.vouchers ?? []).length === 0 ? (
              <EmptyState title="لا توجد سندات بعد" description="أنشئ سند قبض لتحصيل قسط أو فاتورة أو تأمين أو رسوم عقد." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-right">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs text-slate-500">
                      <th className="py-2.5 px-3 font-medium">رقم السند</th>
                      <th className="py-2.5 px-3 font-medium">النوع / المرجع</th>
                      <th className="py-2.5 px-3 font-medium">الصندوق</th>
                      <th className="py-2.5 px-3 font-medium">الطرف / البيان</th>
                      <th className="py-2.5 px-3 font-medium">التاريخ</th>
                      <th className="py-2.5 px-3 font-medium">المبلغ</th>
                      <th className="py-2.5 px-3 font-medium">الحالة</th>
                      <th className="py-2.5 px-3 font-medium">إجراء</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.vouchers.map((v: any) => (
                      <tr key={v.id} className="hover:bg-slate-50/70">
                        <td className="py-2.5 px-3 font-mono text-xs font-medium whitespace-nowrap">{v.voucher_number}</td>
                        <td className="py-2.5 px-3 text-xs text-slate-600 whitespace-nowrap">
                          {VOUCHER_TYPE_LABELS[v.voucher_type] ?? v.voucher_type} · {REFERENCE_TYPE_LABELS[v.reference_type] ?? v.reference_type}
                        </td>
                        <td className="py-2.5 px-3 text-xs">
                          {v.cashbox_name} {v.target_cashbox_name ? `← ${v.target_cashbox_name}` : ''}
                        </td>
                        <td className="py-2.5 px-3 text-slate-800">
                          {v.party_name ? `${v.party_name} — ` : ''}{v.description}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-xs whitespace-nowrap">{formatDateDisplay(v.voucher_date, showHijri)}</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums font-medium whitespace-nowrap">{formatMoney(v.amount, org.base_currency)}</td>
                        <td className="py-2.5 px-3"><StatusText status={v.status} /></td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setPrintDoc({
                                  kind: 'VOUCHER',
                                  voucher: v,
                                  currency: org.base_currency,
                                  orgName: org.name,
                                  showHijri,
                                })
                              }
                              className={secondaryBtnCls}
                            >
                              <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>طباعة</span>
                            </button>
                            {v.status === 'POSTED' && !v.reversed_voucher_id && (
                              <button type="button" onClick={() => setReverseTarget(v)} className={dangerBtnCls}>
                                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>عكس</span>
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
        </>
      )}

      {/* Create Cashbox Modal */}
      <Modal open={cashboxOpen} title="إنشاء صندوق نقدي أو حساب بنكي" onClose={() => setCashboxOpen(false)}>
        <form onSubmit={handleCreateCashbox} className="space-y-4">
          <Field label="اسم الصندوق / الحساب البنكي" id="cb-name" required>
            <input id="cb-name" required value={cashboxForm.name} onChange={(e) => setCashboxForm({ ...cashboxForm, name: e.target.value })} className={inputCls} placeholder="الحساب البنكي — الراجحي" />
          </Field>
          <Field label="النوع" id="cb-type">
            <select id="cb-type" value={cashboxForm.cashboxType} onChange={(e) => setCashboxForm({ ...cashboxForm, cashboxType: e.target.value })} className={inputCls}>
              <option value="BANK">حساب بنكي (حساب 1130)</option>
              <option value="MAIN">صندوق رئيسي (حساب 1110)</option>
            </select>
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCashboxOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>إنشاء الصندوق</button>
          </div>
        </form>
      </Modal>

      {/* Collect Receipt Modal (supports 5 reference types) */}
      <Modal open={collectOpen} title="إصدار سند قبض (تحصيل ذري)" onClose={() => setCollectOpen(false)}>
        <form onSubmit={handleCollect} className="space-y-4">
          <Field label="الصندوق المستلم" id="col-cb" required>
            <select id="col-cb" required value={collectForm.cashboxId} onChange={(e) => setCollectForm({ ...collectForm, cashboxId: e.target.value })} className={inputCls}>
              {(data?.cashboxes ?? []).map((cb: any) => (
                <option key={cb.id} value={cb.id}>{cb.name} ({formatMoney(cb.balance, org.base_currency)})</option>
              ))}
            </select>
          </Field>
          <Field label="نوع المستحق" id="col-rtype" required>
            <select
              id="col-rtype"
              value={collectForm.referenceType}
              onChange={(e) => setCollectForm({ ...collectForm, referenceType: e.target.value, referenceId: '', amount: '' })}
              className={inputCls}
            >
              <option value="INSTALLMENT">قسط إيجار</option>
              <option value="SERVICE_BILL">فاتورة خدمة</option>
              <option value="SECURITY_DEPOSIT">تأمين عقد</option>
              <option value="CONTRACT_EXPENSE">رسوم ومصاريف عقد على المستأجر</option>
              <option value="MAINTENANCE">تكلفة صيانة محملة على المستأجر</option>
            </select>
          </Field>
          <Field label="المستحق المحدد" id="col-ref" required>
            <select
              id="col-ref"
              required
              value={collectForm.referenceId}
              onChange={(e) => {
                const rid = e.target.value;
                let autoAmt = '';
                if (collectForm.referenceType === 'INSTALLMENT') {
                  const found = openInstallments.find((x: any) => x.id === rid);
                  if (found) autoAmt = (Number(found.amount) - Number(found.paid_amount) - Number(found.waived_amount ?? 0)).toFixed(2);
                } else if (collectForm.referenceType === 'SERVICE_BILL') {
                  const found = openBills.find((x: any) => x.id === rid);
                  if (found) autoAmt = (Number(found.amount) - Number(found.paid_amount)).toFixed(2);
                } else if (collectForm.referenceType === 'SECURITY_DEPOSIT') {
                  const found = pendingDeposits.find((x: any) => x.deposit_id === rid);
                  if (found) autoAmt = (Number(found.deposit_expected) - Number(found.deposit_received)).toFixed(2);
                } else if (collectForm.referenceType === 'CONTRACT_EXPENSE') {
                  const found = unpaidExpenses.find((x: any) => x.id === rid);
                  if (found) autoAmt = (Number(found.amount) - Number(found.paid_amount)).toFixed(2);
                } else if (collectForm.referenceType === 'MAINTENANCE') {
                  const found = unpaidMaintenance.find((x: any) => x.id === rid);
                  if (found) autoAmt = (Number(found.cost) - Number(found.paid_amount)).toFixed(2);
                }
                setCollectForm({ ...collectForm, referenceId: rid, amount: autoAmt });
              }}
              className={inputCls}
            >
              <option value="">اختر المستحق...</option>
              {collectForm.referenceType === 'INSTALLMENT' &&
                openInstallments.map((i: any) => (
                  <option key={i.id} value={i.id}>
                    قسط #{i.installment_number} · {i.property_name} وحدة {i.unit_number} ({i.tenant_name}) — متبقي {(Number(i.amount) - Number(i.paid_amount) - Number(i.waived_amount ?? 0)).toFixed(2)}
                  </option>
                ))}
              {collectForm.referenceType === 'SERVICE_BILL' &&
                openBills.map((b: any) => (
                  <option key={b.id} value={b.id}>
                    {b.bill_number} · {b.service_name} ({b.payer_name}) — متبقي {(Number(b.amount) - Number(b.paid_amount)).toFixed(2)}
                  </option>
                ))}
              {collectForm.referenceType === 'SECURITY_DEPOSIT' &&
                pendingDeposits.map((a: any) => (
                  <option key={a.deposit_id} value={a.deposit_id}>
                    تأمين وحدة {a.unit_number} ({a.tenant_name}) — متبقي {(Number(a.deposit_expected) - Number(a.deposit_received)).toFixed(2)}
                  </option>
                ))}
              {collectForm.referenceType === 'CONTRACT_EXPENSE' &&
                unpaidExpenses.map((ce: any) => (
                  <option key={ce.id} value={ce.id}>
                    {ce.name} · {ce.property_name} وحدة {ce.unit_number} ({ce.tenant_name}) — متبقي {(Number(ce.amount) - Number(ce.paid_amount)).toFixed(2)}
                  </option>
                ))}
              {collectForm.referenceType === 'MAINTENANCE' &&
                unpaidMaintenance.map((m: any) => (
                  <option key={m.id} value={m.id}>
                    {m.maintenance_type} · {m.property_name} {m.unit_number ? `وحدة ${m.unit_number}` : ''} ({m.tenant_name || 'مستأجر'}) — متبقي {(Number(m.cost) - Number(m.paid_amount)).toFixed(2)}
                  </option>
                ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="المبلغ المحصل" id="col-amt" required>
              <input id="col-amt" type="number" step="0.01" required value={collectForm.amount} onChange={(e) => setCollectForm({ ...collectForm, amount: e.target.value })} className={inputCls} />
            </Field>
            <Field label="التاريخ" id="col-date" required>
              <input id="col-date" type="date" required value={collectForm.voucherDate} onChange={(e) => setCollectForm({ ...collectForm, voucherDate: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <Field label="البيان (اختياري)" id="col-desc">
            <input id="col-desc" value={collectForm.description} onChange={(e) => setCollectForm({ ...collectForm, description: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCollectOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>ترحيل السند والقيد</button>
          </div>
        </form>
      </Modal>

      {/* Operating Expense Payment Voucher Modal */}
      <Modal open={expenseOpen} title="سند صرف مصروف تشغيلي (حارس / محصل)" onClose={() => setExpenseOpen(false)}>
        <form onSubmit={handleRecordExpense} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="نوع المصروف" id="op-kind">
              <select
                id="op-kind"
                value={expenseForm.expenseKind}
                onChange={(e) => setExpenseForm({ ...expenseForm, expenseKind: e.target.value })}
                className={inputCls}
              >
                <option value="GUARD_SALARY">راتب حارس عقار (حساب 5400)</option>
                <option value="COLLECTOR_REWARD">مكافأة محصل (حساب 5500)</option>
              </select>
            </Field>
            <Field label="العقار (مركز التكلفة)" id="op-prop" required>
              <select
                id="op-prop"
                required
                value={expenseForm.propertyId}
                onChange={(e) => {
                  const p = colProperties.find((x: any) => x.id === e.target.value);
                  setExpenseForm({
                    ...expenseForm,
                    propertyId: e.target.value,
                    amount: expenseForm.expenseKind === 'GUARD_SALARY' && p?.guard_salary ? String(p.guard_salary) : expenseForm.amount,
                    description:
                      expenseForm.expenseKind === 'GUARD_SALARY' && p?.guard_name
                        ? `راتب الحارس: ${p.guard_name}`
                        : expenseForm.description,
                  });
                }}
                className={inputCls}
              >
                <option value="">اختر العقار...</option>
                {colProperties.map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.guard_name ? `(الحارس: ${p.guard_name} — ${p.guard_salary || 0})` : ''}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {expenseForm.expenseKind === 'COLLECTOR_REWARD' && (
            <Field label="المحصل (لحساب المكافأة الاسترشادي)" id="op-col">
              <select
                id="op-col"
                value={expenseForm.collectorId}
                onChange={(e) => {
                  const c = (data?.collectors ?? []).find((x: any) => x.id === e.target.value);
                  setExpenseForm({
                    ...expenseForm,
                    collectorId: e.target.value,
                    amount: c && c.reward_type === 'FIXED' ? String(c.reward_value) : expenseForm.amount,
                    description: c ? `مكافأة المحصل ${c.full_name}` : expenseForm.description,
                  });
                }}
                className={inputCls}
              >
                <option value="">اختر المحصل...</option>
                {(data?.collectors ?? []).map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name} ({c.reward_type === 'PERCENT' ? `${c.reward_value}%` : c.reward_type === 'FIXED' ? `ثابت ${c.reward_value}` : 'بدون قاعدة'})
                  </option>
                ))}
              </select>
            </Field>
          )}

          {selectedExpCollector && expenseForm.expenseKind === 'COLLECTOR_REWARD' && (
            <div className="p-2.5 bg-teal-50 border border-teal-200 rounded text-xs text-teal-900">
              قاعدة مكافأة المحصل: {selectedExpCollector.reward_type === 'PERCENT' ? `${selectedExpCollector.reward_value}% من التحصيل` : selectedExpCollector.reward_type === 'FIXED' ? `مبلغ ثابت ${selectedExpCollector.reward_value}` : 'غير محددة'}
            </div>
          )}

          <Field label="الصندوق الدافع" id="op-cb" required>
            <select id="op-cb" required value={expenseForm.cashboxId} onChange={(e) => setExpenseForm({ ...expenseForm, cashboxId: e.target.value })} className={inputCls}>
              {(data?.cashboxes ?? []).map((cb: any) => (
                <option key={cb.id} value={cb.id}>{cb.name} ({formatMoney(cb.balance, org.base_currency)})</option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="المبلغ" id="op-amt" required>
              <input id="op-amt" type="number" step="0.01" required value={expenseForm.amount} onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })} className={inputCls} />
            </Field>
            <Field label="التاريخ" id="op-date" required>
              <input id="op-date" type="date" required value={expenseForm.voucherDate} onChange={(e) => setExpenseForm({ ...expenseForm, voucherDate: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <Field label="البيان" id="op-desc">
            <input id="op-desc" value={expenseForm.description} onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setExpenseOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>ترحيل سند الصرف</button>
          </div>
        </form>
      </Modal>

      {/* Transfer Modal */}
      <Modal open={transferOpen} title="تحويل بين الصناديق" onClose={() => setTransferOpen(false)}>
        <form onSubmit={handleTransfer} className="space-y-4">
          <Field label="من الصندوق" id="tr-from" required>
            <select id="tr-from" required value={transferForm.cashboxId} onChange={(e) => setTransferForm({ ...transferForm, cashboxId: e.target.value })} className={inputCls}>
              <option value="">اختر...</option>
              {(data?.cashboxes ?? []).map((cb: any) => (
                <option key={cb.id} value={cb.id}>{cb.name} ({formatMoney(cb.balance, org.base_currency)})</option>
              ))}
            </select>
          </Field>
          <Field label="إلى الصندوق" id="tr-to" required>
            <select id="tr-to" required value={transferForm.targetCashboxId} onChange={(e) => setTransferForm({ ...transferForm, targetCashboxId: e.target.value })} className={inputCls}>
              <option value="">اختر...</option>
              {(data?.cashboxes ?? []).map((cb: any) => (
                <option key={cb.id} value={cb.id}>{cb.name}</option>
              ))}
            </select>
          </Field>
          <Field label="المبلغ" id="tr-amt" required>
            <input id="tr-amt" type="number" step="0.01" required value={transferForm.amount} onChange={(e) => setTransferForm({ ...transferForm, amount: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setTransferOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>تنفيذ التحويل</button>
          </div>
        </form>
      </Modal>

      {/* Reverse Voucher Modal */}
      <Modal open={Boolean(reverseTarget)} title={`عكس السند ${reverseTarget?.voucher_number ?? ''}`} onClose={() => setReverseTarget(null)}>
        <form onSubmit={handleReverse} className="space-y-4">
          <p className="text-xs text-slate-600">
            العكس ينشئ سنداً وقيداً عكسيين ويعيد المستحق إلى حالته السابقة دون أي حذف مالي.
          </p>
          <Field label="سبب العكس الموثّق" id="rev-reason" required>
            <input id="rev-reason" required value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setReverseTarget(null)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={dangerBtnCls}>تأكيد العكس</button>
          </div>
        </form>
      </Modal>

      <PrintableDocumentModal doc={printDoc} onClose={() => setPrintDoc(null)} />
    </div>
  );
}
