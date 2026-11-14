import React, { useState } from 'react';
import { Building2, KeyRound, Lock } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { ErrorBanner, Field, inputCls, Modal, primaryBtnCls, secondaryBtnCls, SuccessBanner } from './UiPrimitives';

const DEMO_ACCOUNTS = [
  { label: 'مالك العقار (الواحة)', email: 'owner@waha.sa', pass: 'OwnerPass123456', role: 'OWNER' },
  { label: 'مالك النظام (المنصة)', email: 'admin@melaak.sa', pass: 'AdminPass123456', role: 'SUPER_ADMIN' },
  { label: 'موظف الإدارة', email: 'staff@waha.sa', pass: 'StaffPass123456', role: 'STAFF' },
  { label: 'المحصّل الميداني', email: 'collector@waha.sa', pass: 'CollectorPass123456', role: 'COLLECTOR' },
  { label: 'بوابة المستأجر', email: 'renter@waha.sa', pass: 'RenterPass123456', role: 'RENTER' },
  { label: 'مالك وحدة التمليك', email: 'unitowner@waha.sa', pass: 'UnitOwnerPass123456', role: 'UNIT_OWNER' },
  { label: 'منشأة ثانية (المدار)', email: 'owner2@madar.sa', pass: 'OwnerPass123456', role: 'OWNER' },
];

