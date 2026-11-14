import { parseIsoDate } from './rules';

export type AlertToastCategory = 'CONTRACT_EXPIRY' | 'MAINTENANCE_PENDING';
export type AlertToastSeverity = 'urgent' | 'warning';
export type AlertTargetTab = 'contracts' | 'maintenance';

export interface DashboardAlertToast {
  id: string;
  category: AlertToastCategory;
  severity: AlertToastSeverity;
  title: string;
  message: string;
  meta: string;
  actionLabel: string;
  targetTab: AlertTargetTab;
  sortPriority: number;
  daysRemaining?: number;
}

export interface ExpiringContractAlertInput {
  id: string;
  property_name?: string;
  propertyName?: string;
  unit_number?: string;
  unitNumber?: string;
  tenant_name?: string;
  tenantName?: string;
  end_date?: string;
  endDate?: string;
}

export interface PendingMaintenanceAlertInput {
  id: string;
  maintenance_type?: string;
  maintenanceType?: string;
  description?: string;
  property_name?: string;
  propertyName?: string;
  unit_number?: string | null;
  unitNumber?: string | null;
  status: string;
  maintenance_date?: string;
  maintenanceDate?: string;
}

export interface PendingMaintenanceRequestAlertInput {
  id: string;
  maintenance_type?: string;
  maintenanceType?: string;
  description?: string;
  property_name?: string;
  propertyName?: string;
  unit_number?: string;
  unitNumber?: string;
  tenant_name?: string;
  tenantName?: string;
  created_at?: string;
  createdAt?: string;
}

export function calculateDaysRemaining(todayIso: string, targetDateIso: string): number {
  const todayMs = parseIsoDate(todayIso).getTime();
  const targetMs = parseIsoDate(targetDateIso).getTime();
  return Math.round((targetMs - todayMs) / 86400000);
}

function truncateText(text: string, maxLen = 72): string {
  const clean = text.trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1).trimEnd()}…`;
}

export function buildDashboardAlertToasts(params: {
  today: string;
  expiringContracts?: ExpiringContractAlertInput[];
  pendingMaintenance?: PendingMaintenanceAlertInput[];
  pendingMaintenanceRequests?: PendingMaintenanceRequestAlertInput[];
  dismissedIds?: Iterable<string>;
  maxVisible?: number;
}): {
  allToasts: DashboardAlertToast[];
  visibleToasts: DashboardAlertToast[];
  contractAlertCount: number;
  maintenanceAlertCount: number;
  hiddenCount: number;
} {
  const dismissed = new Set(params.dismissedIds ?? []);
  const maxVisible = params.maxVisible ?? 5;
  const allToasts: DashboardAlertToast[] = [];

  for (const ag of params.expiringContracts ?? []) {
    const endDate = (ag.end_date ?? ag.endDate ?? params.today).slice(0, 10);
    const propName = ag.property_name ?? ag.propertyName ?? 'عقار';
    const unitNo = ag.unit_number ?? ag.unitNumber ?? '—';
    const tenantName = ag.tenant_name ?? ag.tenantName ?? 'مستأجر';
    const days = calculateDaysRemaining(params.today, endDate);

    let title: string;
    if (days < 0) {
      title = `عقد إيجار منتهي منذ ${Math.abs(days)} يوم`;
    } else if (days === 0) {
      title = 'عقد إيجار ينتهي اليوم';
    } else {
      title = `عقد إيجار قارب على الانتهاء (متبقي ${days} يوم)`;
    }

    const severity: AlertToastSeverity = days <= 7 ? 'urgent' : 'warning';
    const sortPriority = days <= 0 ? 0 : days <= 7 ? 1 : 3;

    allToasts.push({
      id: `contract:${ag.id}`,
      category: 'CONTRACT_EXPIRY',
      severity,
      title,
      message: `${propName} · وحدة ${unitNo} — ${tenantName}`,
      meta: `تاريخ الانتهاء: ${endDate}`,
      actionLabel: 'عرض العقود',
      targetTab: 'contracts',
      sortPriority,
      daysRemaining: days,
    });
  }

  for (const req of params.pendingMaintenanceRequests ?? []) {
    const mType = req.maintenance_type ?? req.maintenanceType ?? 'صيانة';
    const propName = req.property_name ?? req.propertyName ?? 'عقار';
    const unitNo = req.unit_number ?? req.unitNumber ?? '—';
    const tenantName = req.tenant_name ?? req.tenantName;
    const desc = truncateText(req.description ?? '');

    allToasts.push({
      id: `tmreq:${req.id}`,
      category: 'MAINTENANCE_PENDING',
      severity: 'urgent',
      title: 'طلب صيانة مستأجر بانتظار الاعتماد',
      message: `${mType} — ${propName} · وحدة ${unitNo}${tenantName ? ` (${tenantName})` : ''}`,
      meta: desc || 'مقدم عبر بوابة المستأجر',
      actionLabel: 'مراجعة الصيانة',
      targetTab: 'maintenance',
      sortPriority: 1,
    });
  }

  for (const m of params.pendingMaintenance ?? []) {
    if (m.status !== 'OPEN' && m.status !== 'IN_PROGRESS') continue;
    const mType = m.maintenance_type ?? m.maintenanceType ?? 'صيانة';
    const propName = m.property_name ?? m.propertyName ?? 'عقار';
    const unitNo = m.unit_number ?? m.unitNumber ?? null;
    const mDate = (m.maintenance_date ?? m.maintenanceDate ?? '').slice(0, 10);
    const desc = truncateText(m.description ?? '');
    const isOpen = m.status === 'OPEN';

    allToasts.push({
      id: `maint:${m.id}`,
      category: 'MAINTENANCE_PENDING',
      severity: isOpen ? 'urgent' : 'warning',
      title: isOpen ? 'مهمة صيانة معلقة بانتظار التنفيذ' : 'مهمة صيانة قيد التنفيذ',
      message: `${mType} — ${propName}${unitNo ? ` · وحدة ${unitNo}` : ' (مرفق عام)'}`,
      meta: [desc, mDate ? `التاريخ: ${mDate}` : ''].filter(Boolean).join(' · '),
      actionLabel: 'فتح الصيانة',
      targetTab: 'maintenance',
      sortPriority: isOpen ? 2 : 4,
    });
  }

  allToasts.sort((a, b) => {
    if (a.sortPriority !== b.sortPriority) return a.sortPriority - b.sortPriority;
    if (a.daysRemaining !== undefined && b.daysRemaining !== undefined) {
      return a.daysRemaining - b.daysRemaining;
    }
    return a.id.localeCompare(b.id);
  });

  const activeToasts = allToasts.filter((t) => !dismissed.has(t.id));
  const visibleToasts = activeToasts.slice(0, Math.max(0, maxVisible));

  return {
    allToasts,
    visibleToasts,
    contractAlertCount: allToasts.filter((t) => t.category === 'CONTRACT_EXPIRY').length,
    maintenanceAlertCount: allToasts.filter((t) => t.category === 'MAINTENANCE_PENDING').length,
    hiddenCount: Math.max(0, activeToasts.length - visibleToasts.length),
  };
}
