import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpLeft, BellRing, CalendarClock, Wrench, X } from 'lucide-react';
import { DashboardAlertToast } from '../domain/alerts';

export function ToastNotificationsPanel({
  open,
  toasts,
  hiddenCount,
  onDismissOne,
  onDismissAll,
  onNavigate,
}: {
  open: boolean;
  toasts: DashboardAlertToast[];
  hiddenCount: number;
  onDismissOne: (id: string) => void;
  onDismissAll: () => void;
  onNavigate: (tab: 'contracts' | 'maintenance') => void;
}) {
  if (!open || toasts.length === 0) return null;

  return (
    <aside
      role="region"
      aria-label="لوحة التنبيهات المنبثقة"
      aria-live="polite"
      className="fixed bottom-3 left-3 right-3 sm:bottom-4 sm:left-4 sm:right-auto sm:w-[23.5rem] z-40 flex flex-col gap-2 max-h-[46vh] sm:max-h-[62vh]"
    >
      <div className="flex items-center justify-between gap-2 bg-white/95 backdrop-blur border border-slate-200 rounded-lg px-3 py-2 shadow-md">
        <div className="flex items-center gap-2 min-w-0">
          <BellRing className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />
          <span className="text-xs font-bold text-slate-900 truncate">
            تنبيهات العقود والصيانة ({toasts.length})
          </span>
        </div>
        <button
          type="button"
          onClick={onDismissAll}
          className="text-[11px] font-medium text-slate-600 hover:text-slate-900 px-2 py-0.5 rounded hover:bg-slate-100 whitespace-nowrap shrink-0"
        >
          إغلاق الكل
        </button>
      </div>

      <div className="space-y-2 overflow-y-auto px-0.5 pb-1">
        <AnimatePresence initial={true}>
          {toasts.map((toast) => {
            const isUrgent = toast.severity === 'urgent';
            const isContract = toast.category === 'CONTRACT_EXPIRY';
            const Icon = isContract ? CalendarClock : Wrench;

            return (
              <motion.div
                key={toast.id}
                role="status"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.18 }}
                className={`bg-white border border-slate-200 border-r-4 ${
                  isUrgent ? 'border-r-red-600' : 'border-r-amber-500'
                } rounded-lg shadow-lg p-3`}
              >
                <div className="flex items-start gap-2.5">
                  <div
                    className={`p-1.5 rounded-md shrink-0 mt-0.5 ${
                      isUrgent ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-xs font-bold text-slate-900 leading-snug">
                        {toast.title}
                      </h3>
                      <button
                        type="button"
                        onClick={() => onDismissOne(toast.id)}
                        aria-label={`إغلاق تنبيه: ${toast.title}`}
                        className="text-slate-400 hover:text-slate-700 p-0.5 rounded shrink-0"
                      >
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </div>

                    <p className="text-xs text-slate-700 mt-0.5 leading-snug break-words">
                      {toast.message}
                    </p>

                    <div className="mt-2 flex items-center justify-between gap-2">
                      {toast.meta ? (
                        <span className="text-[11px] text-slate-500 truncate min-w-0" dir="auto">
                          {toast.meta}
                        </span>
                      ) : (
                        <span />
                      )}
                      <button
                        type="button"
                        onClick={() => onNavigate(toast.targetTab)}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700 hover:text-teal-900 hover:underline whitespace-nowrap shrink-0"
                      >
                        <span>{toast.actionLabel}</span>
                        <ArrowUpLeft className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {hiddenCount > 0 && (
          <div className="bg-white/95 border border-slate-200 rounded-md px-3 py-1.5 text-[11px] text-slate-600 text-center shadow-sm">
            توجد {hiddenCount} تنبيهات إضافية — يمكنك مراجعة العقود والصيانة للتفاصيل
          </div>
        )}
      </div>
    </aside>
  );
}