export function LoginView({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('owner@waha.sa');
  const [password, setPassword] = useState('OwnerPass123456');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // FR-IAM-07: 2FA Challenge step
  const [twoFaChallengeToken, setTwoFaChallengeToken] = useState<string | null>(null);
  const [twoFaOtp, setTwoFaOtp] = useState('');
  const [devTwoFaHint, setDevTwoFaHint] = useState<string | null>(null);

  // FR-IAM-03: Password Reset Request & Confirm
  const [resetOpen, setResetOpen] = useState(false);
  const [resetStep, setResetStep] = useState<'request' | 'confirm'>('request');
  const [resetEmail, setResetEmail] = useState('');
  const [resetOtp, setResetOtp] = useState('');
  const [resetNewPass, setResetNewPass] = useState('');
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetErr, setResetErr] = useState<string | null>(null);

  async function submitLogin(e?: React.FormEvent, overrideEmail?: string, overridePass?: string) {
    if (e) e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<any>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: overrideEmail ?? email,
          password: overridePass ?? password,
        }),
      });
      if (res.requiresTwoFactor && res.challengeToken) {
        setTwoFaChallengeToken(res.challengeToken);
        setDevTwoFaHint(res.devOtp ?? null);
        setTwoFaOtp('');
        return;
      }
      onLoggedIn();
    } catch (err: any) {
      setError(err.message || 'تعذر تسجيل الدخول');
    } finally {
      setLoading(false);
    }
  }

  async function submitTwoFactor(e: React.FormEvent) {
    e.preventDefault();
    if (!twoFaChallengeToken) return;
    setError(null);
    setLoading(true);
    try {
      await apiFetch('/api/auth/login/verify-2fa', {
        method: 'POST',
        body: JSON.stringify({ challengeToken: twoFaChallengeToken, otp: twoFaOtp }),
      });
      setTwoFaChallengeToken(null);
      onLoggedIn();
    } catch (err: any) {
      setError(err.message || 'رمز التحقق الثنائي غير صحيح');
    } finally {
      setLoading(false);
    }
  }

  async function submitResetRequest(e: React.FormEvent) {
    e.preventDefault();
    setResetMsg(null);
    setResetErr(null);
    try {
      const res = await apiFetch<{ message: string }>('/api/auth/password-reset/request', {
        method: 'POST',
        body: JSON.stringify({ email: resetEmail }),
      });
      setResetMsg(res.message);
      setResetStep('confirm');
    } catch (err: any) {
      setResetErr(err.message);
    }
  }

  async function submitResetConfirm(e: React.FormEvent) {
    e.preventDefault();
    setResetMsg(null);
    setResetErr(null);
    try {
      await apiFetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        body: JSON.stringify({ email: resetEmail, otp: resetOtp, newPassword: resetNewPass }),
      });
      setResetMsg('تم تحديث كلمة المرور بنجاح، يمكنك الآن تسجيل الدخول.');
      setResetStep('request');
      setResetOtp('');
      setResetNewPass('');
    } catch (err: any) {
      setResetErr(err.message);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col justify-center py-10 px-4 sm:px-6">
      <div className="max-w-4xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-8 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2.5 text-teal-800">
              <Building2 className="w-6 h-6 shrink-0" aria-hidden="true" />
              <span className="text-xl font-bold tracking-tight text-slate-900">مِلاك لإدارة العقارات</span>
            </div>
            <h1 className="mt-6 text-2xl font-bold text-slate-900 leading-snug">
              {twoFaChallengeToken ? 'التحقق الثنائي لحسابك' : 'تسجيل الدخول إلى المنصة'}
            </h1>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              منظومة متكاملة لعزل المنشآت، العقود والأقساط الدقيقة، الفوترة والعدادات، الإخلاء والتسوية، والمحاسبة الآلية بالقيد المزدوج.
            </p>

            {twoFaChallengeToken ? (
              <form onSubmit={submitTwoFactor} className="mt-6 space-y-4">
                <ErrorBanner message={error} onDismiss={() => setError(null)} />
                {devTwoFaHint && (
                  <div className="p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-md text-xs">
                    رمز التحقق لبيئة التطوير (أُرسل لسجل البريد): <span className="font-mono font-bold">{devTwoFaHint}</span>
                  </div>
                )}
                <Field label="رمز التحقق الثنائي (OTP)" id="login-2fa-otp" required>
                  <input
                    id="login-2fa-otp"
                    required
                    value={twoFaOtp}
                    onChange={(e) => setTwoFaOtp(e.target.value)}
                    className={inputCls}
                    dir="ltr"
                    placeholder="123456"
                  />
                </Field>
                <div className="flex items-center gap-2">
                  <button type="submit" disabled={loading} className={primaryBtnCls}>
                    تأكيد الدخول
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTwoFaChallengeToken(null);
                      setError(null);
                    }}
                    className={secondaryBtnCls}
                  >
                    رجوع
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={(e) => submitLogin(e)} className="mt-6 space-y-4">
                <ErrorBanner message={error} onDismiss={() => setError(null)} />

                <Field label="البريد الإلكتروني" id="login-email" required>
                  <input
                    id="login-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={inputCls}
                    dir="ltr"
                    placeholder="name@company.sa"
                  />
                </Field>

                <Field label="كلمة المرور" id="login-password" required>
                  <input
                    id="login-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={inputCls}
                    dir="ltr"
                    placeholder="••••••••••••"
                  />
                </Field>

                <div className="flex items-center justify-between pt-2 gap-4">
                  <button type="submit" disabled={loading} className={`${primaryBtnCls} w-full sm:w-auto`}>
                    <Lock className="w-4 h-4" aria-hidden="true" />
                    <span>{loading ? 'جاري التحقق...' : 'دخول آمن'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setResetStep('request');
                      setResetMsg(null);
                      setResetErr(null);
                      setResetOpen(true);
                    }}
                    className="text-xs font-medium text-teal-700 hover:text-teal-900 whitespace-nowrap"
                  >
                    استعادة كلمة المرور
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="mt-8 pt-5 border-t border-slate-200 text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
            <span>تجزئة bcrypt لكلمات المرور</span>
            <span aria-hidden="true">·</span>
            <span>فحص الجلسة والصلاحية في كل طلب</span>
            <span aria-hidden="true">·</span>
            <span>عزل كامل للمنشآت</span>
          </div>
        </div>

        <aside className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">حسابات الاختبار الجاهزة لجميع الأدوار</h2>
            <p className="text-xs text-slate-500 mt-1">
              انقر على أي دور لتسجيل الدخول الفعلي عبر الخادم والتحقق من الصلاحيات والبوابات:
            </p>
            <div className="mt-4 space-y-2">
              {DEMO_ACCOUNTS.map((acc) => (
                <button
                  key={acc.email}
                  type="button"
                  onClick={() => {
                    setEmail(acc.email);
                    setPassword(acc.pass);
                    submitLogin(undefined, acc.email, acc.pass);
                  }}
                  className="w-full text-right px-3.5 py-2.5 border border-slate-200 hover:border-teal-700 hover:bg-teal-50/40 rounded-md transition-colors flex items-center justify-between gap-3"
                >
                  <span className="text-sm font-medium text-slate-800">{acc.label}</span>
                  <span className="text-xs font-mono text-slate-500" dir="ltr">
                    {acc.email}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-200 text-xs text-slate-500">
            كلمات المرور الافتراضية للحسابات أعلاه مطابقة لسياسة المنصة (12+ حرفاً).
          </div>
        </aside>
      </div>

      <Modal open={resetOpen} title="استعادة كلمة المرور" onClose={() => setResetOpen(false)}>
        <div className="space-y-4">
          <ErrorBanner message={resetErr} onDismiss={() => setResetErr(null)} />
          <SuccessBanner message={resetMsg} onDismiss={() => setResetMsg(null)} />
          <div className="flex gap-2 border-b border-slate-200 pb-2 text-xs">
            <button
              type="button"
              onClick={() => setResetStep('request')}
              className={resetStep === 'request' ? 'font-bold text-teal-800' : 'text-slate-500'}
            >
              1. طلب رمز التحقق
            </button>
            <span className="text-slate-300">/</span>
            <button
              type="button"
              onClick={() => setResetStep('confirm')}
              className={resetStep === 'confirm' ? 'font-bold text-teal-800' : 'text-slate-500'}
            >
              2. إدخال الرمز وتعيين كلمة مرور جديدة
            </button>
          </div>

          {resetStep === 'request' ? (
            <form onSubmit={submitResetRequest} className="space-y-4">
              <Field label="البريد الإلكتروني المسجل" id="reset-email" required>
                <input
                  id="reset-email"
                  type="email"
                  required
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  className={inputCls}
                  dir="ltr"
                />
              </Field>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setResetOpen(false)} className={secondaryBtnCls}>
                  إلغاء
                </button>
                <button type="submit" className={primaryBtnCls}>
                  <KeyRound className="w-4 h-4" aria-hidden="true" />
                  <span>إرسال رمز التحقق</span>
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={submitResetConfirm} className="space-y-4">
              <Field label="البريد الإلكتروني" id="reset-confirm-email" required>
                <input
                  id="reset-confirm-email"
                  type="email"
                  required
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  className={inputCls}
                  dir="ltr"
                />
              </Field>
              <Field label="رمز التحقق (OTP)" id="reset-confirm-otp" required>
                <input
                  id="reset-confirm-otp"
                  required
                  value={resetOtp}
                  onChange={(e) => setResetOtp(e.target.value)}
                  className={inputCls}
                  dir="ltr"
                />
              </Field>
              <Field label="كلمة المرور الجديدة (12 حرفاً فأكثر)" id="reset-confirm-pass" required>
                <input
                  id="reset-confirm-pass"
                  type="password"
                  minLength={12}
                  required
                  value={resetNewPass}
                  onChange={(e) => setResetNewPass(e.target.value)}
                  className={inputCls}
                  dir="ltr"
                />
              </Field>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setResetOpen(false)} className={secondaryBtnCls}>
                  إغلاق
                </button>
                <button type="submit" className={primaryBtnCls}>
                  حفظ كلمة المرور الجديدة
                </button>
              </div>
            </form>
          )}
        </div>
      </Modal>
    </div>
  );
}
