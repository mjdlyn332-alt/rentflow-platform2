import React, { useEffect, useState } from 'react';
import {
  Bell,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  Download,
  Edit3,
  FileSpreadsheet,
  Lock,
  Mail,
  Plus,
  Printer,
  RotateCcw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Unlock,
  UserPlus,
} from 'lucide-react';
import {
  ACCOUNT_TYPE_LABELS,
  apiFetch,
  AuthUser,
  downloadCsvExcel,
  formatDateDisplay,
  formatMoney,
  OrganizationInfo,
  ROLE_LABELS,
} from '../lib/api';
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

const STAFF_DOMAIN_LABELS: Array<{ key: string; label: string }> = [
  { key: 'properties', label: 'العقارات والوحدات' },
  { key: 'parties', label: 'الملاك والمستأجرون' },
  { key: 'contracts', label: 'العقود والأقساط' },
  { key: 'services', label: 'الخدمات والعدادات' },
  { key: 'collections', label: 'التحصيل والصناديق' },
  { key: 'maintenance', label: 'الصيانة' },
  { key: 'evictions', label: 'الإخلاء والتسليم' },
  { key: 'accounting', label: 'المحاسبة والقيود' },
  { key: 'reports', label: 'التقارير' },
  { key: 'notifications', label: 'الإشعارات' },
  { key: 'settings', label: 'الإعدادات والتدقيق' },
];

function createEmptyMatrix(allowAll = false): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  for (const d of STAFF_DOMAIN_LABELS) {
    out[d.key] = { read: allowAll, create: allowAll, update: allowAll, delete: allowAll };
  }
  return out;
}

