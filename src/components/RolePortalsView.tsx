import React, { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  CheckCircle2,
  Download,
  Gauge,
  Plus,
  Printer,
  Receipt,
  Wrench,
} from 'lucide-react';
import {
  apiFetch,
  downloadCsvExcel,
  formatDateDisplay,
  formatMoney,
  OrganizationInfo,
  STATUS_LABELS,
} from '../lib/api';
import { PrintableDocPayload, PrintableDocumentModal } from './DocumentAndAttachmentModals';
import {
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

export function CollectorPortalView({ org }: { org: OrganizationInfo }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [readingTarget, setReadingTarget] = useState<any>(null);
  const [readingVal, setReadingVal] = useState('');
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [handoverAmt, setHandoverAmt] = useState('');
  const [svcBillOpen, setSvcBillOpen] = useState(false);
  const [svcBillForm, setSvcBillForm] = useState({ serviceId: '', unitId: '', amount: '' });
  const [printDoc, setPrintDoc] = useState<PrintableDocPayload>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/portal/collector');
      setData(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function collectItem(referenceType: string, referenceId: string, amount: string) {
    setError(null);
    try {
      const res = await apiFetch<{ voucherNumber: string }>('/api/portal/collector/collect', {
        method: 'POST',
        idempotencyKey: `col_${referenceId}_${Date.now()}`,
        body: JSON.stringify({ referenceType, referenceId, amount }),
      });
      setSuccess(`تم التحصيل وإصدار سند ${res.voucherNumber} وتحديث صندوق المحصل.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function submitReading(e: React.FormEvent) {
    e.preventDefault();
    if (!readingTarget) return;
    setError(null);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await apiFetch<{ amount: string }>('/api/portal/collector/reading', {
        method: 'POST',
        body: JSON.stringify({
          meterId: readingTarget.id,
          periodStart: today.slice(0, 8) + '01',
          periodEnd: today,
          currentReading: readingVal,
        }),
      });
      setReadingTarget(null);
      setSuccess(`تم تسجيل القراءة وإصدار فاتورة بمبلغ ${formatMoney(res.amount, org.base_currency)}.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function submitHandover(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<{ voucherNumber: string }>('/api/portal/collector/handover', {
        method: 'POST',
        idempotencyKey: `ho_${Date.now()}`,
        body: JSON.stringify({ amount: handoverAmt }),
      });
      setHandoverOpen(false);
      setSuccess(`تم تسليم العهدة إلى الصندوق الرئيسي بسند ${res.voucherNumber}.`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function submitServiceBill(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/portal/collector/create-service-bill', {
        method: 'POST',
        body: JSON.stringify(svcBillForm),
      });
      setSvcBillOpen(false);
      setSvcBillForm({ serviceId: '', unitId: '', amount: '' });
      setSuccess('تم إصدار فاتورة الخدمة للوحدة بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (loading) return <LoadingRows />;

  const showHijri = Boolean(org.show_hijri_dates);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">بوابة المحصل الميداني</h1>
          <p className="text-xs text-slate-500 mt-1">
            العقارات المسندة: {(data?.assignedProperties ?? []).map((p: any) => p.name).join(' · ') || 'لا يوجد'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data?.collector?.flags?.canCreateServices && (
            <button type="button" onClick={() => setSvcBillOpen(true)} className={secondaryBtnCls}>
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>إنشاء فاتورة خدمة</span>
            </button>
          )}
          {data?.cashbox && Number(data.cashbox.balance) > 0 && (
            <button
              type="button"
              onClick={() => {
                setHandoverAmt(data.cashbox.balance);
                setHandoverOpen(true);
              }}
              className={primaryBtnCls}
            >
              <ArrowUpRight className="w-4 h-4" aria-hidden="true" />
              <span>تسليم العهدة للصندوق الرئيسي</span>
            </button>
          )}
        </div>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatTile label="رصيد صندوق المحصل" value={formatMoney(data?.cashbox?.balance ?? 0, org.base_currency)} meta={data?.cashbox?.name} />
        <StatTile label="أقساط متاحة للتحصيل" value={(data?.dueInstallments ?? []).length} meta={data?.collector?.flags?.canCollectRent ? 'صلاحية الإيجار مفعلة' : 'غير مصرح'} />
        <StatTile
          label="خدمات / صيانة للتحصيل"
          value={`${(data?.dueBills ?? []).length} خدمة · ${(data?.dueMaintenance ?? []).length} صيانة`}
          meta={data?.collector?.flags?.canCollectServices ? 'مصرّح' : 'محدود'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="تحصيل الأقساط المستحقة">
          {(data?.dueInstallments ?? []).length === 0 ? (
            <EmptyState title="لا توجد أقساط متاحة" description="إما جميعها مسددة أو لا تملك صلاحية تحصيل الإيجار." />
          ) : (
            <div className="space-y-2.5">
              {data.dueInstallments.map((i: any) => {
                const rem = (Number(i.amount) - Number(i.paid_amount) - Number(i.waived_amount ?? 0)).toFixed(2);
                return (
                  <div key={i.id} className="flex items-center justify-between gap-3 p-3 border border-slate-200 rounded-md">
                    <div>
                      <div className="text-sm font-medium text-slate-900">
                        {i.property_name} · وحدة {i.unit_number} ({i.tenant_name})
                      </div>
                      <div className="text-xs text-slate-500 font-mono flex flex-wrap gap-x-1.5">
                        <span>قسط #{i.installment_number}</span>
                        <span aria-hidden="true">·</span>
                        <span>استحقاق <span dir="ltr" className="whitespace-nowrap inline-block">{i.due_date}</span></span>
                        <span aria-hidden="true">·</span>
                        <span className="whitespace-nowrap">متبقي {formatMoney(rem, org.base_currency)}</span>
                      </div>
                    </div>
                    <button type="button" onClick={() => collectItem('INSTALLMENT', i.id, rem)} className={primaryBtnCls}>
                      <Receipt className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>تحصيل</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="فواتير الخدمات والصيانة والعدادات المسندة">
          <div className="space-y-4">
            {(data?.dueBills ?? []).map((b: any) => {
              const rem = (Number(b.amount) - Number(b.paid_amount)).toFixed(2);
              return (
                <div key={b.id} className="flex items-center justify-between gap-3 p-3 border border-slate-200 rounded-md">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{b.service_name} — وحدة {b.unit_number}</div>
                    <div className="text-xs text-slate-500 font-mono">{b.bill_number} · {b.payer_name} · {formatMoney(rem, org.base_currency)}</div>
                  </div>
                  <button type="button" onClick={() => collectItem('SERVICE_BILL', b.id, rem)} className={secondaryBtnCls}>تحصيل</button>
                </div>
              );
            })}

            {(data?.dueMaintenance ?? []).length > 0 && (
              <div className="pt-2 border-t border-slate-200 space-y-2">
                <div className="text-xs font-semibold text-slate-700">تكاليف صيانة محمّلة على المستأجرين</div>
                {data.dueMaintenance.map((m: any) => {
                  const rem = (Number(m.cost) - Number(m.paid_amount)).toFixed(2);
                  return (
                    <div key={m.id} className="flex items-center justify-between gap-3 p-3 border border-slate-200 rounded-md">
                      <div>
                        <div className="text-sm font-medium text-slate-900">{m.maintenance_type} — {m.property_name} وحدة {m.unit_number}</div>
                        <div className="text-xs text-slate-500 font-mono">{m.description} · متبقي {formatMoney(rem, org.base_currency)}</div>
                      </div>
                      <button type="button" onClick={() => collectItem('MAINTENANCE', m.id, rem)} className={primaryBtnCls}>تحصيل صيانة</button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="pt-3 border-t border-slate-200 space-y-2">
              <div className="text-xs font-semibold text-slate-700">عدادات الوحدات المسندة</div>
              {(data?.meters ?? []).filter((m: any) => m.scope === 'UNIT').map((m: any) => (
                <div key={m.id} className="flex items-center justify-between text-xs py-2 border-b border-slate-100">
                  <span>{m.property_name} · وحدة {m.unit_number} ({m.service_name} · آخر قراءة: {m.last_reading})</span>
                  <button
                    type="button"
                    onClick={() => {
                      setReadingTarget(m);
                      setReadingVal(m.last_reading);
                    }}
                    className={secondaryBtnCls}
                  >
                    <Gauge className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>قراءة</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </Panel>

        <Panel title="سجل سندات المحصل الميداني" className="lg:col-span-2">
          {(data?.recentVouchers ?? []).length === 0 ? (
            <p className="text-xs text-slate-500">لا توجد سندات مصدرة من حسابك بعد.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-right">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 px-2">رقم السند</th>
                    <th className="py-2 px-2">الطرف</th>
                    <th className="py-2 px-2">البيان</th>
                    <th className="py-2 px-2">التاريخ</th>
                    <th className="py-2 px-2">المبلغ</th>
                    <th className="py-2 px-2">طباعة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.recentVouchers.map((v: any) => (
                    <tr key={v.id}>
                      <td className="py-2 px-2 font-mono font-medium">{v.voucher_number}</td>
                      <td className="py-2 px-2">{v.party_name || '—'}</td>
                      <td className="py-2 px-2">{v.description}</td>
                      <td className="py-2 px-2 font-mono">{formatDateDisplay(v.voucher_date, showHijri)}</td>
                      <td className="py-2 px-2 font-mono font-semibold">{formatMoney(v.amount, org.base_currency)}</td>
                      <td className="py-2 px-2">
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      {/* Record Reading Modal */}
      <Modal open={Boolean(readingTarget)} title={`تسجيل قراءة عداد ${readingTarget?.meter_number ?? ''}`} onClose={() => setReadingTarget(null)}>
        <form onSubmit={submitReading} className="space-y-4">
          <Field label="القراءة الحالية" id="col-rdg" required>
            <input id="col-rdg" type="number" step="0.01" required value={readingVal} onChange={(e) => setReadingVal(e.target.value)} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setReadingTarget(null)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ وإصدار الفاتورة</button>
          </div>
        </form>
      </Modal>

      {/* Create Service Bill Modal */}
      <Modal open={svcBillOpen} title="إنشاء فاتورة خدمة ميدانية" onClose={() => setSvcBillOpen(false)}>
        <form onSubmit={submitServiceBill} className="space-y-4">
          <Field label="الوحدة (ضمن العقارات المسندة)" id="csb-unit" required>
            <select id="csb-unit" required value={svcBillForm.unitId} onChange={(e) => setSvcBillForm({ ...svcBillForm, unitId: e.target.value })} className={inputCls}>
              <option value="">اختر الوحدة...</option>
              {(data?.units ?? []).map((u: any) => (
                <option key={u.id} value={u.id}>وحدة {u.unit_number}</option>
              ))}
            </select>
          </Field>
          <Field label="الخدمة" id="csb-svc" required>
            <select id="csb-svc" required value={svcBillForm.serviceId} onChange={(e) => setSvcBillForm({ ...svcBillForm, serviceId: e.target.value })} className={inputCls}>
              <option value="">اختر الخدمة...</option>
              {(data?.services ?? []).map((s: any) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="المبلغ" id="csb-amt" required>
            <input id="csb-amt" type="number" step="0.01" required value={svcBillForm.amount} onChange={(e) => setSvcBillForm({ ...svcBillForm, amount: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setSvcBillOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>إصدار الفاتورة</button>
          </div>
        </form>
      </Modal>

      {/* Handover Modal */}
      <Modal open={handoverOpen} title="تسليم الحصيلة إلى الصندوق الرئيسي" onClose={() => setHandoverOpen(false)}>
        <form onSubmit={submitHandover} className="space-y-4">
          <Field label="المبلغ المسلَّم" id="ho-amt" required>
            <input id="ho-amt" type="number" step="0.01" required value={handoverAmt} onChange={(e) => setHandoverAmt(e.target.value)} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setHandoverOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>تأكيد التحويل</button>
          </div>
        </form>
      </Modal>

      <PrintableDocumentModal doc={printDoc} onClose={() => setPrintDoc(null)} />
    </div>
  );
}

export function RenterPortalView({ org }: { org: OrganizationInfo }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [printDoc, setPrintDoc] = useState<PrintableDocPayload>(null);

  const [reqOpen, setReqOpen] = useState(false);
  const [reqForm, setReqForm] = useState({ agreementId: '', maintenanceType: 'سباكة وكهرباء', description: '', photoBase64: '', photoName: '' });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/portal/renter');
      setData(res);
      if ((res.agreements ?? []).length > 0 && !reqForm.agreementId) {
        setReqForm((f) => ({ ...f, agreementId: res.agreements[0].id }));
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

  async function markRead(recipientId: string) {
    try {
      await apiFetch(`/api/portal/notifications/${recipientId}/read`, { method: 'POST', body: '{}' });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function submitMaintRequest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/portal/renter/maintenance-requests', {
        method: 'POST',
        body: JSON.stringify({
          agreementId: reqForm.agreementId,
          maintenanceType: reqForm.maintenanceType,
          description: reqForm.description,
          photo: reqForm.photoBase64 ? { fileName: reqForm.photoName || 'issue.png', mimeType: 'image/png', dataBase64: reqForm.photoBase64 } : undefined,
        }),
      });
      setReqOpen(false);
      setReqForm({ ...reqForm, description: '', photoBase64: '', photoName: '' });
      setSuccess('تم رفع طلب الصيانة للإدارة بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function exportAccountReport() {
    const rows: Array<Array<string | number>> = [];
    for (const i of data?.installments ?? []) {
      rows.push(['قسط إيجار', `#${i.installment_number} (${i.due_date})`, i.amount, i.paid_amount, i.status]);
    }
    for (const b of data?.bills ?? []) {
      rows.push(['فاتورة خدمة', `${b.service_name} (${b.bill_number})`, b.amount, b.paid_amount, b.status]);
    }
    for (const m of data?.maintenance ?? []) {
      if (m.charge_to === 'TENANT') rows.push(['صيانة محملة عليك', m.description, m.cost, m.paid_amount, m.status]);
    }
    for (const ce of data?.contractExpenses ?? []) {
      rows.push(['رسوم عقد', ce.name, ce.amount, ce.paid_amount, '—']);
    }
    downloadCsvExcel(`renter-statement-${new Date().toISOString().slice(0, 10)}.csv`, ['البند', 'التفاصيل', 'المبلغ', 'المسدد', 'الحالة'], rows);
  }

  if (loading) return <LoadingRows />;

  const activeContract = (data?.agreements ?? [])[0];
  const showHijri = Boolean(org.show_hijri_dates);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">بوابة المستأجر</h1>
          <p className="text-xs text-slate-500 mt-1">عقدك، الأقساط، فواتير الخدمات، طلبات الصيانة، الإيصالات، كشف التسوية، وصور الدخول</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={exportAccountReport} className={secondaryBtnCls}>
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>تقرير ما على حسابي Excel</span>
          </button>
          {activeContract && (
            <button type="button" onClick={() => setReqOpen(true)} className={primaryBtnCls}>
              <Wrench className="w-4 h-4" aria-hidden="true" />
              <span>طلب صيانة جديد</span>
            </button>
          )}
        </div>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} />

      {activeContract && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatTile label="الوحدة والعقار" value={`وحدة ${activeContract.unit_number}`} meta={activeContract.property_name} />
          <StatTile
            label="نهاية العقد"
            value={formatDateDisplay(activeContract.end_date, showHijri)}
            meta={`الحالة: ${STATUS_LABELS[activeContract.status]?.label ?? activeContract.status}`}
          />
          <StatTile label="التأمين المحتجز" value={formatMoney(activeContract.deposit_held ?? 0, org.base_currency)} meta="وديعة قابلة للتسوية" />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="جدول الأقساط والمستحقات">
          <div className="space-y-2 text-sm">
            {(data?.installments ?? []).map((i: any) => (
              <div key={i.id} className="flex items-center justify-between py-2 border-b border-slate-100">
                <span>قسط #{i.installment_number} · استحقاق <span className="font-mono">{formatDateDisplay(i.due_date, showHijri)}</span></span>
                <div className="flex items-center gap-3">
                  <span className="font-mono tabular-nums">{formatMoney(i.amount, org.base_currency)}</span>
                  <StatusText status={i.status} />
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="فواتير المياه والكهرباء والخدمات">
          {(data?.bills ?? []).length === 0 ? (
            <EmptyState title="لا توجد فواتير خدمات" description="ستظهر فواتير الكهرباء والمياه والخدمات المشتركة هنا." />
          ) : (
            <div className="space-y-2 text-sm">
              {data.bills.map((b: any) => (
                <div key={b.id} className="flex items-center justify-between py-2 border-b border-slate-100">
                  <span>{b.service_name} ({b.bill_number})</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono tabular-nums">{formatMoney(b.amount, org.base_currency)}</span>
                    <StatusText status={b.status} />
                    <button
                      type="button"
                      onClick={() => setPrintDoc({ kind: 'BILL', bill: b, currency: org.base_currency, orgName: org.name, showHijri })}
                      className={secondaryBtnCls}
                    >
                      <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="طلبات الصيانة والتكاليف المحمّلة على حسابي">
          <div className="space-y-3 text-xs">
            {(data?.maintenanceRequests ?? []).map((mr: any) => (
              <div key={mr.id} className="p-2.5 border border-slate-200 rounded flex items-center justify-between">
                <div>
                  <div className="font-semibold text-slate-900">{mr.maintenance_type}</div>
                  <div className="text-slate-600">{mr.description}</div>
                </div>
                <StatusText status={mr.status} />
              </div>
            ))}
            {(data?.maintenance ?? []).filter((m: any) => m.charge_to === 'TENANT').map((m: any) => (
              <div key={m.id} className="p-2.5 bg-amber-50/70 border border-amber-200 rounded flex items-center justify-between">
                <span>صيانة محملة عليك: {m.description}</span>
                <span className="font-mono font-semibold">{formatMoney(m.cost, org.base_currency)}</span>
              </div>
            ))}
            {(data?.contractExpenses ?? []).map((ce: any) => (
              <div key={ce.id} className="p-2.5 bg-slate-50 border border-slate-200 rounded flex items-center justify-between">
                <span>رسوم عقد: {ce.name}</span>
                <span className="font-mono font-semibold">{formatMoney(ce.amount, org.base_currency)}</span>
              </div>
            ))}
            {(data?.maintenanceRequests ?? []).length === 0 && (data?.contractExpenses ?? []).length === 0 && (
              <p className="text-slate-500">لا توجد طلبات صيانة أو رسوم إضافية مسجلة.</p>
            )}
          </div>
        </Panel>

        <Panel title="سجل سندات الدفع والإيصالات">
          {(data?.payments ?? []).length === 0 ? (
            <p className="text-xs text-slate-500">لا توجد مدفوعات مسجلة بعد.</p>
          ) : (
            <div className="space-y-2 text-xs">
              {data.payments.map((v: any) => (
                <div key={v.id} className="flex items-center justify-between py-2 border-b border-slate-100">
                  <div>
                    <span className="font-mono font-semibold">{v.voucher_number}</span>
                    <span className="mx-1.5 text-slate-400">·</span>
                    <span>{v.description}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold">{formatMoney(v.amount, org.base_currency)}</span>
                    <button
                      type="button"
                      onClick={() => setPrintDoc({ kind: 'VOUCHER', voucher: v, currency: org.base_currency, orgName: org.name, showHijri })}
                      className={secondaryBtnCls}
                    >
                      <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="الإشعارات الواردة">
          {(data?.notifications ?? []).length === 0 ? (
            <EmptyState title="لا توجد إشعارات" description="ستظهر هنا تنبيهات الإدارة والاستحقاق." />
          ) : (
            <div className="space-y-3">
              {data.notifications.map((n: any) => (
                <div key={n.id} className="p-3 border border-slate-200 rounded-md flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{n.title}</div>
                    <p className="text-xs text-slate-600 mt-1">{n.body}</p>
                  </div>
                  {!n.read_at ? (
                    <button type="button" onClick={() => markRead(n.recipient_id)} className={secondaryBtnCls}>
                      <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>تمت القراءة</span>
                    </button>
                  ) : (
                    <span className="text-xs text-emerald-700 whitespace-nowrap">مقروء</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="صور توثيق الشقة عند الدخول وكشوف التسوية">
          <div className="space-y-4">
            {(data?.entryPhotos ?? []).map((ph: any) => (
              <div key={ph.id} className="border border-slate-200 rounded-md overflow-hidden">
                <img
                  src={`/api/attachments/${ph.id}/content`}
                  alt={ph.file_name}
                  className="w-full h-44 object-cover bg-slate-100"
                  referrerPolicy="no-referrer"
                />
                <div className="px-3 py-2 text-xs text-slate-600">{ph.file_name}</div>
              </div>
            ))}
            {(data?.settlements ?? []).map((s: any) => (
              <div key={s.id} className="p-3 bg-slate-50 border border-slate-200 rounded-md text-xs font-mono">
                كشف تسوية معتمد — الصافي: {formatMoney(s.net_payable, org.base_currency)}
              </div>
            ))}
            {(data?.entryPhotos ?? []).length === 0 && (data?.settlements ?? []).length === 0 && (
              <p className="text-xs text-slate-500">لا توجد صور دخول أو كشوف تسوية بعد.</p>
            )}
          </div>
        </Panel>
      </div>

      {/* Submit Maintenance Request Modal */}
      <Modal open={reqOpen} title="تقديم طلب صيانة للإدارة" onClose={() => setReqOpen(false)}>
        <form onSubmit={submitMaintRequest} className="space-y-4">
          <Field label="العقد / الوحدة" id="rmr-agr" required>
            <select id="rmr-agr" required value={reqForm.agreementId} onChange={(e) => setReqForm({ ...reqForm, agreementId: e.target.value })} className={inputCls}>
              {(data?.agreements ?? []).map((a: any) => (
                <option key={a.id} value={a.id}>{a.property_name} · وحدة {a.unit_number}</option>
              ))}
            </select>
          </Field>
          <Field label="نوع الصيانة" id="rmr-type" required>
            <input id="rmr-type" required value={reqForm.maintenanceType} onChange={(e) => setReqForm({ ...reqForm, maintenanceType: e.target.value })} className={inputCls} />
          </Field>
          <Field label="وصف العطل أو المشكلة" id="rmr-desc" required>
            <textarea id="rmr-desc" rows={3} required value={reqForm.description} onChange={(e) => setReqForm({ ...reqForm, description: e.target.value })} className={inputCls} />
          </Field>
          <Field label="صورة توضيحية (اختياري)" id="rmr-photo">
            <input
              id="rmr-photo"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => setReqForm((f) => ({ ...f, photoBase64: String(reader.result || ''), photoName: file.name }));
                reader.readAsDataURL(file);
              }}
              className="text-xs text-slate-600"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setReqOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>إرسال الطلب</button>
          </div>
        </form>
      </Modal>

      <PrintableDocumentModal doc={printDoc} onClose={() => setPrintDoc(null)} />
    </div>
  );
}

export function UnitOwnerPortalView({ org }: { org: OrganizationInfo }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [printDoc, setPrintDoc] = useState<PrintableDocPayload>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/portal/unit-owner');
      setData(res);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function markRead(recipientId: string) {
    await apiFetch(`/api/portal/notifications/${recipientId}/read`, { method: 'POST', body: '{}' });
    await load();
  }

  if (loading) return <LoadingRows />;

  const showHijri = Boolean(org.show_hijri_dates);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">بوابة مالك وحدة التمليك</h1>
          <p className="text-xs text-slate-500 mt-1">فواتير الخدمات والتكاليف المشتركة والإشعارات الخاصة بوحدتك فقط</p>
        </div>
        <button
          type="button"
          onClick={() =>
            downloadCsvExcel(
              `unit-owner-bills-${new Date().toISOString().slice(0, 10)}.csv`,
              ['رقم الفاتورة', 'الخدمة', 'الفترة', 'المبلغ', 'المسدد', 'الحالة'],
              (data?.bills ?? []).map((b: any) => [b.bill_number, b.service_name, `${b.period_start}..${b.period_end}`, b.amount, b.paid_amount, b.status]),
            )
          }
          className={secondaryBtnCls}
        >
          <Download className="w-4 h-4" aria-hidden="true" />
          <span>تصدير Excel</span>
        </button>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel title="وحداتي المملوكة وفواتير الخدمات">
          <div className="space-y-3 mb-4">
            {(data?.ownedUnits ?? []).map((u: any) => (
              <div key={u.id} className="p-3 bg-slate-50 border border-slate-200 rounded-md text-sm">
                <span className="font-semibold">{u.property_name}</span> · وحدة {u.unit_number} ({u.unit_type} · {u.area_sqm} م²)
              </div>
            ))}
          </div>
          {(data?.bills ?? []).length === 0 ? (
            <EmptyState title="لا توجد فواتير خدمات" description="ستظهر هنا فواتير الخدمات الخاصة بوحدتك." />
          ) : (
            <div className="space-y-2 text-sm">
              {data.bills.map((b: any) => (
                <div key={b.id} className="flex items-center justify-between py-2 border-b border-slate-100">
                  <span>{b.service_name} ({b.bill_number})</span>
                  <div className="flex items-center gap-2">
                    <span className="font-mono tabular-nums">{formatMoney(b.amount, org.base_currency)}</span>
                    <StatusText status={b.status} />
                    <button
                      type="button"
                      onClick={() => setPrintDoc({ kind: 'BILL', bill: b, currency: org.base_currency, orgName: org.name, showHijri })}
                      className={secondaryBtnCls}
                    >
                      <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="الإشعارات الخاصة بالوحدة">
          {(data?.notifications ?? []).length === 0 ? (
            <EmptyState title="لا توجد إشعارات" description="لا توجد إشعارات حالياً." />
          ) : (
            <div className="space-y-3">
              {data.notifications.map((n: any) => (
                <div key={n.id} className="p-3 border border-slate-200 rounded-md flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">{n.title}</div>
                    <p className="text-xs text-slate-600 mt-1">{n.body}</p>
                  </div>
                  {!n.read_at ? (
                    <button type="button" onClick={() => markRead(n.recipient_id)} className={secondaryBtnCls}>تمت القراءة</button>
                  ) : (
                    <span className="text-xs text-emerald-700">مقروء</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <PrintableDocumentModal doc={printDoc} onClose={() => setPrintDoc(null)} />
    </div>
  );
}
