import React from 'react';
import { AlertCircle, CheckCircle2, Clock, MinusCircle, X } from 'lucide-react';
import { STATUS_LABELS } from '../lib/api';

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-white border border-slate-200 rounded-lg ${className}`}>
      {(title || action) && (
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 border-b border-slate-200">
          <div>
            {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
            {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          {action && <div className="flex items-center gap-2 shrink-0">{action}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function StatusText({ status }: { status: string }) {
  const info = STATUS_LABELS[status] ?? { label: status, tone: 'neutral' as const };
  const toneClass =
    info.tone === 'good'
      ? 'text-emerald-700'
      : info.tone === 'warn'
        ? 'text-amber-700'
        : info.tone === 'bad'
          ? 'text-red-700'
          : 'text-slate-600';

  const Icon =
    info.tone === 'good'
      ? CheckCircle2
      : info.tone === 'warn'
        ? Clock
        : info.tone === 'bad'
          ? AlertCircle
          : MinusCircle;

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${toneClass}`}>
      <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>{info.label}</span>
    </span>
  );
}

export function StatTile({
  label,
  value,
  meta,
}: {
  label: string;
  value: string | number;
  meta?: string;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-4 py-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1.5 text-xl font-semibold text-slate-900 tabular-nums">{value}</div>
      {meta && <div className="mt-1 text-xs text-slate-500 tabular-nums">{meta}</div>}
    </div>
  );
}

export function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss?: () => void;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg text-sm"
    >
      <div className="flex items-center gap-2">
        <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>{message}</span>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="إغلاق التنبيه"
          className="text-red-700 hover:text-red-900 p-1"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export function SuccessBanner({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss?: () => void;
}) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-lg text-sm"
    >
      <div className="flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>{message}</span>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="إغلاق الإشعار"
          className="text-emerald-700 hover:text-emerald-900 p-1"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="py-10 px-4 text-center border border-dashed border-slate-200 rounded-lg bg-slate-50/50">
      <p className="text-sm font-medium text-slate-800">{title}</p>
      <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">{description}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 animate-pulse" aria-busy="true" aria-label="جاري التحميل">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-10 bg-slate-100 rounded-md" />
      ))}
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={`bg-white border border-slate-200 rounded-lg shadow-lg w-full ${
          wide ? 'max-w-3xl' : 'max-w-lg'
        } max-h-[90vh] flex flex-col`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={`إغلاق ${title}`}
            className="text-slate-500 hover:text-slate-800 p-1 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function Field({
  label,
  id,
  required,
  children,
}: {
  label: string;
  id: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-slate-700">
        {label}
        {required && <span className="text-red-600 mr-1">*</span>}
      </label>
      {children}
    </div>
  );
}

export const inputCls =
  'w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700';

export const primaryBtnCls =
  'inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-teal-700 hover:bg-teal-800 rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50';

export const secondaryBtnCls =
  'inline-flex items-center justify-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50';

export const dangerBtnCls =
  'inline-flex items-center justify-center gap-2 px-3.5 py-2 text-sm font-medium text-red-700 bg-white border border-red-300 hover:bg-red-50 rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50';