export function AccountingView({ user, org }: { user: AuthUser; org: OrganizationInfo }) {
  const [data, setData] = useState<any>(null);
  const [incomeData, setIncomeData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [tab, setTab] = useState<'tb' | 'ledger' | 'je' | 'income' | 'coa'>('tb');

  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState({
    entryDate: '2026-11-14',
    description: '',
    debitCode: '1110',
    creditCode: '3100',
    amount: '',
  });

  const [accOpen, setAccOpen] = useState(false);
  const [accForm, setAccForm] = useState({ code: '', name: '', accountType: 'EXPENSE' });

  const [renameTarget, setRenameTarget] = useState<any>(null);
  const [renameVal, setRenameVal] = useState('');

  const [ruleTarget, setRuleTarget] = useState<any>(null);
  const [ruleForm, setRuleForm] = useState({ debitAccountCode: '', creditAccountCode: '', description: '' });

  const [revJeTarget, setRevJeTarget] = useState<any>(null);
  const [revJeReason, setRevJeReason] = useState('');

  const [ledgerCode, setLedgerCode] = useState('1210');
  const [ledgerFrom, setLedgerFrom] = useState('');
  const [ledgerTo, setLedgerTo] = useState('');
  const [ledgerData, setLedgerData] = useState<any>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [acc, inc] = await Promise.all([
        apiFetch('/api/accounting/overview'),
        apiFetch('/api/accounting/property-income'),
      ]);
      setData(acc);
      setIncomeData(inc.propertyIncome);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadLedger(code = ledgerCode, from = ledgerFrom, to = ledgerTo) {
    try {
      const params = new URLSearchParams({ accountCode: code });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await apiFetch(`/api/accounting/ledger?${params.toString()}`);
      setLedgerData(res);
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (tab === 'ledger') {
      loadLedger(ledgerCode, ledgerFrom, ledgerTo);
    }
  }, [tab, ledgerCode, ledgerFrom, ledgerTo]);

  async function handleManualJe(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/accounting/journal-entries', {
        method: 'POST',
        body: JSON.stringify({
          entryDate: manualForm.entryDate,
          description: manualForm.description,
          lines: [
            { accountCode: manualForm.debitCode, debit: manualForm.amount, memo: manualForm.description },
            { accountCode: manualForm.creditCode, credit: manualForm.amount, memo: manualForm.description },
          ],
        }),
      });
      setManualOpen(false);
      setManualForm({ entryDate: '2026-11-14', description: '', debitCode: '1110', creditCode: '3100', amount: '' });
      setSuccess('تم ترحيل القيد اليدوي المتوازن بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleAddAccount(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/accounting/accounts', {
        method: 'POST',
        body: JSON.stringify(accForm),
      });
      setAccOpen(false);
      setAccForm({ code: '', name: '', accountType: 'EXPENSE' });
      setSuccess('تمت إضافة الحساب إلى شجرة الحسابات.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleRenameAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!renameTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/accounting/accounts/${renameTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: renameVal }),
      });
      setRenameTarget(null);
      setSuccess('تم تحديث مسمى الحساب في شجرة الحسابات.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleUpdateRule(e: React.FormEvent) {
    e.preventDefault();
    if (!ruleTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/accounting/posting-rules/${ruleTarget.id}`, {
        method: 'PATCH',
        body: JSON.stringify(ruleForm),
      });
      setRuleTarget(null);
      setSuccess('تم تحديث قاعدة الترحيل الآلي بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleReverseJe(e: React.FormEvent) {
    e.preventDefault();
    if (!revJeTarget) return;
    setError(null);
    try {
      await apiFetch(`/api/accounting/journal-entries/${revJeTarget.id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({ reason: revJeReason || 'قيد عكسي' }),
      });
      setRevJeTarget(null);
      setRevJeReason('');
      setSuccess('تم إنشاء القيد العكسي بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function togglePeriod(p: any) {
    setError(null);
    try {
      await apiFetch(`/api/accounting/periods/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isClosed: !p.is_closed }),
      });
      setSuccess(p.is_closed ? 'تمت إعادة فتح الفترة المحاسبية.' : 'تم إقفال الفترة المحاسبية بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function exportLedgerExcel() {
    if (!ledgerData) return;
    downloadCsvExcel(
      `ledger-${ledgerCode}-${new Date().toISOString().slice(0, 10)}.csv`,
      ['التاريخ', 'رقم القيد', 'البيان', 'مدين', 'دائن', 'الرصيد التراكمي'],
      (ledgerData.lines ?? []).map((l: any) => [
        l.entry_date,
        l.entry_number,
        `${l.entry_description}${l.party_name ? ` — ${l.party_name}` : ''}`,
        l.debit,
        l.credit,
        l.runningBalance,
      ]),
    );
  }

  const rec = data?.reconciliation;
  const showHijri = Boolean(org.show_hijri_dates);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">المحاسبة الآلية والدفتر العام والمطابقة</h1>
          <p className="text-xs text-slate-500 mt-1">قيد مزدوج آلي · دفتر الأستاذ العام لكل حساب · عكس القيود · تعديل شجرة الحسابات وقواعد الترحيل</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {user.role === 'OWNER' && (
            <button type="button" onClick={() => setAccOpen(true)} className={secondaryBtnCls}>
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>حساب جديد</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setManualForm({
                entryDate: '2026-01-01',
                description: 'قيد أرصدة افتتاحية للصندوق',
                debitCode: '1110',
                creditCode: '3100',
                amount: '',
              });
              setManualOpen(true);
            }}
            className={secondaryBtnCls}
          >
            <span>أرصدة افتتاحية</span>
          </button>
          <button type="button" onClick={() => setManualOpen(true)} className={primaryBtnCls}>
            <BookOpen className="w-4 h-4" aria-hidden="true" />
            <span>قيد يدوي</span>
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {[
          { id: 'tb', label: 'ميزان المراجعة والمطابقة' },
          { id: 'ledger', label: 'كشف الحساب (الأستاذ العام)' },
          { id: 'je', label: `دفتر القيود (${data?.entries?.length ?? 0})` },
          { id: 'income', label: 'دخل العقارات' },
          { id: 'coa', label: 'الشجرة وقواعد الترحيل والفترات' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as any)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} />

      {loading ? (
        <LoadingRows />
      ) : (
        <>
          {rec && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatTile
                label="توازن ميزان المراجعة"
                value={rec.trialBalance.passed ? 'متوازن (الفرق 0.00)' : `فرق ${rec.trialBalance.diff}`}
                meta={`مدين: ${formatMoney(rec.trialBalance.totalDebit, org.base_currency)}`}
              />
              <StatTile
                label="مطابقة الذمم (المساعد ↔ العام)"
                value={rec.receivables.passed ? 'متطابق' : `فرق ${rec.receivables.diff}`}
                meta={`المساعد: ${formatMoney(rec.receivables.subLedgerTotal, org.base_currency)}`}
              />
              <StatTile
                label="مطابقة التأمينات المحتجزة"
                value={rec.deposits.passed ? 'متطابق' : `فرق ${rec.deposits.diff}`}
                meta={`المحتجز: ${formatMoney(rec.deposits.subLedgerHeldTotal, org.base_currency)}`}
              />
              <StatTile
                label="مطابقة أرصدة الصناديق"
                value={rec.cashboxes.passed ? 'متطابق' : `فرق ${rec.cashboxes.diff}`}
                meta={`إجمالي الصناديق: ${formatMoney(rec.cashboxes.subLedgerTotal, org.base_currency)}`}
              />
            </div>
          )}

          {tab === 'tb' && (
            <Panel
              title="ميزان المراجعة (Trial Balance)"
              action={
                <button
                  type="button"
                  onClick={() =>
                    downloadCsvExcel(
                      `trial-balance-${new Date().toISOString().slice(0, 10)}.csv`,
                      ['الرمز', 'الحساب', 'التصنيف', 'حركة مدين', 'حركة دائن', 'رصيد مدين', 'رصيد دائن'],
                      (data?.trialBalance ?? []).map((a: any) => [
                        a.code,
                        a.name,
                        ACCOUNT_TYPE_LABELS[a.account_type] ?? a.account_type,
                        a.totalDebit,
                        a.totalCredit,
                        a.netDebit,
                        a.netCredit,
                      ]),
                    )
                  }
                  className={secondaryBtnCls}
                >
                  <FileSpreadsheet className="w-4 h-4" aria-hidden="true" />
                  <span>تصدير Excel</span>
                </button>
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-right">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs text-slate-500">
                      <th className="py-2.5 px-3 font-medium">الرمز</th>
                      <th className="py-2.5 px-3 font-medium">اسم الحساب</th>
                      <th className="py-2.5 px-3 font-medium">التصنيف</th>
                      <th className="py-2.5 px-3 font-medium">حركة مدين</th>
                      <th className="py-2.5 px-3 font-medium">حركة دائن</th>
                      <th className="py-2.5 px-3 font-medium">رصيد مدين</th>
                      <th className="py-2.5 px-3 font-medium">رصيد دائن</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(data?.trialBalance ?? []).map((acc: any) => (
                      <tr key={acc.code} className="hover:bg-slate-50/70">
                        <td className="py-2.5 px-3 font-mono text-xs">{acc.code}</td>
                        <td className="py-2.5 px-3 font-medium text-slate-900">
                          <button
                            type="button"
                            onClick={() => {
                              setLedgerCode(acc.code);
                              setTab('ledger');
                            }}
                            className="hover:underline text-teal-800"
                          >
                            {acc.name}
                          </button>
                        </td>
                        <td className="py-2.5 px-3 text-xs text-slate-600 whitespace-nowrap">{ACCOUNT_TYPE_LABELS[acc.account_type] ?? acc.account_type}</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums whitespace-nowrap">{formatMoney(acc.totalDebit, org.base_currency)}</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums whitespace-nowrap">{formatMoney(acc.totalCredit, org.base_currency)}</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums font-medium whitespace-nowrap">{formatMoney(acc.netDebit, org.base_currency)}</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums font-medium whitespace-nowrap">{formatMoney(acc.netCredit, org.base_currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {tab === 'ledger' && (
            <Panel
              title="دفتر الأستاذ العام التفصيلي (كشف حساب)"
              action={
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => window.print()} className={secondaryBtnCls}>
                    <Printer className="w-4 h-4" aria-hidden="true" />
                    <span>طباعة</span>
                  </button>
                  <button type="button" onClick={exportLedgerExcel} className={secondaryBtnCls}>
                    <Download className="w-4 h-4" aria-hidden="true" />
                    <span>Excel</span>
                  </button>
                </div>
              }
            >
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 bg-slate-50 p-3 rounded-md border border-slate-200">
                <Field label="الحساب" id="ldg-acc">
                  <select id="ldg-acc" value={ledgerCode} onChange={(e) => setLedgerCode(e.target.value)} className={inputCls}>
                    {(data?.trialBalance ?? []).map((a: any) => (
                      <option key={a.code} value={a.code}>{a.code} — {a.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="من تاريخ" id="ldg-from">
                  <input id="ldg-from" type="date" value={ledgerFrom} onChange={(e) => setLedgerFrom(e.target.value)} className={inputCls} />
                </Field>
                <Field label="إلى تاريخ" id="ldg-to">
                  <input id="ldg-to" type="date" value={ledgerTo} onChange={(e) => setLedgerTo(e.target.value)} className={inputCls} />
                </Field>
              </div>
              {ledgerData && (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-6 text-xs bg-teal-50/70 p-3 rounded border border-teal-100 font-mono">
                    <span>الرصيد الافتتاحي: <strong>{formatMoney(ledgerData.openingBalance, org.base_currency)}</strong></span>
                    <span>الرصيد الختامي: <strong>{formatMoney(ledgerData.closingBalance, org.base_currency)}</strong></span>
                    <span>عدد الحركات: <strong>{ledgerData.lines?.length ?? 0}</strong></span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-right">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500">
                          <th className="py-2 px-2">التاريخ</th>
                          <th className="py-2 px-2">رقم القيد</th>
                          <th className="py-2 px-2">البيان والطرف</th>
                          <th className="py-2 px-2">مدين</th>
                          <th className="py-2 px-2">دائن</th>
                          <th className="py-2 px-2">الرصيد</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {(ledgerData.lines ?? []).map((l: any) => (
                          <tr key={l.id}>
                            <td className="py-2 px-2 font-mono">{formatDateDisplay(l.entry_date, showHijri)}</td>
                            <td className="py-2 px-2 font-mono">{l.entry_number}</td>
                            <td className="py-2 px-2">
                              {l.entry_description} {l.party_name ? `· ${l.party_name}` : ''} {l.property_name ? `(${l.property_name})` : ''}
                            </td>
                            <td className="py-2 px-2 font-mono tabular-nums">{Number(l.debit) > 0 ? l.debit : '—'}</td>
                            <td className="py-2 px-2 font-mono tabular-nums">{Number(l.credit) > 0 ? l.credit : '—'}</td>
                            <td className="py-2 px-2 font-mono tabular-nums font-semibold">{l.runningBalance}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Panel>
          )}

          {tab === 'je' && (
            <Panel title="سجل القيود اليومية" subtitle="القيود المرحّلة لا تُحذف ولا تُعدَّل؛ يُصحح الخطأ بقيد عكسي فقط">
              <div className="space-y-3">
                {(data?.entries ?? []).map((je: any) => (
                  <div key={je.id} className="border border-slate-200 rounded-lg p-3.5 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100">
                      <div>
                        <span className="font-mono font-semibold text-slate-900">{je.entry_number}</span>
                        <span className="mx-2 text-slate-300">·</span>
                        <span className="text-slate-800">{je.description}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                        <span>{formatDateDisplay(je.entry_date, showHijri)} · {je.source_type}</span>
                        {!je.reversed_entry_id && (
                          <button type="button" onClick={() => setRevJeTarget(je)} className={dangerBtnCls}>
                            <RotateCcw className="w-3 h-3" aria-hidden="true" />
                            <span>عكس القيد</span>
                          </button>
                        )}
                      </div>
                    </div>
                    <table className="w-full text-xs mt-2">
                      <thead>
                        <tr className="text-slate-500">
                          <th className="py-1 text-right font-medium">الحساب</th>
                          <th className="py-1 text-right font-medium">البيان</th>
                          <th className="py-1 text-left font-medium">مدين</th>
                          <th className="py-1 text-left font-medium">دائن</th>
                        </tr>
                      </thead>
                      <tbody>
                        {je.lines.map((l: any) => (
                          <tr key={l.id}>
                            <td className="py-1 font-mono">{l.account_code} — {l.account_name}</td>
                            <td className="py-1 text-slate-600">{l.party_name ? `${l.party_name} · ` : ''}{l.memo || '—'}</td>
                            <td className="py-1 text-left font-mono tabular-nums">{Number(l.debit) > 0 ? l.debit : '—'}</td>
                            <td className="py-1 text-left font-mono tabular-nums">{Number(l.credit) > 0 ? l.credit : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {tab === 'income' && (
            <Panel title="قائمة الدخل المبسطة لكل عقار (مركز التكلفة)">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-right">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs text-slate-500">
                      <th className="py-2.5 px-3 font-medium">العقار</th>
                      <th className="py-2.5 px-3 font-medium">الإيرادات</th>
                      <th className="py-2.5 px-3 font-medium">المصروفات</th>
                      <th className="py-2.5 px-3 font-medium">صافي الدخل</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {incomeData.map((row) => (
                      <tr key={row.propertyId}>
                        <td className="py-2.5 px-3 font-medium">{row.name} ({row.code})</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-emerald-700">{formatMoney(row.revenue, org.base_currency)}</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-red-700">{formatMoney(row.expense, org.base_currency)}</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums font-semibold">{formatMoney(row.netIncome, org.base_currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {tab === 'coa' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Panel title="شجرة الحسابات (تعديل المسمى)" subtitle="تُضاف الحسابات المخصصة وتُعدل مسمياتها">
                <div className="space-y-2 max-h-80 overflow-y-auto text-xs">
                  {(data?.trialBalance ?? []).map((a: any) => (
                    <div key={a.id} className="flex items-center justify-between py-1.5 border-b border-slate-100">
                      <div>
                        <span className="font-mono font-semibold text-slate-800">{a.code}</span>
                        <span className="mx-2 text-slate-300">—</span>
                        <span>{a.name}</span>
                      </div>
                      {user.role === 'OWNER' && (
                        <button
                          type="button"
                          onClick={() => {
                            setRenameTarget(a);
                            setRenameVal(a.name);
                          }}
                          className={secondaryBtnCls}
                        >
                          <Edit3 className="w-3 h-3" aria-hidden="true" />
                          <span>إعادة تسمية</span>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title="قواعد الترحيل القياسية (قابلة للتخصيص)">
                <div className="space-y-2 max-h-80 overflow-y-auto text-xs">
                  {(data?.postingRules ?? []).map((r: any) => (
                    <div key={r.id} className="flex items-center justify-between gap-2 py-1.5 border-b border-slate-100">
                      <div>
                        <div className="text-slate-800 font-medium">{r.description}</div>
                        <div className="font-mono text-slate-500">مدين {r.debit_account_code} / دائن {r.credit_account_code}</div>
                      </div>
                      {user.role === 'OWNER' && (
                        <button
                          type="button"
                          onClick={() => {
                            setRuleTarget(r);
                            setRuleForm({
                              debitAccountCode: r.debit_account_code,
                              creditAccountCode: r.credit_account_code,
                              description: r.description,
                            });
                          }}
                          className={secondaryBtnCls}
                        >
                          تعديل
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title="الفترات المحاسبية" subtitle="لا يمكن الترحيل لأي فترة مقفلة" className="lg:col-span-2">
                <div className="space-y-3">
                  {(data?.periods ?? []).map((p: any) => (
                    <div key={p.id} className="flex items-center justify-between py-2 border-b border-slate-100 text-sm">
                      <div>
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs font-mono text-slate-500">{p.start_date} ← {p.end_date}</div>
                      </div>
                      {user.role === 'OWNER' && (
                        <button type="button" onClick={() => togglePeriod(p)} className={secondaryBtnCls}>
                          {p.is_closed ? <Unlock className="w-3.5 h-3.5" aria-hidden="true" /> : <Lock className="w-3.5 h-3.5" aria-hidden="true" />}
                          <span>{p.is_closed ? 'إعادة فتح' : 'إقفال الفترة'}</span>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </Panel>
            </div>
          )}
        </>
      )}

      {/* Manual / Opening Journal Entry Modal */}
      <Modal open={manualOpen} title="إنشاء قيد محاسبي يدوي / قيد افتتاحي" onClose={() => setManualOpen(false)}>
        <form onSubmit={handleManualJe} className="space-y-4">
          <Field label="التاريخ" id="je-date" required>
            <input id="je-date" type="date" required value={manualForm.entryDate} onChange={(e) => setManualForm({ ...manualForm, entryDate: e.target.value })} className={inputCls} />
          </Field>
          <Field label="الوصف" id="je-desc" required>
            <input id="je-desc" required value={manualForm.description} onChange={(e) => setManualForm({ ...manualForm, description: e.target.value })} className={inputCls} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="حساب المدين" id="je-deb">
              <select id="je-deb" value={manualForm.debitCode} onChange={(e) => setManualForm({ ...manualForm, debitCode: e.target.value })} className={inputCls}>
                {(data?.trialBalance ?? []).map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
              </select>
            </Field>
            <Field label="حساب الدائن" id="je-cred">
              <select id="je-cred" value={manualForm.creditCode} onChange={(e) => setManualForm({ ...manualForm, creditCode: e.target.value })} className={inputCls}>
                {(data?.trialBalance ?? []).map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="المبلغ" id="je-amt" required>
            <input id="je-amt" type="number" step="0.01" required value={manualForm.amount} onChange={(e) => setManualForm({ ...manualForm, amount: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setManualOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>ترحيل القيد</button>
          </div>
        </form>
      </Modal>

      {/* Add Custom Account Modal */}
      <Modal open={accOpen} title="إضافة حساب مخصص إلى الشجرة" onClose={() => setAccOpen(false)}>
        <form onSubmit={handleAddAccount} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="رقم / رمز الحساب" id="acc-code" required>
              <input id="acc-code" required dir="ltr" value={accForm.code} onChange={(e) => setAccForm({ ...accForm, code: e.target.value })} className={inputCls} placeholder="5600" />
            </Field>
            <Field label="تصنيف الحساب" id="acc-type">
              <select id="acc-type" value={accForm.accountType} onChange={(e) => setAccForm({ ...accForm, accountType: e.target.value })} className={inputCls}>
                <option value="ASSET">أصل</option>
                <option value="LIABILITY">التزام</option>
                <option value="EQUITY">حقوق ملكية</option>
                <option value="REVENUE">إيراد</option>
                <option value="EXPENSE">مصروف</option>
              </select>
            </Field>
          </div>
          <Field label="اسم الحساب" id="acc-name" required>
            <input id="acc-name" required value={accForm.name} onChange={(e) => setAccForm({ ...accForm, name: e.target.value })} className={inputCls} placeholder="مصروفات دعاية وتأجير" />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAccOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ الحساب</button>
          </div>
        </form>
      </Modal>

      {/* Rename Account Modal */}
      <Modal open={Boolean(renameTarget)} title={`إعادة تسمية حساب ${renameTarget?.code ?? ''}`} onClose={() => setRenameTarget(null)}>
        <form onSubmit={handleRenameAccount} className="space-y-4">
          <Field label="الاسم الجديد" id="ren-name" required>
            <input id="ren-name" required value={renameVal} onChange={(e) => setRenameVal(e.target.value)} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRenameTarget(null)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ الاسم</button>
          </div>
        </form>
      </Modal>

      {/* Edit Posting Rule Modal */}
      <Modal open={Boolean(ruleTarget)} title="تعديل قاعدة الترحيل الآلي" onClose={() => setRuleTarget(null)}>
        <form onSubmit={handleUpdateRule} className="space-y-4">
          <Field label="وصف القاعدة" id="rl-desc" required>
            <input id="rl-desc" required value={ruleForm.description} onChange={(e) => setRuleForm({ ...ruleForm, description: e.target.value })} className={inputCls} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="الحساب المدين" id="rl-deb">
              <select id="rl-deb" value={ruleForm.debitAccountCode} onChange={(e) => setRuleForm({ ...ruleForm, debitAccountCode: e.target.value })} className={inputCls}>
                {(data?.trialBalance ?? []).map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
              </select>
            </Field>
            <Field label="الحساب الدائن" id="rl-cred">
              <select id="rl-cred" value={ruleForm.creditAccountCode} onChange={(e) => setRuleForm({ ...ruleForm, creditAccountCode: e.target.value })} className={inputCls}>
                {(data?.trialBalance ?? []).map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRuleTarget(null)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ القاعدة</button>
          </div>
        </form>
      </Modal>

      {/* Reverse JE Modal */}
      <Modal open={Boolean(revJeTarget)} title={`عكس القيد ${revJeTarget?.entry_number ?? ''}`} onClose={() => setRevJeTarget(null)}>
        <form onSubmit={handleReverseJe} className="space-y-4">
          <p className="text-xs text-slate-600">سيتم إنشاء قيد عكسي معاكس تماماً بنفس المبالغ للحفاظ على سجل التدقيق دون حذف.</p>
          <Field label="سبب العكس" id="revje-r" required>
            <input id="revje-r" required value={revJeReason} onChange={(e) => setRevJeReason(e.target.value)} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRevJeTarget(null)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={dangerBtnCls}>تأكيد القيد العكسي</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export function ReportsAndNotificationsView({ org }: { org: OrganizationInfo }) {
  const [summary, setSummary] = useState<any>(null);
  const [ntfData, setNtfData] = useState<{ notifications: any[]; templates: any[]; scheduled: any[]; outbox: any[] }>({
    notifications: [],
    templates: [],
    scheduled: [],
    outbox: [],
  });
  const [properties, setProperties] = useState<any[]>([]);
  const [parties, setParties] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [tab, setTab] = useState<'reports' | 'notifications' | 'templates' | 'scheduled'>('reports');
  const [chargeFilter, setChargeFilter] = useState<'ALL' | 'TENANT' | 'OWNER'>('ALL');

  const [ntfOpen, setNtfOpen] = useState(false);
  const [ntfForm, setNtfForm] = useState({
    title: '',
    body: '',
    audienceType: 'ALL',
    audiencePropertyId: '',
    audienceTargetId: '',
    scheduledFor: '',
  });

  const [tplOpen, setTplOpen] = useState(false);
  const [editingTpl, setEditingTpl] = useState<any>(null);
  const [tplForm, setTplForm] = useState({ code: '', name: '', titleTemplate: '', bodyTemplate: '', channel: 'IN_APP_EMAIL' });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [sum, ntf, prp, pty] = await Promise.all([
        apiFetch('/api/reports/summary'),
        apiFetch('/api/notifications'),
        apiFetch('/api/properties'),
        apiFetch('/api/parties'),
      ]);
      setSummary(sum);
      setNtfData({
        notifications: ntf.notifications ?? [],
        templates: ntf.templates ?? [],
        scheduled: ntf.scheduled ?? [],
        outbox: ntf.outbox ?? [],
      });
      setProperties(prp.properties);
      setParties(pty.parties);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSendNotification(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (ntfForm.scheduledFor) {
        await apiFetch('/api/notifications/scheduled', {
          method: 'POST',
          body: JSON.stringify({
            title: ntfForm.title,
            body: ntfForm.body,
            audienceType: ntfForm.audienceType,
            audienceTargetId: ntfForm.audienceTargetId || undefined,
            scheduledFor: ntfForm.scheduledFor,
          }),
        });
        setSuccess('تمت جدولة الإشعار بنجاح.');
      } else {
        const res = await apiFetch<{ recipientCount: number }>('/api/notifications', {
          method: 'POST',
          body: JSON.stringify({
            title: ntfForm.title,
            body: ntfForm.body,
            audienceType: ntfForm.audienceType,
            audienceTargetId: ntfForm.audienceTargetId || undefined,
          }),
        });
        setSuccess(`تم إرسال الإشعار إلى ${res.recipientCount} مستلم.`);
      }
      setNtfOpen(false);
      setNtfForm({ title: '', body: '', audienceType: 'ALL', audiencePropertyId: '', audienceTargetId: '', scheduledFor: '' });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleSaveTemplate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (editingTpl) {
        await apiFetch(`/api/notifications/templates/${editingTpl.id}`, {
          method: 'PUT',
          body: JSON.stringify(tplForm),
        });
        setSuccess('تم تحديث قالب الإشعار.');
      } else {
        await apiFetch('/api/notifications/templates', {
          method: 'POST',
          body: JSON.stringify(tplForm),
        });
        setSuccess('تم إنشاء قالب الإشعار.');
      }
      setTplOpen(false);
      setEditingTpl(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function cancelScheduled(id: string) {
    setError(null);
    try {
      await apiFetch(`/api/notifications/scheduled/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'CANCELLED' }),
      });
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function exportSummaryExcel() {
    if (!summary) return;
    downloadCsvExcel(
      `melaak-summary-${new Date().toISOString().slice(0, 10)}.csv`,
      ['البند', 'القيمة'],
      [
        ['إجمالي الوحدات', summary.occupancy.totalUnits],
        ['وحدات مؤجرة', summary.occupancy.rentedCount],
        ['وحدات شاغرة', summary.occupancy.vacantCount],
        ['وحدات تمليك', summary.occupancy.ownedCount],
        ['على حساب المستأجر', summary.chargeToSummary.onTenantTotal],
        ['على حساب المالك', summary.chargeToSummary.onOwnerTotal],
        ['إجمالي الصيانة', summary.unifiedExpenses.maintenanceTotal],
        ['رواتب الحراس الشهرية', summary.unifiedExpenses.monthlyGuardSalariesTotal],
        ['مكافآت المحصلين المدفوعة', summary.unifiedExpenses.collectorRewardsPaid],
      ],
    );
  }

  function exportChargeDetailsExcel() {
    if (!summary?.chargeToDetails) return;
    downloadCsvExcel(
      `charge-to-details-${new Date().toISOString().slice(0, 10)}.csv`,
      ['المصدر', 'العقار', 'الوحدة', 'البيان', 'على حساب', 'المبلغ', 'المسدد', 'التاريخ'],
      filteredChargeDetails.map((d: any) => [
        d.source,
        d.propertyName,
        d.unitNumber,
        d.description,
        d.chargeTo === 'TENANT' ? 'المستأجر' : 'المالك',
        d.amount,
        d.paidAmount,
        d.date,
      ]),
    );
  }

  const filteredChargeDetails = (summary?.chargeToDetails ?? []).filter(
    (d: any) => chargeFilter === 'ALL' || d.chargeTo === chargeFilter,
  );
  const ntfPropUnits = properties.find((p) => p.id === ntfForm.audiencePropertyId)?.units ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">التقارير والتحليلات والإشعارات والقوالب</h1>
          <p className="text-xs text-slate-500 mt-1">
            تقارير جهة التحميل (Charge-To) · المصروفات الموحدة · استهلاك الخدمات · القوالب والإشعارات المجدولة
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={exportSummaryExcel} className={secondaryBtnCls}>
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>تصدير الملخص Excel</span>
          </button>
          <button type="button" onClick={() => setNtfOpen(true)} className={primaryBtnCls}>
            <Bell className="w-4 h-4" aria-hidden="true" />
            <span>إرسال / جدولة إشعار</span>
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {[
          { id: 'reports', label: 'التقارير التفصيلية' },
          { id: 'notifications', label: `الإشعارات (${ntfData.notifications.length})` },
          { id: 'templates', label: `قوالب الإشعارات (${ntfData.templates.length})` },
          { id: 'scheduled', label: `المجدولة والبريد (${ntfData.scheduled.length})` },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as any)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} />

      {loading ? (
        <LoadingRows />
      ) : tab === 'reports' ? (
        <div className="space-y-6">
          <Panel
            title="تفاصيل مصروفات ورسوم جهة التحميل (على المستأجر مقابل على المالك)"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <select value={chargeFilter} onChange={(e) => setChargeFilter(e.target.value as any)} className="border border-slate-300 rounded px-2 py-1 text-xs">
                  <option value="ALL">الكل ({summary?.chargeToDetails?.length ?? 0})</option>
                  <option value="TENANT">على المستأجر ({formatMoney(summary?.chargeToSummary?.onTenantTotal, org.base_currency)})</option>
                  <option value="OWNER">على المالك ({formatMoney(summary?.chargeToSummary?.onOwnerTotal, org.base_currency)})</option>
                </select>
                <button type="button" onClick={exportChargeDetailsExcel} className={secondaryBtnCls}>
                  <FileSpreadsheet className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Excel</span>
                </button>
              </div>
            }
          >
            <div className="overflow-x-auto max-h-80">
              <table className="w-full text-xs text-right">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 px-2">المصدر</th>
                    <th className="py-2 px-2">العقار / الوحدة</th>
                    <th className="py-2 px-2">البيان</th>
                    <th className="py-2 px-2">على حساب</th>
                    <th className="py-2 px-2">المبلغ</th>
                    <th className="py-2 px-2">المسدد</th>
                    <th className="py-2 px-2">التاريخ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredChargeDetails.map((d: any, i: number) => (
                    <tr key={i}>
                      <td className="py-2 px-2 font-medium">{d.source}</td>
                      <td className="py-2 px-2">{d.propertyName} · {d.unitNumber}</td>
                      <td className="py-2 px-2">{d.description}</td>
                      <td className="py-2 px-2"><StatusText status={d.chargeTo} /></td>
                      <td className="py-2 px-2 font-mono">{formatMoney(d.amount, org.base_currency)}</td>
                      <td className="py-2 px-2 font-mono">{formatMoney(d.paidAmount, org.base_currency)}</td>
                      <td className="py-2 px-2 font-mono">{d.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Panel
              title="تقرير المصروفات الموحدة واستهلاك الخدمات"
              action={
                <button
                  type="button"
                  onClick={() =>
                    downloadCsvExcel(
                      `utility-consumption-${new Date().toISOString().slice(0, 10)}.csv`,
                      ['العقار', 'الوحدة', 'الخدمة', 'إجمالي الاستهلاك'],
                      (summary?.utilityConsumption ?? []).map((u: any) => [u.property_name, u.unit_number || 'مشترك', u.service_name, u.total_consumption]),
                    )
                  }
                  className={secondaryBtnCls}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Excel الاستهلاك</span>
                </button>
              }
            >
              <div className="space-y-2 text-sm">
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="text-slate-600">إجمالي الصيانة (مستأجر + مالك)</span>
                  <span className="font-mono font-medium">{formatMoney(summary?.unifiedExpenses?.maintenanceTotal, org.base_currency)}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="text-slate-600">رواتب الحراس الشهرية (من بطاقات العقارات)</span>
                  <span className="font-mono font-medium">{formatMoney(summary?.unifiedExpenses?.monthlyGuardSalariesTotal, org.base_currency)}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-slate-100">
                  <span className="text-slate-600">مكافآت المحصلين المصروفة</span>
                  <span className="font-mono font-medium">{formatMoney(summary?.unifiedExpenses?.collectorRewardsPaid, org.base_currency)}</span>
                </div>
              </div>

              <div className="mt-5">
                <h4 className="text-xs font-semibold text-slate-700 mb-2">استهلاك الخدمات المسجل</h4>
                {(summary?.utilityConsumption ?? []).length === 0 ? (
                  <p className="text-xs text-slate-500">لا توجد قراءات مسجلة بعد.</p>
                ) : (
                  <div className="space-y-1.5 text-xs">
                    {summary.utilityConsumption.map((uc: any, idx: number) => (
                      <div key={idx} className="flex justify-between py-1 border-b border-slate-100">
                        <span>{uc.property_name} {uc.unit_number ? `· وحدة ${uc.unit_number}` : '(مشترك)'} — {uc.service_name}</span>
                        <span className="font-mono font-semibold">{uc.total_consumption}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Panel>

            <Panel
              title="عمولات الإدارة ومتأخرات الأقساط"
              action={
                <button
                  type="button"
                  onClick={() =>
                    downloadCsvExcel(
                      `commissions-and-overdue-${new Date().toISOString().slice(0, 10)}.csv`,
                      ['العقار', 'نوع العمولة', 'قيمة العمولة', 'الإيجار المحصل', 'مبلغ العمولة المستحق'],
                      (summary?.commissions ?? []).map((c: any) => [c.propertyName, c.commissionType, c.commissionValue, c.collectedRent, c.commissionAmount]),
                    )
                  }
                  className={secondaryBtnCls}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Excel العمولات</span>
                </button>
              }
            >
              <div className="space-y-3 text-xs">
                {(summary?.commissions ?? []).map((c: any) => (
                  <div key={c.propertyId} className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="font-medium text-slate-800">{c.propertyName} ({c.commissionValue}{c.commissionType === 'PERCENT' ? '%' : ''})</span>
                    <span className="font-mono">محصل: {formatMoney(c.collectedRent, org.base_currency)} · عمولة: <strong>{formatMoney(c.commissionAmount, org.base_currency)}</strong></span>
                  </div>
                ))}
                <div className="pt-2">
                  <div className="font-semibold text-slate-700 mb-1">أقساط متأخرة ({summary?.overdueInstallments?.length ?? 0})</div>
                  {(summary?.overdueInstallments ?? []).slice(0, 5).map((i: any) => (
                    <div key={i.id} className="flex justify-between py-1 text-red-700">
                      <span>{i.property_name} وحدة {i.unit_number} ({i.tenant_name})</span>
                      <span className="font-mono">{i.due_date} · {formatMoney(Number(i.amount) - Number(i.paid_amount), org.base_currency)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Panel>
          </div>
        </div>
      ) : tab === 'notifications' ? (
        <Panel title="سجل الإشعارات المرسلة">
          {ntfData.notifications.length === 0 ? (
            <EmptyState title="لا توجد إشعارات" description="أرسل إشعاراً عاماً أو موجهاً لعقار أو وحدة أو مستأجر." />
          ) : (
            <div className="space-y-3">
              {ntfData.notifications.map((n) => (
                <div key={n.id} className="border border-slate-200 rounded-md p-3 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="font-semibold text-slate-900">{n.title}</span>
                    <span className="text-xs font-mono text-slate-500">قراءة: {n.read_count}/{n.recipient_count}</span>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">{n.body}</p>
                </div>
              ))}
            </div>
          )}
        </Panel>
      ) : tab === 'templates' ? (
        <Panel
          title="قوالب الإشعارات القابلة لإعادة الاستخدام"
          action={
            <button
              type="button"
              onClick={() => {
                setEditingTpl(null);
                setTplForm({ code: '', name: '', titleTemplate: '', bodyTemplate: '', channel: 'IN_APP_EMAIL' });
                setTplOpen(true);
              }}
              className={primaryBtnCls}
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>قالب جديد</span>
            </button>
          }
        >
          <div className="space-y-3">
            {ntfData.templates.map((tpl) => (
              <div key={tpl.id} className="border border-slate-200 rounded-md p-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-sm text-slate-900">{tpl.name} <span className="font-mono text-xs text-slate-400">({tpl.code})</span></div>
                  <div className="text-xs text-slate-700 mt-0.5">{tpl.title_template}</div>
                  <div className="text-xs text-slate-500">{tpl.body_template}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setNtfForm({
                        title: tpl.title_template,
                        body: tpl.body_template,
                        audienceType: 'ALL',
                        audiencePropertyId: '',
                        audienceTargetId: '',
                        scheduledFor: '',
                      });
                      setNtfOpen(true);
                    }}
                    className={primaryBtnCls}
                  >
                    استخدام في إشعار
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingTpl(tpl);
                      setTplForm({
                        code: tpl.code,
                        name: tpl.name,
                        titleTemplate: tpl.title_template,
                        bodyTemplate: tpl.body_template,
                        channel: tpl.channel,
                      });
                      setTplOpen(true);
                    }}
                    className={secondaryBtnCls}
                  >
                    تعديل
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel title="الإشعارات المجدولة">
            {ntfData.scheduled.length === 0 ? (
              <EmptyState title="لا توجد إشعارات مجدولة" description="حدد تاريخ جدولة عند إرسال الإشعار ليظهر هنا." />
            ) : (
              <div className="space-y-2.5 text-xs">
                {ntfData.scheduled.map((s) => (
                  <div key={s.id} className="p-3 border border-slate-200 rounded flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-slate-900">{s.title}</div>
                      <div className="text-slate-600">{s.body}</div>
                      <div className="font-mono text-slate-400 mt-1">موعد الإرسال: {s.scheduled_for}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusText status={s.status} />
                      {s.status === 'SCHEDULED' && (
                        <button type="button" onClick={() => cancelScheduled(s.id)} className={dangerBtnCls}>إلغاء</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <Panel title="سجل البريد الصادر للمنشأة">
            {ntfData.outbox.length === 0 ? (
              <p className="text-xs text-slate-500">لا توجد رسائل بريد صادر مسجلة.</p>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto text-xs">
                {ntfData.outbox.map((m) => (
                  <div key={m.id} className="p-2.5 border border-slate-200 rounded">
                    <div className="flex justify-between font-medium">
                      <span>{m.subject}</span>
                      <span className="font-mono text-slate-500">{m.recipient_email}</span>
                    </div>
                    <p className="text-slate-600 mt-1">{m.body}</p>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}

      {/* Send / Schedule Notification Modal */}
      <Modal open={ntfOpen} title="إرسال أو جدولة إشعار" onClose={() => setNtfOpen(false)}>
        <form onSubmit={handleSendNotification} className="space-y-4">
          <Field label="الجمهور المستهدف" id="ntf-aud">
            <select
              id="ntf-aud"
              value={ntfForm.audienceType}
              onChange={(e) => setNtfForm({ ...ntfForm, audienceType: e.target.value, audiencePropertyId: '', audienceTargetId: '' })}
              className={inputCls}
            >
              <option value="ALL">جميع الأطراف في المنشأة</option>
              <option value="PROPERTY">مستأجرو وملاك عقار محدد</option>
              <option value="UNIT">وحدة محددة</option>
              <option value="PARTY">طرف محدد</option>
            </select>
          </Field>
          {ntfForm.audienceType === 'PROPERTY' && (
            <Field label="العقار" id="ntf-prop" required>
              <select id="ntf-prop" required value={ntfForm.audienceTargetId} onChange={(e) => setNtfForm({ ...ntfForm, audienceTargetId: e.target.value })} className={inputCls}>
                <option value="">اختر...</option>
                {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          )}
          {ntfForm.audienceType === 'UNIT' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="العقار" id="ntf-u-prop" required>
                <select id="ntf-u-prop" required value={ntfForm.audiencePropertyId} onChange={(e) => setNtfForm({ ...ntfForm, audiencePropertyId: e.target.value, audienceTargetId: '' })} className={inputCls}>
                  <option value="">اختر...</option>
                  {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="الوحدة" id="ntf-unit" required>
                <select id="ntf-unit" required value={ntfForm.audienceTargetId} onChange={(e) => setNtfForm({ ...ntfForm, audienceTargetId: e.target.value })} className={inputCls}>
                  <option value="">اختر...</option>
                  {ntfPropUnits.map((u: any) => <option key={u.id} value={u.id}>وحدة {u.unit_number}</option>)}
                </select>
              </Field>
            </div>
          )}
          {ntfForm.audienceType === 'PARTY' && (
            <Field label="الطرف" id="ntf-party" required>
              <select id="ntf-party" required value={ntfForm.audienceTargetId} onChange={(e) => setNtfForm({ ...ntfForm, audienceTargetId: e.target.value })} className={inputCls}>
                <option value="">اختر...</option>
                {parties.map((pa) => <option key={pa.id} value={pa.id}>{pa.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="عنوان الإشعار" id="ntf-title" required>
            <input id="ntf-title" required value={ntfForm.title} onChange={(e) => setNtfForm({ ...ntfForm, title: e.target.value })} className={inputCls} />
          </Field>
          <Field label="نص الإشعار" id="ntf-body" required>
            <textarea id="ntf-body" rows={3} required value={ntfForm.body} onChange={(e) => setNtfForm({ ...ntfForm, body: e.target.value })} className={inputCls} />
          </Field>
          <Field label="جدولة لوقت لاحق (اختياري — اتركه فارغاً للإرسال الفوري)" id="ntf-sched">
            <input id="ntf-sched" type="datetime-local" value={ntfForm.scheduledFor} onChange={(e) => setNtfForm({ ...ntfForm, scheduledFor: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setNtfOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>
              {ntfForm.scheduledFor ? <CalendarClock className="w-4 h-4" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
              <span>{ntfForm.scheduledFor ? 'جدولة الإشعار' : 'إرسال فوري'}</span>
            </button>
          </div>
        </form>
      </Modal>

      {/* Notification Template Modal */}
      <Modal open={tplOpen} title={editingTpl ? 'تعديل قالب إشعار' : 'إنشاء قالب إشعار'} onClose={() => setTplOpen(false)}>
        <form onSubmit={handleSaveTemplate} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="الرمز" id="tpl-code" required>
              <input id="tpl-code" required disabled={Boolean(editingTpl)} dir="ltr" value={tplForm.code} onChange={(e) => setTplForm({ ...tplForm, code: e.target.value })} className={inputCls} placeholder="MAINT_NOTICE" />
            </Field>
            <Field label="اسم القالب" id="tpl-name" required>
              <input id="tpl-name" required value={tplForm.name} onChange={(e) => setTplForm({ ...tplForm, name: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <Field label="عنوان الإشعار الافتراضي" id="tpl-title" required>
            <input id="tpl-title" required value={tplForm.titleTemplate} onChange={(e) => setTplForm({ ...tplForm, titleTemplate: e.target.value })} className={inputCls} />
          </Field>
          <Field label="نص القالب" id="tpl-body" required>
            <textarea id="tpl-body" rows={3} required value={tplForm.bodyTemplate} onChange={(e) => setTplForm({ ...tplForm, bodyTemplate: e.target.value })} className={inputCls} />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setTplOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ القالب</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export function OrgSettingsView({
  user,
  org,
  onOrgUpdated,
}: {
  user: AuthUser;
  org: OrganizationInfo;
  onOrgUpdated?: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [properties, setProperties] = useState<any[]>([]);
  const [collectors, setCollectors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);

  const [twoFactorEnabled, setTwoFactorEnabled] = useState(Boolean(user.twoFactorEnabled));

  const [settingsForm, setSettingsForm] = useState({
    name: org.name,
    defaultGraceDays: String(org.default_grace_days),
    postGraceRentEnabled: Boolean(org.post_grace_rent_enabled),
    roundingStep: org.rounding_step ?? '',
    contractExpiryAlertDays: String(org.contract_expiry_alert_days),
    showHijriDates: Boolean(org.show_hijri_dates),
    retentionYears: String(org.retention_years ?? 10),
  });

  const [userForm, setUserForm] = useState({
    role: 'COLLECTOR',
    fullName: '',
    email: '',
    password: '',
    canCollectRent: true,
    canCollectServices: true,
    canCollectMaintenance: false,
    canCreateServices: false,
    rewardType: 'NONE',
    rewardValue: '0',
    assignedPropertyIds: [] as string[],
    staffPermissions: createEmptyMatrix(false),
  });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [sRes, pRes, cRes] = await Promise.all([
        apiFetch('/api/settings'),
        apiFetch('/api/properties'),
        apiFetch('/api/collections').catch(() => ({ collectors: [] })),
      ]);
      setData(sRes);
      setProperties(pRes.properties);
      setCollectors(cRes.collectors ?? []);
      if (sRes.organization) {
        setSettingsForm({
          name: sRes.organization.name,
          defaultGraceDays: String(sRes.organization.default_grace_days),
          postGraceRentEnabled: Boolean(sRes.organization.post_grace_rent_enabled),
          roundingStep: sRes.organization.rounding_step ?? '',
          contractExpiryAlertDays: String(sRes.organization.contract_expiry_alert_days),
          showHijriDates: Boolean(sRes.organization.show_hijri_dates),
          retentionYears: String(sRes.organization.retention_years ?? 10),
        });
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

  async function saveOrgSettings(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          ...settingsForm,
          defaultGraceDays: Number(settingsForm.defaultGraceDays),
          contractExpiryAlertDays: Number(settingsForm.contractExpiryAlertDays),
          retentionYears: Number(settingsForm.retentionYears),
          roundingStep: settingsForm.roundingStep || null,
        }),
      });
      setSuccess('تم حفظ إعدادات المنشأة بنجاح.');
      await load();
      onOrgUpdated?.();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function toggleMy2FA() {
    setError(null);
    try {
      const res = await apiFetch<{ twoFactorEnabled: boolean }>('/api/auth/2fa/toggle', {
        method: 'POST',
        body: JSON.stringify({ enabled: !twoFactorEnabled }),
      });
      setTwoFactorEnabled(res.twoFactorEnabled);
      setSuccess(res.twoFactorEnabled ? 'تم تفعيل التحقق بخطوتين (2FA) لحسابك.' : 'تم إيقاف التحقق بخطوتين.');
      onOrgUpdated?.();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          role: userForm.role,
          fullName: userForm.fullName,
          email: userForm.email,
          password: userForm.password,
          staffPermissions: userForm.role === 'STAFF' ? userForm.staffPermissions : undefined,
          collectorFlags: {
            canCollectRent: userForm.canCollectRent,
            canCollectServices: userForm.canCollectServices,
            canCollectMaintenance: userForm.canCollectMaintenance,
            canCreateServices: userForm.canCreateServices,
          },
          rewardType: userForm.rewardType,
          rewardValue: userForm.rewardValue,
          assignedPropertyIds: userForm.assignedPropertyIds,
        }),
      });
      setCreateOpen(false);
      setUserForm({
        role: 'COLLECTOR',
        fullName: '',
        email: '',
        password: '',
        canCollectRent: true,
        canCollectServices: true,
        canCollectMaintenance: false,
        canCreateServices: false,
        rewardType: 'NONE',
        rewardValue: '0',
        assignedPropertyIds: [],
        staffPermissions: createEmptyMatrix(false),
      });
      setSuccess('تم إنشاء الحساب وتطبيق مصفوفة الصلاحيات بنجاح.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function openEditUserModal(u: any) {
    const col = collectors.find((c) => c.user_id === u.id);
    setEditingUser(u);
    setUserForm({
      role: u.role,
      fullName: u.full_name,
      email: u.email,
      password: '',
      canCollectRent: Boolean(col?.can_collect_rent),
      canCollectServices: Boolean(col?.can_collect_services),
      canCollectMaintenance: Boolean(col?.can_collect_maintenance),
      canCreateServices: Boolean(col?.can_create_services),
      rewardType: col?.reward_type || 'NONE',
      rewardValue: String(col?.reward_value ?? '0'),
      assignedPropertyIds: (col?.assignedProperties ?? []).map((ap: any) => ap.property_id),
      staffPermissions: u.staffPermissions || createEmptyMatrix(false),
    });
  }

  async function handleUpdateUserPerms(e: React.FormEvent) {
    e.preventDefault();
    if (!editingUser) return;
    setError(null);
    try {
      await apiFetch(`/api/users/${editingUser.id}`, {
        method: 'PATCH',
        body: JSON.stringify(
          editingUser.role === 'STAFF'
            ? { staffPermissions: userForm.staffPermissions }
            : {
                collectorFlags: {
                  canCollectRent: userForm.canCollectRent,
                  canCollectServices: userForm.canCollectServices,
                  canCollectMaintenance: userForm.canCollectMaintenance,
                  canCreateServices: userForm.canCreateServices,
                },
                rewardType: userForm.rewardType,
                rewardValue: userForm.rewardValue,
                assignedPropertyIds: userForm.assignedPropertyIds,
              },
        ),
      });
      setEditingUser(null);
      setSuccess('تم تحديث صلاحيات المستخدم وتطبيقها فوراً.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function toggleUserActive(u: any) {
    setError(null);
    try {
      await apiFetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !u.is_active }),
      });
      setSuccess('تم تحديث حالة المستخدم وسريانه الفوري.');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">إعدادات المنشأة والمستخدمين ومصفوفة الصلاحيات وسجل التدقيق</h1>
          <p className="text-xs text-slate-500 mt-1">إعدادات المنشأة والمهل والتقريب والحفظ القانوني · إدارة الموظفين بمصفوفة صلاحيات 11×4</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {user.role === 'OWNER' && (
            <>
              <button type="button" onClick={toggleMy2FA} className={secondaryBtnCls}>
                <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                <span>{twoFactorEnabled ? 'إيقاف 2FA لحسابي' : 'تفعيل المصادقة الثنائية (2FA)'}</span>
              </button>
              <button type="button" onClick={() => setCreateOpen(true)} className={primaryBtnCls}>
                <UserPlus className="w-4 h-4" aria-hidden="true" />
                <span>إضافة محصل أو موظف</span>
              </button>
            </>
          )}
        </div>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} />

      {loading ? (
        <LoadingRows />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel title="إعدادات القواعد والمهل والاحتفاظ بالبيانات">
            <form onSubmit={saveOrgSettings} className="space-y-4">
              <Field label="اسم المنشأة" id="org-set-name">
                <input id="org-set-name" value={settingsForm.name} onChange={(e) => setSettingsForm({ ...settingsForm, name: e.target.value })} className={inputCls} />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="مهلة الإخلاء (أيام)" id="org-set-grace">
                  <input id="org-set-grace" type="number" min={0} value={settingsForm.defaultGraceDays} onChange={(e) => setSettingsForm({ ...settingsForm, defaultGraceDays: e.target.value })} className={inputCls} />
                </Field>
                <Field label="تنبيه العقد (أيام)" id="org-set-exp">
                  <input id="org-set-exp" type="number" min={1} value={settingsForm.contractExpiryAlertDays} onChange={(e) => setSettingsForm({ ...settingsForm, contractExpiryAlertDays: e.target.value })} className={inputCls} />
                </Field>
                <Field label="الاحتفاظ المالي (سنوات)" id="org-set-ret">
                  <input id="org-set-ret" type="number" min={1} value={settingsForm.retentionYears} onChange={(e) => setSettingsForm({ ...settingsForm, retentionYears: e.target.value })} className={inputCls} />
                </Field>
              </div>
              <Field label="خطوة التقريب للأقساط (فارغ = دقيق 0.01)" id="org-set-round">
                <input id="org-set-round" value={settingsForm.roundingStep} onChange={(e) => setSettingsForm({ ...settingsForm, roundingStep: e.target.value })} className={inputCls} placeholder="اتركه فارغاً للدقة الكاملة" />
              </Field>
              <div className="space-y-2 text-xs">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={settingsForm.postGraceRentEnabled} onChange={(e) => setSettingsForm({ ...settingsForm, postGraceRentEnabled: e.target.checked })} />
                  <span>احتساب إيجار يومي بعد انتهاء مهلة الإخلاء دون تسليم</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={settingsForm.showHijriDates} onChange={(e) => setSettingsForm({ ...settingsForm, showHijriDates: e.target.checked })} />
                  <span>عرض التاريخ الهجري بجانب الميلادي</span>
                </label>
              </div>
              {user.role === 'OWNER' && (
                <button type="submit" className={primaryBtnCls}>حفظ الإعدادات</button>
              )}
            </form>
          </Panel>

          <Panel title="مستخدمو المنشأة والصلاحيات">
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {(data?.users ?? []).map((u: any) => (
                <div key={u.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 border-b border-slate-100 text-sm">
                  <div>
                    <div className="font-medium text-slate-900">{u.full_name}</div>
                    <div className="text-xs text-slate-500 font-mono">
                      {ROLE_LABELS[u.role] ?? u.role} · {u.email}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusText status={u.is_active ? 'ACTIVE' : 'SUSPENDED'} />
                    {user.role === 'OWNER' && (u.role === 'STAFF' || u.role === 'COLLECTOR') && (
                      <button type="button" onClick={() => openEditUserModal(u)} className={secondaryBtnCls}>
                        <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>صلاحيات</span>
                      </button>
                    )}
                    {user.role === 'OWNER' && u.role !== 'OWNER' && (
                      <button type="button" onClick={() => toggleUserActive(u)} className={secondaryBtnCls}>
                        {u.is_active ? 'إيقاف فوري' : 'تفعيل'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="سجل التدقيق (للإلحاق فقط)" className="lg:col-span-2">
            <div className="overflow-x-auto max-h-72 overflow-y-auto">
              <table className="w-full text-xs text-right">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 px-2">الوقت</th>
                    <th className="py-2 px-2">المستخدم</th>
                    <th className="py-2 px-2">الكيان</th>
                    <th className="py-2 px-2">الإجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(data?.auditLogs ?? []).map((l: any) => (
                    <tr key={l.id}>
                      <td className="py-1.5 px-2 font-mono">{l.created_at.slice(0, 19).replace('T', ' ')}</td>
                      <td className="py-1.5 px-2">{l.actor_name || l.user_id}</td>
                      <td className="py-1.5 px-2 font-mono">{l.entity_type}</td>
                      <td className="py-1.5 px-2 font-medium text-teal-800">{l.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}

      {/* Create Staff or Collector Modal */}
      <Modal open={createOpen} title="إضافة محصل أو موظف بمصفوفة الصلاحيات" onClose={() => setCreateOpen(false)} wide>
        <form onSubmit={handleCreateUser} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="الدور" id="usr-role">
              <select id="usr-role" value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })} className={inputCls}>
                <option value="COLLECTOR">محصل (Collector)</option>
                <option value="STAFF">موظف إدارة (Staff)</option>
              </select>
            </Field>
            <Field label="الاسم الكامل" id="usr-name" required>
              <input id="usr-name" required value={userForm.fullName} onChange={(e) => setUserForm({ ...userForm, fullName: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="البريد الإلكتروني" id="usr-email" required>
              <input id="usr-email" type="email" required dir="ltr" value={userForm.email} onChange={(e) => setUserForm({ ...userForm, email: e.target.value })} className={inputCls} />
            </Field>
            <Field label="كلمة المرور (12+ حرفاً)" id="usr-pass" required>
              <input id="usr-pass" type="password" minLength={12} required dir="ltr" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} className={inputCls} />
            </Field>
          </div>

          {userForm.role === 'COLLECTOR' ? (
            <div className="space-y-3 border-t border-slate-200 pt-3">
              <div className="text-xs font-semibold text-slate-800">أعلام صلاحيات المحصل والمكافأة والعقارات المسندة</div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={userForm.canCollectRent} onChange={(e) => setUserForm({ ...userForm, canCollectRent: e.target.checked })} />
                  <span>تحصيل الإيجار</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={userForm.canCollectServices} onChange={(e) => setUserForm({ ...userForm, canCollectServices: e.target.checked })} />
                  <span>تحصيل الخدمات</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={userForm.canCollectMaintenance} onChange={(e) => setUserForm({ ...userForm, canCollectMaintenance: e.target.checked })} />
                  <span>تحصيل الصيانة</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={userForm.canCreateServices} onChange={(e) => setUserForm({ ...userForm, canCreateServices: e.target.checked })} />
                  <span>إنشاء فواتير خدمات</span>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="نوع مكافأة المحصل" id="usr-rew-t">
                  <select id="usr-rew-t" value={userForm.rewardType} onChange={(e) => setUserForm({ ...userForm, rewardType: e.target.value })} className={inputCls}>
                    <option value="NONE">بدون مكافأة</option>
                    <option value="PERCENT">نسبة من التحصيل (%)</option>
                    <option value="FIXED">مكافأة ثابتة</option>
                  </select>
                </Field>
                <Field label="قيمة المكافأة" id="usr-rew-v">
                  <input id="usr-rew-v" type="number" step="0.01" value={userForm.rewardValue} onChange={(e) => setUserForm({ ...userForm, rewardValue: e.target.value })} className={inputCls} />
                </Field>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-600 block">العقارات المسندة:</span>
                <div className="flex flex-wrap gap-3">
                  {properties.map((p) => (
                    <label key={p.id} className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={userForm.assignedPropertyIds.includes(p.id)}
                        onChange={(e) =>
                          setUserForm((f) => ({
                            ...f,
                            assignedPropertyIds: e.target.checked
                              ? [...f.assignedPropertyIds, p.id]
                              : f.assignedPropertyIds.filter((x) => x !== p.id),
                          }))
                        }
                      />
                      <span>{p.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="border-t border-slate-200 pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800">مصفوفة صلاحيات الموظف (11 مجال × 4 إجراءات)</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setUserForm({ ...userForm, staffPermissions: createEmptyMatrix(true) })} className={secondaryBtnCls}>تحديد الكل</button>
                  <button type="button" onClick={() => setUserForm({ ...userForm, staffPermissions: createEmptyMatrix(false) })} className={secondaryBtnCls}>إلغاء الكل</button>
                </div>
              </div>
              <div className="overflow-x-auto max-h-64 border border-slate-200 rounded">
                <table className="w-full text-xs text-right">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="py-1.5 px-2">المجال</th>
                      <th className="py-1.5 px-2 text-center">قراءة</th>
                      <th className="py-1.5 px-2 text-center">إنشاء</th>
                      <th className="py-1.5 px-2 text-center">تعديل</th>
                      <th className="py-1.5 px-2 text-center">حذف</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {STAFF_DOMAIN_LABELS.map((d) => (
                      <tr key={d.key}>
                        <td className="py-1.5 px-2 font-medium">{d.label}</td>
                        {(['read', 'create', 'update', 'delete'] as const).map((act) => (
                          <td key={act} className="py-1.5 px-2 text-center">
                            <input
                              type="checkbox"
                              checked={Boolean(userForm.staffPermissions?.[d.key]?.[act])}
                              onChange={(e) =>
                                setUserForm((f) => ({
                                  ...f,
                                  staffPermissions: {
                                    ...f.staffPermissions,
                                    [d.key]: { ...f.staffPermissions[d.key], [act]: e.target.checked },
                                  },
                                }))
                              }
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCreateOpen(false)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>إنشاء الحساب</button>
          </div>
        </form>
      </Modal>

      {/* Edit Staff / Collector Permissions Modal */}
      <Modal
        open={Boolean(editingUser)}
        title={`تعديل صلاحيات: ${editingUser?.full_name ?? ''}`}
        onClose={() => setEditingUser(null)}
        wide
      >
        <form onSubmit={handleUpdateUserPerms} className="space-y-4">
          {editingUser?.role === 'STAFF' ? (
            <div className="overflow-x-auto max-h-72 border border-slate-200 rounded">
              <table className="w-full text-xs text-right">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="py-1.5 px-2">المجال</th>
                    <th className="py-1.5 px-2 text-center">قراءة</th>
                    <th className="py-1.5 px-2 text-center">إنشاء</th>
                    <th className="py-1.5 px-2 text-center">تعديل</th>
                    <th className="py-1.5 px-2 text-center">حذف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {STAFF_DOMAIN_LABELS.map((d) => (
                    <tr key={d.key}>
                      <td className="py-1.5 px-2 font-medium">{d.label}</td>
                      {(['read', 'create', 'update', 'delete'] as const).map((act) => (
                        <td key={act} className="py-1.5 px-2 text-center">
                          <input
                            type="checkbox"
                            checked={Boolean(userForm.staffPermissions?.[d.key]?.[act])}
                            onChange={(e) =>
                              setUserForm((f) => ({
                                ...f,
                                staffPermissions: {
                                  ...f.staffPermissions,
                                  [d.key]: { ...f.staffPermissions[d.key], [act]: e.target.checked },
                                },
                              }))
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={userForm.canCollectRent} onChange={(e) => setUserForm({ ...userForm, canCollectRent: e.target.checked })} />
                  <span>تحصيل الإيجار</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={userForm.canCollectServices} onChange={(e) => setUserForm({ ...userForm, canCollectServices: e.target.checked })} />
                  <span>تحصيل الخدمات</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={userForm.canCollectMaintenance} onChange={(e) => setUserForm({ ...userForm, canCollectMaintenance: e.target.checked })} />
                  <span>تحصيل الصيانة</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={userForm.canCreateServices} onChange={(e) => setUserForm({ ...userForm, canCreateServices: e.target.checked })} />
                  <span>إنشاء فواتير خدمات</span>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="نوع مكافأة المحصل" id="ed-rew-t">
                  <select id="ed-rew-t" value={userForm.rewardType} onChange={(e) => setUserForm({ ...userForm, rewardType: e.target.value })} className={inputCls}>
                    <option value="NONE">بدون مكافأة</option>
                    <option value="PERCENT">نسبة من التحصيل (%)</option>
                    <option value="FIXED">مكافأة ثابتة</option>
                  </select>
                </Field>
                <Field label="قيمة المكافأة" id="ed-rew-v">
                  <input id="ed-rew-v" type="number" step="0.01" value={userForm.rewardValue} onChange={(e) => setUserForm({ ...userForm, rewardValue: e.target.value })} className={inputCls} />
                </Field>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-600 block">العقارات المسندة:</span>
                <div className="flex flex-wrap gap-3">
                  {properties.map((p) => (
                    <label key={p.id} className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={userForm.assignedPropertyIds.includes(p.id)}
                        onChange={(e) =>
                          setUserForm((f) => ({
                            ...f,
                            assignedPropertyIds: e.target.checked
                              ? [...f.assignedPropertyIds, p.id]
                              : f.assignedPropertyIds.filter((x) => x !== p.id),
                          }))
                        }
                      />
                      <span>{p.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditingUser(null)} className={secondaryBtnCls}>إلغاء</button>
            <button type="submit" className={primaryBtnCls}>حفظ الصلاحيات</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
