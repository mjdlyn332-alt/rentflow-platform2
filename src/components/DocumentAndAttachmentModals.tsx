import React, { useEffect, useState } from 'react';
import { ExternalLink, FileText, Paperclip, Printer, Upload } from 'lucide-react';
import {
  apiFetch,
  ATTACHMENT_TYPE_LABELS,
  formatDateDisplay,
  formatMoney,
  REFERENCE_TYPE_LABELS,
  STATUS_LABELS,
  VOUCHER_TYPE_LABELS,
} from '../lib/api';
import { ErrorBanner, Field, inputCls, Modal, primaryBtnCls, secondaryBtnCls, SuccessBanner } from './UiPrimitives';

export type PrintableDocPayload =
  | { kind: 'VOUCHER'; voucher: any; currency?: string; orgName?: string; showHijri?: boolean }
  | { kind: 'BILL'; bill: any; currency?: string; orgName?: string; showHijri?: boolean }
  | { kind: 'CONTRACT'; contractId: string }
  | { kind: 'SETTLEMENT'; eviction: any; currency?: string; orgName?: string; showHijri?: boolean }
  | null;

export function PrintableDocumentModal({
  doc,
  onClose,
}: {
  doc: PrintableDocPayload;
  onClose: () => void;
}) {
  const [contractDoc, setContractDoc] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (doc?.kind === 'CONTRACT') {
      setLoading(true);
      setErr(null);
      apiFetch(`/api/contracts/${doc.contractId}/document`)
        .then(setContractDoc)
        .catch((e: any) => setErr(e.message))
        .finally(() => setLoading(false));
    } else {
      setContractDoc(null);
    }
  }, [doc]);

  if (!doc) return null;

  const title =
    doc.kind === 'VOUCHER'
      ? `${VOUCHER_TYPE_LABELS[doc.voucher.voucher_type] ?? 'سند'} #${doc.voucher.voucher_number}`
      : doc.kind === 'BILL'
        ? `فاتورة خدمة #${doc.bill.bill_number}`
        : doc.kind === 'CONTRACT'
          ? 'مستند عقد الإيجار والجدول الزمني'
          : 'بيان تسوية الإخلاء والتأمين النهائي';

  return (
    <Modal open={Boolean(doc)} title={title} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2 no-print border-b border-slate-200 pb-3">
          <span className="text-xs text-slate-500">نسخة جاهزة للطباعة أو الحفظ بصيغة PDF عبر المتصفح</span>
          <button type="button" onClick={() => window.print()} className={primaryBtnCls}>
            <Printer className="w-4 h-4" aria-hidden="true" />
            <span>طباعة المستند</span>
          </button>
        </div>

        <ErrorBanner message={err} onDismiss={() => setErr(null)} />

        <div className="print-sheet border border-slate-200 rounded-md p-6 bg-white space-y-5 text-sm text-slate-900">
          {doc.kind === 'VOUCHER' && (
            <>
              <div className="flex items-start justify-between border-b border-slate-200 pb-4">
                <div>
                  <h4 className="text-lg font-bold text-slate-900">{doc.orgName || 'منظومة مِلاك لإدارة العقارات'}</h4>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {VOUCHER_TYPE_LABELS[doc.voucher.voucher_type] ?? doc.voucher.voucher_type}
                  </p>
                </div>
                <div className="text-left font-mono">
                  <div className="text-base font-bold">{doc.voucher.voucher_number}</div>
                  <div className="text-xs text-slate-500">{formatDateDisplay(doc.voucher.voucher_date, doc.showHijri)}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-md border border-slate-200">
                <div>
                  <span className="text-xs text-slate-500 block">الطرف / المستفيد</span>
                  <span className="font-semibold">{doc.voucher.party_name || '—'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-500 block">العقار / الصندوق</span>
                  <span className="font-semibold">{doc.voucher.property_name || doc.voucher.cashbox_name || '—'}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-500 block">بند السند</span>
                  <span className="font-semibold">{REFERENCE_TYPE_LABELS[doc.voucher.reference_type] ?? doc.voucher.reference_type}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-500 block">الحالة</span>
                  <span className="font-semibold">{STATUS_LABELS[doc.voucher.status]?.label ?? doc.voucher.status}</span>
                </div>
              </div>

              <div className="flex items-center justify-between p-4 border-2 border-slate-800 rounded-md">
                <span className="font-semibold">المبلغ الإجمالي</span>
                <span className="text-xl font-bold font-mono tabular-nums">
                  {formatMoney(doc.voucher.amount, doc.currency || 'SAR')}
                </span>
              </div>

              {doc.voucher.description && (
                <div className="text-xs text-slate-700">
                  <span className="font-semibold">البيان: </span>
                  {doc.voucher.description}
                </div>
              )}

              <div className="grid grid-cols-2 gap-8 pt-6 text-xs text-slate-500">
                <div className="border-t border-slate-300 pt-2">توقيع أمين الصندوق / المحصّل</div>
                <div className="border-t border-slate-300 pt-2">توقيع المستلم / الدافع</div>
              </div>
            </>
          )}

          {doc.kind === 'BILL' && (
            <>
              <div className="flex items-start justify-between border-b border-slate-200 pb-4">
                <div>
                  <h4 className="text-lg font-bold">{doc.orgName || 'منظومة مِلاك لإدارة العقارات'}</h4>
                  <p className="text-xs text-slate-500">فاتورة استهلاك / خدمة عقارية</p>
                </div>
                <div className="text-left font-mono">
                  <div className="text-base font-bold">{doc.bill.bill_number}</div>
                  <div className="text-xs text-slate-500">الاستحقاق: {formatDateDisplay(doc.bill.due_date, doc.showHijri)}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-md border border-slate-200">
                <div>
                  <span className="text-xs text-slate-500 block">الخدمة</span>
                  <span className="font-semibold">{doc.bill.service_name}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-500 block">العقار والوحدة</span>
                  <span className="font-semibold">
                    {doc.bill.property_name || '—'} · وحدة {doc.bill.unit_number}
                  </span>
                </div>
                <div>
                  <span className="text-xs text-slate-500 block">المكلف بالسداد</span>
                  <span className="font-semibold">{doc.bill.payer_name || doc.bill.payer_role}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-500 block">الفترة</span>
                  <span className="font-mono text-xs">
                    {doc.bill.period_start} إلى {doc.bill.period_end}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="border border-slate-200 rounded p-3">
                  <span className="text-xs text-slate-500 block">مبلغ الفاتورة</span>
                  <span className="font-bold font-mono">{formatMoney(doc.bill.amount, doc.currency)}</span>
                </div>
                <div className="border border-slate-200 rounded p-3">
                  <span className="text-xs text-slate-500 block">المسدد</span>
                  <span className="font-bold font-mono text-emerald-700">{formatMoney(doc.bill.paid_amount, doc.currency)}</span>
                </div>
                <div className="border border-slate-200 rounded p-3">
                  <span className="text-xs text-slate-500 block">المتبقي</span>
                  <span className="font-bold font-mono text-red-700">
                    {formatMoney(Number(doc.bill.amount) - Number(doc.bill.paid_amount), doc.currency)}
                  </span>
                </div>
              </div>
            </>
          )}

          {doc.kind === 'CONTRACT' && (
            <>
              {loading ? (
                <p className="text-xs text-slate-500">جاري تجهيز نص العقد...</p>
              ) : contractDoc ? (
                <div className="space-y-4">
                  <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-900 bg-slate-50/50 p-4 border border-slate-200 rounded-md">
                    {contractDoc.renderedText}
                  </pre>

                  {Array.isArray(contractDoc.expenseItems) && contractDoc.expenseItems.length > 0 && (
                    <div>
                      <h5 className="text-xs font-semibold text-slate-700 mb-2">الرسوم والضرائب الإضافية على العقد</h5>
                      <table className="w-full text-xs border-collapse border border-slate-200">
                        <thead>
                          <tr className="bg-slate-50">
                            <th className="p-2 border border-slate-200 text-right">البند</th>
                            <th className="p-2 border border-slate-200 text-right">المحمّل عليه</th>
                            <th className="p-2 border border-slate-200 text-right">المبلغ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {contractDoc.expenseItems.map((ei: any) => (
                            <tr key={ei.id}>
                              <td className="p-2 border border-slate-200">{ei.name}</td>
                              <td className="p-2 border border-slate-200">{ei.charge_to === 'TENANT' ? 'المستأجر' : 'المالك'}</td>
                              <td className="p-2 border border-slate-200 font-mono">{formatMoney(ei.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {Array.isArray(contractDoc.installments) && contractDoc.installments.length > 0 && (
                    <div>
                      <h5 className="text-xs font-semibold text-slate-700 mb-2">جدول الأقساط التعاقدية</h5>
                      <table className="w-full text-xs border-collapse border border-slate-200">
                        <thead>
                          <tr className="bg-slate-50">
                            <th className="p-2 border border-slate-200 text-right">#</th>
                            <th className="p-2 border border-slate-200 text-right">من</th>
                            <th className="p-2 border border-slate-200 text-right">إلى</th>
                            <th className="p-2 border border-slate-200 text-right">تاريخ الاستحقاق</th>
                            <th className="p-2 border border-slate-200 text-right">المبلغ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {contractDoc.installments.map((i: any) => (
                            <tr key={i.id}>
                              <td className="p-2 border border-slate-200 font-mono">{i.installment_number}</td>
                              <td className="p-2 border border-slate-200 font-mono">{i.period_start}</td>
                              <td className="p-2 border border-slate-200 font-mono">{i.period_end}</td>
                              <td className="p-2 border border-slate-200 font-mono">{i.due_date}</td>
                              <td className="p-2 border border-slate-200 font-mono">{formatMoney(i.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-8 pt-6 text-xs text-slate-500">
                    <div className="border-t border-slate-300 pt-2">توقيع الطرف الأول (المؤجّر)</div>
                    <div className="border-t border-slate-300 pt-2">توقيع الطرف الثاني (المستأجر)</div>
                  </div>
                </div>
              ) : null}
            </>
          )}

          {doc.kind === 'SETTLEMENT' && doc.eviction.settlement && (
            <>
              <div className="flex items-start justify-between border-b border-slate-200 pb-4">
                <div>
                  <h4 className="text-lg font-bold">{doc.orgName || 'منظومة مِلاك لإدارة العقارات'}</h4>
                  <p className="text-xs text-slate-500">بيان التسوية النهائية عند الإخلاء وتسليم الوحدة</p>
                </div>
                <div className="text-left font-mono text-xs">
                  <div>تاريخ التسليم: {formatDateDisplay(doc.eviction.handover_date, doc.showHijri)}</div>
                  <div>الحالة: {STATUS_LABELS[doc.eviction.settlement.status]?.label ?? doc.eviction.settlement.status}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3 rounded border border-slate-200 text-xs">
                <div>العقار والوحدة: {doc.eviction.property_name} · وحدة {doc.eviction.unit_number}</div>
                <div>المستأجر: {doc.eviction.tenant_name}</div>
              </div>

              <table className="w-full text-xs border-collapse border border-slate-200">
                <tbody>
                  <tr>
                    <td className="p-2.5 border border-slate-200 font-medium">(+) رصيد التأمين المحتجز</td>
                    <td className="p-2.5 border border-slate-200 font-mono text-emerald-700">{formatMoney(doc.eviction.settlement.held_deposit, doc.currency)}</td>
                  </tr>
                  <tr>
                    <td className="p-2.5 border border-slate-200 font-medium">(+) رصيد الإيجار المقدم غير المستهلك</td>
                    <td className="p-2.5 border border-slate-200 font-mono text-emerald-700">{formatMoney(doc.eviction.settlement.advance_rent_credit, doc.currency)}</td>
                  </tr>
                  <tr>
                    <td className="p-2.5 border border-slate-200 font-medium">(-) أضرار وتلفيات فحص الخروج</td>
                    <td className="p-2.5 border border-slate-200 font-mono text-red-700">{formatMoney(doc.eviction.settlement.damages_total, doc.currency)}</td>
                  </tr>
                  <tr>
                    <td className="p-2.5 border border-slate-200 font-medium">(-) ذمم إيجار سابقة مستحقة</td>
                    <td className="p-2.5 border border-slate-200 font-mono text-red-700">{formatMoney(doc.eviction.settlement.unpaid_rent_total, doc.currency)}</td>
                  </tr>
                  <tr>
                    <td className="p-2.5 border border-slate-200 font-medium">(-) فواتير خدمات غير مسددة</td>
                    <td className="p-2.5 border border-slate-200 font-mono text-red-700">{formatMoney(doc.eviction.settlement.unpaid_services_total, doc.currency)}</td>
                  </tr>
                  <tr className="bg-slate-100 font-bold">
                    <td className="p-3 border border-slate-300">
                      صافي التسوية ({Number(doc.eviction.settlement.net_payable) >= 0 ? 'يُرد للمستأجر' : 'مطلوب تحصيله من المستأجر'})
                    </td>
                    <td className="p-3 border border-slate-300 font-mono text-base">
                      {formatMoney(Math.abs(Number(doc.eviction.settlement.net_payable)), doc.currency)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function AttachmentsModal({
  target,
  defaultType = 'OTHER',
  allowedTypes,
  readOnly = false,
  onClose,
  onUploaded,
}: {
  target: { entityType: string; entityId: string; label: string } | null;
  defaultType?: string;
  allowedTypes?: string[];
  readOnly?: boolean;
  onClose: () => void;
  onUploaded?: () => void;
}) {
  const [items, setItems] = useState<any[]>([]);
  const [attType, setAttType] = useState(defaultType);
  const [fileName, setFileName] = useState('');
  const [mimeType, setMimeType] = useState('image/png');
  const [dataBase64, setDataBase64] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setAttType(defaultType);
    if (!target) return;
    setLoading(true);
    setErr(null);
    apiFetch<{ attachments: any[] }>(
      `/api/attachments?entityType=${encodeURIComponent(target.entityType)}&entityId=${encodeURIComponent(target.entityId)}`,
    )
      .then((res) => setItems(res.attachments ?? []))
      .catch((e: any) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [target, defaultType]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    setMimeType(f.type || 'image/png');
    const reader = new FileReader();
    reader.onload = () => {
      setDataBase64(String(reader.result || ''));
    };
    reader.readAsDataURL(f);
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!target || !fileName || !dataBase64) return;
    setErr(null);
    setMsg(null);
    try {
      await apiFetch('/api/attachments', {
        method: 'POST',
        body: JSON.stringify({
          attachmentType: attType,
          fileName,
          mimeType,
          dataBase64,
          entityType: target.entityType,
          entityId: target.entityId,
        }),
      });
      setFileName('');
      setDataBase64('');
      setMsg('تم رفع المرفق وحفظه بنجاح.');
      const res = await apiFetch<{ attachments: any[] }>(
        `/api/attachments?entityType=${encodeURIComponent(target.entityType)}&entityId=${encodeURIComponent(target.entityId)}`,
      );
      setItems(res.attachments ?? []);
      onUploaded?.();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function openSignedPreview(id: string) {
    try {
      const res = await apiFetch<{ url: string }>(`/api/attachments/${id}/signed-url`);
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const typeOptions = allowedTypes ?? Object.keys(ATTACHMENT_TYPE_LABELS);

  return (
    <Modal open={Boolean(target)} title={`مرفقات: ${target?.label || ''}`} onClose={onClose} wide>
      <div className="space-y-4">
        <ErrorBanner message={err} onDismiss={() => setErr(null)} />
        <SuccessBanner message={msg} onDismiss={() => setMsg(null)} />

        {!readOnly && (
          <form onSubmit={handleUpload} className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="تصنيف المرفق" id="att-type">
                <select
                  id="att-type"
                  value={attType}
                  onChange={(e) => setAttType(e.target.value)}
                  className={inputCls}
                >
                  {typeOptions.map((t) => (
                    <option key={t} value={t}>
                      {ATTACHMENT_TYPE_LABELS[t] ?? t}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="اختيار ملف (صورة أو PDF حتى 5MB)" id="att-file" required>
                <input
                  id="att-file"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,application/pdf"
                  onChange={handleFileChange}
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="flex justify-end">
              <button type="submit" disabled={!dataBase64} className={primaryBtnCls}>
                <Upload className="w-4 h-4" aria-hidden="true" />
                <span>رفع المرفق</span>
              </button>
            </div>
          </form>
        )}

        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-slate-700">المرفقات المحفوظة</h4>
          {loading ? (
            <p className="text-xs text-slate-500">جاري التحميل...</p>
          ) : items.length === 0 ? (
            <p className="text-xs text-slate-500">لا توجد مرفقات مسجلة لهذا السجل.</p>
          ) : (
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
              {items.map((it) => (
                <div key={it.id} className="p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Paperclip className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                    <span className="font-medium text-slate-900">{it.file_name}</span>
                    <span className="text-slate-500">· {ATTACHMENT_TYPE_LABELS[it.attachment_type] ?? it.attachment_type}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-slate-400">{Math.round((it.size_bytes || 0) / 1024)} KB</span>
                    <button
                      type="button"
                      onClick={() => openSignedPreview(it.id)}
                      className={secondaryBtnCls}
                    >
                      <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>معاينة (رابط موقّع)</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
