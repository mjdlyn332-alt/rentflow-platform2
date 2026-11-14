export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: 'SUPER_ADMIN' | 'OWNER' | 'STAFF' | 'COLLECTOR' | 'RENTER' | 'UNIT_OWNER';
  organizationId: string | null;
  partyId: string | null;
  staffPermissions?: Record<string, Record<string, boolean>> | null;
  collector?: {
    id: string;
    cashboxId: string;
    flags: {
      canCollectRent: boolean;
      canCollectServices: boolean;
      canCollectMaintenance: boolean;
      canCreateServices: boolean;
    };
    assignedPropertyIds: string[];
  } | null;
  twoFactorEnabled?: boolean;
}

export interface OrganizationInfo {
  id: string;
  name: string;
  status: string;
  timezone: string;
  base_currency: string;
  default_grace_days: number;
  post_grace_rent_enabled: number;
  rounding_step: string | null;
  contract_expiry_alert_days: number;
  show_hijri_dates: number;
  retention_years?: number;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiFetch<T = any>(
  url: string,
  options: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.idempotencyKey) {
    headers.set('Idempotency-Key', options.idempotencyKey);
  }
  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    throw new ApiError(res.status, json.error || `خطأ في الطلب (${res.status})`, json.code);
  }
  return json as T;
}

export function formatMoney(val: string | number | null | undefined, currency = 'SAR'): string {
  const num = Number(val ?? 0);
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(num) ? num : 0);
  return `${formatted} ${currency}`;
}

export function formatDateDisplay(iso: string | null | undefined, showHijri = false): string {
  if (!iso) return '—';
  const clean = iso.slice(0, 10);
  if (!showHijri) return clean;
  try {
    const dt = new Date(`${clean}T12:00:00Z`);
    const hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(dt);
    return `${clean} (${hijri})`;
  } catch {
    return clean;
  }
}

export function downloadCsvExcel(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): void {
  const esc = (v: string | number | null | undefined) => {
    const s = String(v ?? '');
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'مالك النظام',
  OWNER: 'مالك العقار',
  STAFF: 'موظف إدارة',
  COLLECTOR: 'محصّل',
  RENTER: 'مستأجر',
  UNIT_OWNER: 'مالك وحدة تمليك',
};

export const STATUS_LABELS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  ACTIVE: { label: 'نشط', tone: 'good' },
  SUSPENDED: { label: 'موقوف', tone: 'bad' },
  ARCHIVED: { label: 'مؤرشف', tone: 'neutral' },
  VACANT: { label: 'شاغرة', tone: 'neutral' },
  RENTED: { label: 'مؤجرة', tone: 'good' },
  OWNED: { label: 'تمليك', tone: 'neutral' },
  MAINTENANCE: { label: 'تحت الصيانة', tone: 'warn' },
  DRAFT: { label: 'مسودة', tone: 'neutral' },
  NOTICE: { label: 'فترة إشعار إخلاء', tone: 'warn' },
  EXPIRED: { label: 'منتهي', tone: 'warn' },
  CLOSED: { label: 'مغلق', tone: 'neutral' },
  CANCELED: { label: 'ملغى', tone: 'bad' },
  CANCELLED: { label: 'ملغى', tone: 'bad' },
  PENDING: { label: 'مستحق / بانتظار', tone: 'warn' },
  PARTIAL: { label: 'مسدد جزئياً', tone: 'warn' },
  PAID: { label: 'مسدد', tone: 'good' },
  WAIVED: { label: 'معفى (إشعار دائن)', tone: 'neutral' },
  ISSUED: { label: 'صادرة', tone: 'warn' },
  VOID: { label: 'ملغاة', tone: 'bad' },
  POSTED: { label: 'مرحّل', tone: 'good' },
  APPROVED: { label: 'معتمد', tone: 'good' },
  REVERSED: { label: 'معكوس', tone: 'bad' },
  IN_GRACE: { label: 'في المهلة بلا إيجار', tone: 'warn' },
  OVERDUE: { label: 'متأخر عن المهلة', tone: 'bad' },
  HANDED_OVER: { label: 'تم التسليم', tone: 'neutral' },
  SETTLED: { label: 'تمت التسوية', tone: 'good' },
  HELD: { label: 'محتجز', tone: 'good' },
  PARTIALLY_APPLIED: { label: 'مخصوم جزئياً', tone: 'warn' },
  REFUNDED: { label: 'تم الرد / التسوية', tone: 'neutral' },
  FORFEITED: { label: 'مصادَر', tone: 'bad' },
  OPEN: { label: 'مفتوح', tone: 'warn' },
  IN_PROGRESS: { label: 'قيد التنفيذ', tone: 'warn' },
  COMPLETED: { label: 'مكتمل', tone: 'good' },
  CONVERTED: { label: 'محوّل لصيانة', tone: 'good' },
  REJECTED: { label: 'مرفوض', tone: 'bad' },
  SCHEDULED: { label: 'مجدول', tone: 'warn' },
  SENT: { label: 'تم الإرسال', tone: 'good' },
  TENANT: { label: 'على المستأجر', tone: 'warn' },
  OWNER: { label: 'على المالك', tone: 'neutral' },
  SHARED: { label: 'مشترك', tone: 'neutral' },
};

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  ASSET: 'أصل',
  LIABILITY: 'التزام',
  EQUITY: 'حقوق ملكية',
  REVENUE: 'إيراد',
  EXPENSE: 'مصروف',
};

export const CASHBOX_TYPE_LABELS: Record<string, string> = {
  MAIN: 'رئيسي',
  COLLECTOR: 'صندوق محصّل',
  BANK: 'حساب بنكي',
};

export const VOUCHER_TYPE_LABELS: Record<string, string> = {
  RECEIPT: 'سند قبض',
  PAYMENT: 'سند صرف',
  TRANSFER: 'تحويل',
  REVERSAL: 'عكس سند',
};

export const REFERENCE_TYPE_LABELS: Record<string, string> = {
  INSTALLMENT: 'قسط إيجار',
  SERVICE_BILL: 'فاتورة خدمة',
  SECURITY_DEPOSIT: 'تأمين عقد',
  CONTRACT_EXPENSE: 'رسوم/مصروف عقد',
  MAINTENANCE: 'صيانة',
  EXPENSE: 'مصروف تشغيلي',
  CASHBOX_TRANSFER: 'تحويل صناديق',
  SETTLEMENT: 'تسوية إخلاء',
  GUARD_SALARY: 'راتب حارس',
  COLLECTOR_REWARD: 'مكافأة محصّل',
};

export const ATTACHMENT_TYPE_LABELS: Record<string, string> = {
  ID_DOC: 'وثيقة هوية / سجل',
  CONTRACT_SCAN: 'نسخة عقد موقّع',
  ENTRY_PHOTO: 'صور استلام الدخول',
  EXIT_PHOTO: 'صور تسليم الخروج',
  BEFORE_PHOTO: 'صورة قبل الصيانة',
  AFTER_PHOTO: 'صورة بعد الصيانة',
  PROPERTY_DOC: 'مستند / صك عقار',
  UNIT_DOC: 'مستند وحدة',
  OTHER: 'مرفق عام',
};

