import React, { useEffect, useState } from 'react';
import { Download, Edit3, FilePlus2, FileText, GitMerge, History, Paperclip, Plus, Printer, RefreshCw, UserPlus } from 'lucide-react';
import { apiFetch, downloadCsvExcel, formatDateDisplay, formatMoney, OrganizationInfo } from '../lib/api';
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

const PARTY_ROLE_AR: Record<string, string> = {
  OWNER: 'مالك عقار',
  RENTER: 'مستأجر',
  UNIT_OWNER: 'مالك وحدة تمليك',
};

export function PartiesView({ org }: { org: OrganizationInfo }) {
  const [parties, setParties] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<any>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeForm, setMergeForm] = useState({ sourcePartyId: '', targetPartyId: '' });
  const [attTarget, setAttTarget] = useState<{ entityType: string; entityId: string; label: string } | null>(null);
  const [form, setForm] = useState({
    name: '',
    nationalId: '',
    phone: '',
    email: '',
    emergencyPhone: '',
    notes: '',
    roles: ['RENTER'] as string[],
  });

  const [historyData, setHistoryData] = useState<any>(null);
  const [statementData, setStatementData] = useState<any>(null);
  const [historyTab, setHistoryTab] = useState<'overview' | 'notifications' | 'statement'>('overview');
  const [portalTarget, setPortalTarget] = useState<any>(null);
  const [portalForm, setPortalForm] = useState({ email: '', password: '', role: 'RENTER' });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/parties');
      setParties(res.parties);
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
      await apiFetch('/api/parties', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setCreateOpen(false);
      setForm({ name: '', nationalId: '', phone: '', email: '', emergencyPhone: '', notes: '', roles: ['RENTER'] });
      setSuccess('تم تسجيل الطرف بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleUpdateParty(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/parties/${editTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify(form),
      });
      setEditTarget(null);
      setSuccess('تم تحديث بيانات الطرف.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleMerge(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/parties/merge', {
        method: 'POST',
        body: JSON.stringify(mergeForm),
      });
      setMergeOpen(false);
      setSuccess('تم دمج سجل الطرفين وتوحيد عقودهم وقيودهم بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function openHistory(partyId: string) {
    try {
      const [hRes, sRes] = await Promise.all([
        apiFetch(`/api/parties/${partyId}/history`),
        apiFetch(`/api/parties/${partyId}/statement`),
      ]);
      setHistoryData(hRes);
      setStatementData(sRes);
      setHistoryTab('overview');
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleCreatePortal(e: React.FormEvent) {
    e.preventDefault();
    if (!portalTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/parties/${portalTarget.id}/portal-account`, {
        method: 'POST',
        body: JSON.stringify(portalForm),
      });
      setPortalTarget(null);
      setSuccess('تم إنشاء حساب البوابة للطرف بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function toggleRole(r: string) {
    setForm((prev) => ({
      ...prev,
      roles: prev.roles.includes(r) ? prev.roles.filter((x) => x !== r) : [...prev.roles, r],
    }));
  }

  const duplicateWarn = form.nationalId.trim()
    ? parties.find((p) => p.national_id === form.nationalId.trim() && p.id !== editTarget?.id)
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">الأطراف (الملاك والمستأجرون ومالكو الوحدات)</h1>
          <p className="text-xs text-slate-500 mt-1">
            طرف موحّد بأدوار متعددة مع منع تكرار رقم الهوية، دمج السجلات، وكشف حساب تفصيلي من الدفتر العام
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setMergeOpen(true)} className={secondaryBtnCls}>
            <GitMerge className="w-4 h-4" aria-hidden="true" />
            <span>دمج طرفين</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setEditTarget(null);
              setForm({ name: '', nationalId: '', phone: '', email: '', emergencyPhone: '', notes: '', roles: ['RENTER'] });
              setCreateOpen(true);
            }}
            className={primaryBtnCls}
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>إضافة طرف جديد</span>
          </button>
        </div>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} />

      {loading ? (
        <LoadingRows />
      ) : parties.length === 0 ? (
        <EmptyState title="لا توجد أطراف مسجلة" description="أضف ملاك العقارات والمستأجرين ومالكي وحدات التمليك." />
      ) : (
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-2.5 px-3 font-medium">الاسم</th>
                  <th className="py-2.5 px-3 font-medium">الأدوار</th>
                  <th className="py-2.5 px-3 font-medium">الهوية / الجوال</th>
                  <th className="py-2.5 px-3 font-medium">حساب البوابة</th>
                  <th className="py-2.5 px-3 font-medium">الرصيد (الذمم)</th>
                  <th className="py-2.5 px-3 font-medium">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {parties.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/70">
                    <td className="py-3 px-3 font-medium text-slate-900">{p.name}</td>
                    <td className="py-3 px-3 text-xs text-slate-600">
                      {(p.roles as string[]).map((r) => PARTY_ROLE_AR[r] ?? r).join(' · ')}
                    </td>
                    <td className="py-3 px-3 font-mono text-xs text-slate-600">
                      {p.national_id || '—'} · {p.phone || '—'}
                    </td>
                    <td className="py-3 px-3 text-xs">
                      {p.portalUser ? (
                        <span className="font-mono text-emerald-700" dir="ltr">
                          {p.portalUser.email}
                        </span>
                      ) : (
                        <span className="text-slate-400">غير مفعّل</span>
                      )}
                    </td>
                    <td className="py-3 px-3 font-mono tabular-nums font-medium">
                      {formatMoney(p.receivableBalance, org.base_currency)}
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" onClick={() => openHistory(p.id)} className={secondaryBtnCls}>
                          <History className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>السجل وكشف الحساب</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditTarget(p);
                            setForm({
                              name: p.name,
                              nationalId: p.national_id || '',
                              phone: p.phone || '',
                              email: p.email || '',
                              emergencyPhone: p.emergency_phone || '',
                              notes: p.notes || '',
                              roles: p.roles ?? ['RENTER'],
                            });
                          }}
                          className={secondaryBtnCls}
                        >
                          <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>تعديل</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setAttTarget({ entityType: 'PARTY', entityId: p.id, label: p.name })}
                          className={secondaryBtnCls}
                        >
                          <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>الهوية</span>
                        </button>
                        {!p.portalUser && (
                          <button
                            type="button"
                            onClick={() => {
                              setPortalTarget(p);
                              setPortalForm({
                                email: p.email || '',
                                password: '',
                                role: p.roles.includes('UNIT_OWNER') ? 'UNIT_OWNER' : 'RENTER',
                              });
                            }}
                            className={secondaryBtnCls}
                          >
                            <UserPlus className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>حساب بوابة</span>
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
      )}

      <Modal
        open={createOpen || Boolean(editTarget)}
        title={editTarget ? `تعديل بيانات الطرف: ${editTarget.name}` : 'إضافة طرف جديد'}
        onClose={() => {
          setCreateOpen(false);
          setEditTarget(null);
        }}
      >
        <form onSubmit={editTarget ? handleUpdateParty : handleCreate} className="space-y-4">
          {duplicateWarn && (
            <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-800 rounded text-xs">
              تنبيه: رقم الهوية مسجل مسبقاً باسم ({duplicateWarn.name}). يمكنك إضافته بدور إضافي أو استخدام دمج الأطراف.
            </div>
          )}
          <Field label="الاسم الكامل" id="pty-name" required>
            <input id="pty-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
          </Field>
          <div>
            <span className="text-xs font-medium text-slate-700 block mb-1.5">الأدوار</span>
            <div className="flex flex-wrap gap-3">
              {(['RENTER', 'OWNER', 'UNIT_OWNER'] as const).map((r) => (
                <label key={r} className="inline-flex items-center gap-1.5 text-sm text-slate-700">
                  <input type="checkbox" checked={form.roles.includes(r)} onChange={() => toggleRole(r)} />
                  <span>{PARTY_ROLE_AR[r]}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="رقم الهوية" id="pty-nid" required={form.roles.includes('RENTER')}>
              <input id="pty-nid" value={form.nationalId} onChange={(e) => setForm({ ...form, nationalId: e.target.value })} className={inputCls} />
            </Field>
            <Field label="رقم الهاتف" id="pty-phone" required={form.roles.includes('RENTER')}>
              <input id="pty-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="البريد الإلكتروني" id="pty-email">
              <input id="pty-email" type="email" dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputCls} />
            </Field>
            <Field label="هاتف الطوارئ" id="pty-emg">
              <input id="pty-emg" value={form.emergencyPhone} onChange={(e) => setForm({ ...form, emergencyPhone: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <Field label="ملاحظات" id="pty-notes">
            <input id="pty-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setCreateOpen(false);
                setEditTarget(null);
              }}
              className={secondaryBtnCls}
            >
              إلغاء
            </button>
            <button type="submit" className={primaryBtnCls}>
              حفظ الطرف
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={mergeOpen} title="دمج سجلين لطرف واحد (FR-PTY-03)" onClose={() => setMergeOpen(false)}>
        <form onSubmit={handleMerge} className="space-y-4">
          <p className="text-xs text-slate-600">
            يُرحَّل سجل الطرف المصدر (العقود، السندات، الفواتير، والقيود المحاسبية) إلى الطرف الهدف ويُؤرشف المصدر بأمان.
          </p>
          <Field label="الطرف المصدر (يُدمج ويُؤرشف)" id="mrg-src" required>
            <select id="mrg-src" required value={mergeForm.sourcePartyId} onChange={(e) => setMergeForm({ ...mergeForm, sourcePartyId: e.target.value })} className={inputCls}>
              <option value="">اختر الطرف المصدر...</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.national_id || p.phone || '—'})
                </option>
              ))}
            </select>
          </Field>
          <Field label="الطرف الهدف (السجل المعتمد)" id="mrg-tgt" required>
            <select id="mrg-tgt" required value={mergeForm.targetPartyId} onChange={(e) => setMergeForm({ ...mergeForm, targetPartyId: e.target.value })} className={inputCls}>
              <option value="">اختر الطرف الهدف...</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.national_id || p.phone || '—'})
                </option>
              ))}
            </select>
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setMergeOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>تنفيذ الدمج</button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(portalTarget)} title={`إنشاء حساب بوابة لـ ${portalTarget?.name ?? ''}`} onClose={() => setPortalTarget(null)}>
        <form onSubmit={handleCreatePortal} className="space-y-4">
          <Field label="الدور" id="portal-role">
            <select id="portal-role" value={portalForm.role} onChange={(e) => setPortalForm({ ...portalForm, role: e.target.value })} className={inputCls}>
              <option value="RENTER">بوابة المستأجر</option>
              <option value="UNIT_OWNER">بوابة مالك وحدة التمليك</option>
            </select>
          </Field>
          <Field label="البريد الإلكتروني" id="portal-email" required>
            <input id="portal-email" type="email" required dir="ltr" value={portalForm.email} onChange={(e) => setPortalForm({ ...portalForm, email: e.target.value })} className={inputCls} />
          </Field>
          <Field label="كلمة المرور (12 حرفاً فأكثر)" id="portal-pass" required>
            <input id="portal-pass" type="password" minLength={12} required dir="ltr" value={portalForm.password} onChange={(e) => setPortalForm({ ...portalForm, password: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setPortalTarget(null)} className={secondaryBtnCls}>
              إلغاء
            </button>
            <button type="submit" className={primaryBtnCls}>
              إنشاء الحساب
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(historyData)} title={`سجل الطرف وكشف الحساب: ${historyData?.party?.name ?? ''}`} onClose={() => setHistoryData(null)} wide>
        {historyData && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
              <div className="flex gap-1 bg-slate-100 p-1 rounded-md text-xs">
                <button type="button" onClick={() => setHistoryTab('overview')} className={`px-3 py-1 rounded ${historyTab === 'overview' ? 'bg-white font-semibold' : ''}`}>
                  العقود والسندات ({historyData.contracts.length})
                </button>
                <button type="button" onClick={() => setHistoryTab('notifications')} className={`px-3 py-1 rounded ${historyTab === 'notifications' ? 'bg-white font-semibold' : ''}`}>
                  الإشعارات ({(historyData.notifications ?? []).length})
                </button>
                <button type="button" onClick={() => setHistoryTab('statement')} className={`px-3 py-1 rounded ${historyTab === 'statement' ? 'bg-white font-semibold' : ''}`}>
                  كشف الحساب الدفتري
                </button>
              </div>
              {historyTab === 'statement' && statementData?.statement && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      downloadCsvExcel(
                        `statement_${historyData.party.name}`,
                        ['التاريخ', 'رقم القيد', 'البيان', 'مدين', 'دائن', 'الرصيد التراكمي'],
                        statementData.statement.lines.map((l: any) => [l.date, l.entryNumber, l.description, l.debit, l.credit, l.runningBalance]),
                      )
                    }
                    className={secondaryBtnCls}
                  >
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>تصدير Excel/CSV</span>
                  </button>
                  <button type="button" onClick={() => window.print()} className={secondaryBtnCls}>
                    <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>طباعة الكشف</span>
                  </button>
                </div>
              )}
            </div>

            {historyTab === 'overview' && (
              <div className="space-y-4">
                <div>
                  <h4 className="font-semibold text-slate-900 mb-2">العقود ({historyData.contracts.length})</h4>
                  {historyData.contracts.map((c: any) => (
                    <div key={c.id} className="py-1.5 border-b border-slate-100 flex justify-between">
                      <span>
                        {c.property_name} · وحدة {c.unit_number} ({c.start_date} ← {c.end_date})
                      </span>
                      <StatusText status={c.status} />
                    </div>
                  ))}
                </div>
                <div>
                  <h4 className="font-semibold text-slate-900 mb-2">السندات المالية ({historyData.vouchers.length})</h4>
                  {historyData.vouchers.map((v: any) => (
                    <div key={v.id} className="py-1.5 border-b border-slate-100 flex justify-between font-mono text-xs">
                      <span>
                        {v.voucher_number} · {v.description}
                      </span>
                      <span>{formatMoney(v.amount, org.base_currency)}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <h4 className="font-semibold text-slate-900 mb-2">فواتير الخدمات ({historyData.bills.length})</h4>
                  {historyData.bills.map((b: any) => (
                    <div key={b.id} className="py-1.5 border-b border-slate-100 flex justify-between text-xs">
                      <span>
                        {b.bill_number} · {b.service_name}
                      </span>
                      <span className="font-mono">{formatMoney(b.amount, org.base_currency)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {historyTab === 'notifications' && (
              <div className="space-y-2">
                {(historyData.notifications ?? []).length === 0 ? (
                  <p className="text-xs text-slate-500">لا توجد إشعارات مرسلة لهذا الطرف.</p>
                ) : (
                  historyData.notifications.map((n: any, idx: number) => (
                    <div key={idx} className="p-3 border border-slate-200 rounded-md">
                      <div className="flex justify-between text-xs font-semibold">
                        <span>{n.title}</span>
                        <span className="font-mono text-slate-500">{n.created_at?.slice(0, 10)}</span>
                      </div>
                      <p className="text-xs text-slate-600 mt-1">{n.body}</p>
                    </div>
                  ))
                )}
              </div>
            )}

            {historyTab === 'statement' && statementData?.statement && (
              <div className="print-sheet space-y-3">
                <div className="flex justify-between items-center text-xs bg-slate-50 p-3 rounded border border-slate-200">
                  <span>كشف حساب: {historyData.party.name}</span>
                  <span className="font-mono font-bold">
                    الرصيد النهائي المستحق: {formatMoney(statementData.statement.closingBalance, org.base_currency)}
                  </span>
                </div>
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 px-2 text-right">التاريخ</th>
                      <th className="py-2 px-2 text-right">القيد</th>
                      <th className="py-2 px-2 text-right">البيان</th>
                      <th className="py-2 px-2 text-right">مدين</th>
                      <th className="py-2 px-2 text-right">دائن</th>
                      <th className="py-2 px-2 text-right">الرصيد</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {statementData.statement.lines.map((l: any, idx: number) => (
                      <tr key={idx}>
                        <td className="py-2 px-2 font-mono">{l.date}</td>
                        <td className="py-2 px-2 font-mono">{l.entryNumber}</td>
                        <td className="py-2 px-2">{l.description}</td>
                        <td className="py-2 px-2 font-mono">{formatMoney(l.debit, org.base_currency)}</td>
                        <td className="py-2 px-2 font-mono">{formatMoney(l.credit, org.base_currency)}</td>
                        <td className="py-2 px-2 font-mono font-semibold">{formatMoney(l.runningBalance, org.base_currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>

      <AttachmentsModal
        target={attTarget}
        defaultType="ID_DOC"
        allowedTypes={['ID_DOC', 'OTHER']}
        onClose={() => setAttTarget(null)}
      />
    </div>
  );
}

export function ContractsView({ org }: { org: OrganizationInfo }) {
  const [data, setData] = useState<{ agreements: any[]; installments: any[]; expenseTypes: any[]; expenseItems?: any[]; template?: any } | null>(null);
  const [properties, setProperties] = useState<any[]>([]);
  const [parties, setParties] = useState<any[]>([]);
  const [unitMeters, setUnitMeters] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<'agreements' | 'installments' | 'expenses'>('agreements');

  const [createOpen, setCreateOpen] = useState(false);
  const [expTypesOpen, setExpTypesOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplText, setTplText] = useState('');
  const [printDoc, setPrintDoc] = useState<PrintableDocPayload>(null);
  const [attTarget, setAttTarget] = useState<{ entityType: string; entityId: string; label: string } | null>(null);

  const [expTypeForm, setExpTypeForm] = useState({ name: '', calcMode: 'FIXED', defaultValue: '250', defaultChargeTo: 'TENANT', accountCode: '4400' });
  const [selectedExpenses, setSelectedExpenses] = useState<Array<{ expenseTypeId: string; amount: string; chargeTo: string }>>([]);
  const [initialReadings, setInitialReadings] = useState<Record<string, string>>({});

  const [form, setForm] = useState({
    unitId: '',
    tenantPartyId: '',
    startDate: '2026-11-15',
    endDate: '2027-11-14',
    totalAmount: '48000',
    discountAmount: '0',
    frequency: 'QUARTERLY',
    customCount: '4',
    graceDays: String(org.default_grace_days ?? 15),
    depositAmount: '4000',
    notes: '',
  });

  const [renewTarget, setRenewTarget] = useState<any>(null);
  const [renewForm, setRenewForm] = useState({ startDate: '2027-01-01', endDate: '2027-12-31', totalAmount: '50000' });

  const [amendTarget, setAmendTarget] = useState<any>(null);
  const [amendForm, setAmendForm] = useState({ newRemainingTotal: '', reason: '' });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [cRes, pRes, paRes, sRes] = await Promise.all([
        apiFetch('/api/contracts'),
        apiFetch('/api/properties'),
        apiFetch('/api/parties'),
        apiFetch('/api/services').catch(() => ({ meters: [] })),
      ]);
      setData(cRes);
      setProperties(pRes.properties);
      setParties(paRes.parties);
      setUnitMeters(sRes.meters ?? []);
      if (cRes.template?.body_template) setTplText(cRes.template.body_template);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const rentalUnits = properties.flatMap((p) =>
    p.units
      .filter((u: any) => u.tenure_type === 'RENTAL')
      .map((u: any) => ({ ...u, propertyName: p.name })),
  );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const metersForUnit = unitMeters.filter((m) => m.unit_id === form.unitId && initialReadings[m.id] !== undefined && initialReadings[m.id] !== '');
      await apiFetch('/api/contracts', {
        method: 'POST',
        idempotencyKey: `ctr_${Date.now()}`,
        body: JSON.stringify({
          ...form,
          customCount: Number(form.customCount),
          graceDays: Number(form.graceDays),
          expenseItems: selectedExpenses,
          initialMeterReadings: metersForUnit.map((m) => ({ meterId: m.id, reading: initialReadings[m.id] })),
        }),
      });
      setCreateOpen(false);
      setSelectedExpenses([]);
      setInitialReadings({});
      setSuccess('تم إنشاء العقد وتوليد جدول الأقساط والرسوم وحجز سجل التأمين.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleAddExpType(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/contracts/expense-types', {
        method: 'POST',
        body: JSON.stringify(expTypeForm),
      });
      setExpTypeForm({ name: '', calcMode: 'FIXED', defaultValue: '250', defaultChargeTo: 'TENANT', accountCode: '4400' });
      setSuccess('تمت إضافة نوع مصروف عقد جديد.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleSaveTemplate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/contracts/template', {
        method: 'PUT',
        body: JSON.stringify({ bodyTemplate: tplText }),
      });
      setTplOpen(false);
      setSuccess('تم حفظ قالب طباعة العقود للمنشأة.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleRenew(e: React.FormEvent) {
    e.preventDefault();
    if (!renewTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/contracts/${renewTarget.id}/renew`, {
        method: 'POST',
        body: JSON.stringify(renewForm),
      });
      setRenewTarget(null);
      setSuccess('تم تجديد العقد بإنشاء عقد جديد مرتبط بالسابق.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleAmend(e: React.FormEvent) {
    e.preventDefault();
    if (!amendTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/contracts/${amendTarget.id}/amend`, {
        method: 'POST',
        body: JSON.stringify(amendForm),
      });
      setAmendTarget(null);
      setSuccess('تم تعديل الأقساط غير المرحّلة دون المساس بالأقساط المرحّلة.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleDirectCancel(agId: string) {
    setError(null);
    try {
      await apiFetch(`/api/contracts/${agId}/cancel`, { method: 'POST', body: '{}' });
      setSuccess('تم إلغاء العقد مباشرة لعدم وجود حركات مالية عليه.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">العقود والأقساط والرسوم</h1>
          <p className="text-xs text-slate-500 mt-1">
            توزيع دقيق للأقساط بالخانة العشرية · التأمين مستقل كالتزام · قوالب طباعة ومرفقات الدخول
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setSubTab('agreements')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                subTab === 'agreements' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              العقود ({data?.agreements?.length ?? 0})
            </button>
            <button
              type="button"
              onClick={() => setSubTab('installments')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                subTab === 'installments' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              الأقساط ({data?.installments?.length ?? 0})
            </button>
            <button
              type="button"
              onClick={() => setSubTab('expenses')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                subTab === 'expenses' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              رسوم العقود ({(data?.expenseItems ?? []).length})
            </button>
          </div>
          <button type="button" onClick={() => setExpTypesOpen(true)} className={secondaryBtnCls}>
            أنواع الرسوم
          </button>
          <button type="button" onClick={() => setTplOpen(true)} className={secondaryBtnCls}>
            <FileText className="w-4 h-4" aria-hidden="true" />
            <span>قالب العقد</span>
          </button>
          <button type="button" onClick={() => setCreateOpen(true)} className={primaryBtnCls}>
            <FilePlus2 className="w-4 h-4" aria-hidden="true" />
            <span>عقد إيجار جديد</span>
          </button>
        </div>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} />

      {loading ? (
        <LoadingRows />
      ) : subTab === 'agreements' ? (
        <Panel>
          {(data?.agreements ?? []).length === 0 ? (
            <EmptyState title="لا توجد عقود بعد" description="أنشئ عقد إيجار لوحدة إيجارية شاغرة." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-right">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2.5 px-3 font-medium">العقار / الوحدة</th>
                    <th className="py-2.5 px-3 font-medium">المستأجر</th>
                    <th className="py-2.5 px-3 font-medium">الفترة</th>
                    <th className="py-2.5 px-3 font-medium">الصافي</th>
                    <th className="py-2.5 px-3 font-medium">التأمين المحتجز</th>
                    <th className="py-2.5 px-3 font-medium">الحالة</th>
                    <th className="py-2.5 px-3 font-medium">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data!.agreements.map((ag) => (
                    <tr key={ag.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-3 font-medium text-slate-900">
                        {ag.property_name} · وحدة {ag.unit_number}
                      </td>
                      <td className="py-3 px-3 text-slate-700">{ag.tenant_name}</td>
                      <td className="py-3 px-3 font-mono text-xs text-slate-600">
                        {formatDateDisplay(ag.start_date, Boolean(org.show_hijri_dates))} ←{' '}
                        {formatDateDisplay(ag.end_date, Boolean(org.show_hijri_dates))}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums font-medium">
                        {formatMoney(Number(ag.total_amount) - Number(ag.discount_amount), org.base_currency)}
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums text-xs">
                        {formatMoney(ag.deposit_held ?? 0, org.base_currency)} / {formatMoney(ag.deposit_expected ?? 0, org.base_currency)}
                      </td>
                      <td className="py-3 px-3">
                        <StatusText status={ag.status} />
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setPrintDoc({ kind: 'CONTRACT', contractId: ag.id })}
                            className={secondaryBtnCls}
                          >
                            <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>طباعة</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setAttTarget({ entityType: 'AGREEMENT', entityId: ag.id, label: `عقد وحدة ${ag.unit_number}` })}
                            className={secondaryBtnCls}
                          >
                            <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>صور ومرفقات</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRenewTarget(ag);
                              setRenewForm({
                                startDate: ag.end_date,
                                endDate: ag.end_date,
                                totalAmount: ag.total_amount,
                              });
                            }}
                            className={secondaryBtnCls}
                          >
                            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>تجديد</span>
                          </button>
                          {ag.status === 'ACTIVE' && (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setAmendTarget(ag);
                                  setAmendForm({ newRemainingTotal: ag.total_amount, reason: '' });
                                }}
                                className={secondaryBtnCls}
                              >
                                تعديل
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDirectCancel(ag.id)}
                                className={dangerBtnCls}
                              >
                                إلغاء
                              </button>
                            </>
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
      ) : subTab === 'installments' ? (
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-2.5 px-3 font-medium">القسط</th>
                  <th className="py-2.5 px-3 font-medium">العقار / الوحدة</th>
                  <th className="py-2.5 px-3 font-medium">المستأجر</th>
                  <th className="py-2.5 px-3 font-medium">الاستحقاق</th>
                  <th className="py-2.5 px-3 font-medium">المبلغ</th>
                  <th className="py-2.5 px-3 font-medium">المسدد / المعفى</th>
                  <th className="py-2.5 px-3 font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(data?.installments ?? []).map((i) => (
                  <tr key={i.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-3 font-mono">#{i.installment_number}</td>
                    <td className="py-2.5 px-3 text-slate-900">
                      {i.property_name} · {i.unit_number}
                    </td>
                    <td className="py-2.5 px-3 text-slate-700">{i.tenant_name}</td>
                    <td className="py-2.5 px-3 font-mono text-xs">{i.due_date}</td>
                    <td className="py-2.5 px-3 font-mono tabular-nums font-medium">{formatMoney(i.amount, org.base_currency)}</td>
                    <td className="py-2.5 px-3 font-mono tabular-nums text-xs text-slate-600">
                      {formatMoney(i.paid_amount, org.base_currency)} · معفى: {formatMoney(i.waived_amount ?? 0, org.base_currency)}
                    </td>
                    <td className="py-2.5 px-3">
                      <StatusText status={i.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : (
        <Panel title="بنود ومصاريف العقود (الرسوم والضرائب)">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-2 px-3 font-medium">البند</th>
                  <th className="py-2 px-3 font-medium">العقار / الوحدة</th>
                  <th className="py-2 px-3 font-medium">المستأجر</th>
                  <th className="py-2 px-3 font-medium">جهة التحميل</th>
                  <th className="py-2 px-3 font-medium">المبلغ</th>
                  <th className="py-2 px-3 font-medium">المسدد</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(data?.expenseItems ?? []).map((ei: any) => (
                  <tr key={ei.id}>
                    <td className="py-2.5 px-3 font-medium">{ei.name}</td>
                    <td className="py-2.5 px-3 text-xs">{ei.property_name} · وحدة {ei.unit_number}</td>
                    <td className="py-2.5 px-3 text-xs">{ei.tenant_name}</td>
                    <td className="py-2.5 px-3"><StatusText status={ei.charge_to} /></td>
                    <td className="py-2.5 px-3 font-mono">{formatMoney(ei.amount, org.base_currency)}</td>
                    <td className="py-2.5 px-3 font-mono text-emerald-700">{formatMoney(ei.paid_amount, org.base_currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Modal open={createOpen} title="إنشاء عقد إيجار جديد" onClose={() => setCreateOpen(false)} wide>
        <form onSubmit={handleCreate} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="الوحدة (إيجار فقط)" id="ctr-unit" required>
            <select id="ctr-unit" required value={form.unitId} onChange={(e) => setForm({ ...form, unitId: e.target.value })} className={inputCls}>
              <option value="">اختر الوحدة...</option>
              {rentalUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.propertyName} — وحدة {u.unit_number} ({u.derived_status})
                </option>
              ))}
            </select>
          </Field>
          <Field label="المستأجر" id="ctr-tenant" required>
            <select id="ctr-tenant" required value={form.tenantPartyId} onChange={(e) => setForm({ ...form, tenantPartyId: e.target.value })} className={inputCls}>
              <option value="">اختر المستأجر...</option>
              {parties.map((pa) => (
                <option key={pa.id} value={pa.id}>
                  {pa.name} ({pa.national_id || 'بدون هوية'})
                </option>
              ))}
            </select>
          </Field>
          <Field label="تاريخ البداية" id="ctr-start" required>
            <input id="ctr-start" type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className={inputCls} />
          </Field>
          <Field label="تاريخ النهاية" id="ctr-end" required>
            <input id="ctr-end" type="date" required value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className={inputCls} />
          </Field>
          <Field label="إجمالي قيمة العقد" id="ctr-total" required>
            <input id="ctr-total" type="number" step="0.01" required value={form.totalAmount} onChange={(e) => setForm({ ...form, totalAmount: e.target.value })} className={inputCls} />
          </Field>
          <Field label="الخصم (اختياري)" id="ctr-disc">
            <input id="ctr-disc" type="number" step="0.01" value={form.discountAmount} onChange={(e) => setForm({ ...form, discountAmount: e.target.value })} className={inputCls} />
          </Field>
          <Field label="دورية التحصيل" id="ctr-freq" required>
            <select id="ctr-freq" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} className={inputCls}>
              <option value="MONTHLY">شهري</option>
              <option value="QUARTERLY">ربع سنوي</option>
              <option value="SEMI_ANNUAL">نصف سنوي</option>
              <option value="ANNUAL">سنوي</option>
              <option value="CUSTOM">مخصص (عدد أقساط)</option>
            </select>
          </Field>
          {form.frequency === 'CUSTOM' ? (
            <Field label="عدد الأقساط" id="ctr-cnt">
              <input id="ctr-cnt" type="number" min={1} value={form.customCount} onChange={(e) => setForm({ ...form, customCount: e.target.value })} className={inputCls} />
            </Field>
          ) : (
            <Field label="مهلة الإخلاء (أيام بلا إيجار)" id="ctr-grace">
              <input id="ctr-grace" type="number" min={0} value={form.graceDays} onChange={(e) => setForm({ ...form, graceDays: e.target.value })} className={inputCls} />
            </Field>
          )}
          <Field label="مبلغ التأمين المستقل" id="ctr-dep">
            <input id="ctr-dep" type="number" step="0.01" value={form.depositAmount} onChange={(e) => setForm({ ...form, depositAmount: e.target.value })} className={inputCls} />
          </Field>
          <Field label="ملاحظات" id="ctr-notes">
            <input id="ctr-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={inputCls} />
          </Field>

          {(data?.expenseTypes ?? []).length > 0 && (
            <div className="sm:col-span-2 border-t border-slate-200 pt-3">
              <div className="text-xs font-semibold text-slate-800 mb-2">الرسوم والضرائب الإضافية على العقد</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(data?.expenseTypes ?? []).map((et: any) => {
                  const chosen = selectedExpenses.find((x) => x.expenseTypeId === et.id);
                  return (
                    <label key={et.id} className="flex items-center justify-between gap-2 p-2 bg-slate-50 rounded border border-slate-200 text-xs">
                      <span className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={Boolean(chosen)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedExpenses([...selectedExpenses, { expenseTypeId: et.id, amount: '', chargeTo: et.default_charge_to }]);
                            } else {
                              setSelectedExpenses(selectedExpenses.filter((x) => x.expenseTypeId !== et.id));
                            }
                          }}
                        />
                        {et.name} ({et.calc_mode === 'PERCENTAGE' ? `${et.default_value}%` : formatMoney(et.default_value, org.base_currency)})
                      </span>
                      {chosen && (
                        <select
                          value={chosen.chargeTo}
                          onChange={(e) =>
                            setSelectedExpenses(
                              selectedExpenses.map((x) => (x.expenseTypeId === et.id ? { ...x, chargeTo: e.target.value } : x)),
                            )
                          }
                          className="border border-slate-300 rounded px-1.5 py-0.5 text-xs bg-white"
                        >
                          <option value="TENANT">على المستأجر</option>
                          <option value="OWNER">على المالك</option>
                        </select>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {form.unitId && unitMeters.filter((m) => m.unit_id === form.unitId).length > 0 && (
            <div className="sm:col-span-2 border-t border-slate-200 pt-3">
              <div className="text-xs font-semibold text-slate-800 mb-2">القراءة الافتتاحية لعدادات الوحدة عند التسليم</div>
              <div className="grid grid-cols-2 gap-2">
                {unitMeters
                  .filter((m) => m.unit_id === form.unitId)
                  .map((m) => (
                    <Field key={m.id} label={`${m.service_name} (${m.meter_number})`} id={`init-rdg-${m.id}`}>
                      <input
                        id={`init-rdg-${m.id}`}
                        type="number"
                        step="0.01"
                        placeholder={`الحالية: ${m.last_reading}`}
                        value={initialReadings[m.id] ?? m.last_reading}
                        onChange={(e) => setInitialReadings({ ...initialReadings, [m.id]: e.target.value })}
                        className={inputCls}
                      />
                    </Field>
                  ))}
              </div>
            </div>
          )}

          <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setCreateOpen(false)} className={secondaryBtnCls}>
              إلغاء
            </button>
            <button type="submit" className={primaryBtnCls}>
              إنشاء العقد وتوليد الأقساط
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={expTypesOpen} title="أنواع مصاريف ورسوم العقود" onClose={() => setExpTypesOpen(false)}>
        <div className="space-y-4">
          <div className="space-y-1.5 max-h-40 overflow-y-auto text-xs">
            {(data?.expenseTypes ?? []).map((et: any) => (
              <div key={et.id} className="p-2 border border-slate-200 rounded flex justify-between">
                <span className="font-semibold">{et.name}</span>
                <span className="font-mono">
                  {et.calc_mode === 'PERCENTAGE' ? `${et.default_value}%` : formatMoney(et.default_value, org.base_currency)} ·{' '}
                  {et.default_charge_to === 'TENANT' ? 'على المستأجر' : 'على المالك'}
                </span>
              </div>
            ))}
          </div>
          <form onSubmit={handleAddExpType} className="space-y-3 border-t border-slate-200 pt-3">
            <Field label="اسم البند الجديد" id="cet-name" required>
              <input id="cet-name" required value={expTypeForm.name} onChange={(e) => setExpTypeForm({ ...expTypeForm, name: e.target.value })} className={inputCls} />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="طريقة الحساب" id="cet-mode">
                <select id="cet-mode" value={expTypeForm.calcMode} onChange={(e) => setExpTypeForm({ ...expTypeForm, calcMode: e.target.value })} className={inputCls}>
                  <option value="FIXED">مبلغ ثابت</option>
                  <option value="PERCENTAGE">نسبة %</option>
                </select>
              </Field>
              <Field label="القيمة" id="cet-val">
                <input id="cet-val" type="number" step="0.01" value={expTypeForm.defaultValue} onChange={(e) => setExpTypeForm({ ...expTypeForm, defaultValue: e.target.value })} className={inputCls} />
              </Field>
              <Field label="التحميل" id="cet-chg">
                <select id="cet-chg" value={expTypeForm.defaultChargeTo} onChange={(e) => setExpTypeForm({ ...expTypeForm, defaultChargeTo: e.target.value })} className={inputCls}>
                  <option value="TENANT">المستأجر</option>
                  <option value="OWNER">المالك</option>
                </select>
              </Field>
            </div>
            <button type="submit" className={primaryBtnCls}>إضافة البند</button>
          </form>
        </div>
      </Modal>

      <Modal open={tplOpen} title="تعديل قالب طباعة العقود للمنشأة" onClose={() => setTplOpen(false)} wide>
        <form onSubmit={handleSaveTemplate} className="space-y-4">
          <p className="text-xs text-slate-500">
            المتغيرات المتاحة: {'{{orgName}}, {{propertyName}}, {{unitNumber}}, {{tenantName}}, {{tenantNationalId}}, {{startDate}}, {{endDate}}, {{netTotal}}, {{depositAmount}}, {{graceDays}}'}
          </p>
          <textarea rows={12} value={tplText} onChange={(e) => setTplText(e.target.value)} className={`${inputCls} text-xs leading-relaxed`} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setTplOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ القالب</button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(renewTarget)} title="تجديد العقد (عقد جديد)" onClose={() => setRenewTarget(null)}>
        <form onSubmit={handleRenew} className="space-y-4">
          <Field label="تاريخ البداية الجديد" id="rn-start" required>
            <input id="rn-start" type="date" required value={renewForm.startDate} onChange={(e) => setRenewForm({ ...renewForm, startDate: e.target.value })} className={inputCls} />
          </Field>
          <Field label="تاريخ النهاية الجديد" id="rn-end" required>
            <input id="rn-end" type="date" required value={renewForm.endDate} onChange={(e) => setRenewForm({ ...renewForm, endDate: e.target.value })} className={inputCls} />
          </Field>
          <Field label="القيمة الجديدة" id="rn-total" required>
            <input id="rn-total" type="number" step="0.01" required value={renewForm.totalAmount} onChange={(e) => setRenewForm({ ...renewForm, totalAmount: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRenewTarget(null)} className={secondaryBtnCls}>
              إلغاء
            </button>
            <button type="submit" className={primaryBtnCls}>
              تأكيد التجديد
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(amendTarget)} title="تعديل الأقساط غير المرحّلة" onClose={() => setAmendTarget(null)}>
        <form onSubmit={handleAmend} className="space-y-4">
          <Field label="إجمالي المتبقي الجديد" id="am-val" required>
            <input id="am-val" type="number" step="0.01" required value={amendForm.newRemainingTotal} onChange={(e) => setAmendForm({ ...amendForm, newRemainingTotal: e.target.value })} className={inputCls} />
          </Field>
          <Field label="سبب التعديل الموثّق" id="am-reason" required>
            <input id="am-reason" required value={amendForm.reason} onChange={(e) => setAmendForm({ ...amendForm, reason: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAmendTarget(null)} className={secondaryBtnCls}>
              إلغاء
            </button>
            <button type="submit" className={primaryBtnCls}>
              حفظ التعديل
            </button>
          </div>
        </form>
      </Modal>

      <PrintableDocumentModal doc={printDoc} onClose={() => setPrintDoc(null)} />
      <AttachmentsModal
        target={attTarget}
        defaultType="ENTRY_PHOTO"
        allowedTypes={['ENTRY_PHOTO', 'CONTRACT_SCAN', 'OTHER']}
        onClose={() => setAttTarget(null)}
      />
    </div>
  );
}
