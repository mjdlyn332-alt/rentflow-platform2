import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import Database from 'better-sqlite3';
import {
  CollectorFlags,
  OrgStatus,
  Role,
  StaffAction,
  StaffDomain,
  StaffPermissions,
} from '../domain/types';
import { ActorContext, HttpError, newId, nowIso, PlatformDb, TenantDb } from './db';

export const SESSION_COOKIE_NAME = 'melaak_session';

declare global {
  namespace Express {
    interface Request {
      db: Database.Database;
      actor?: ActorContext & {
        email: string;
        fullName: string;
        partyId: string | null;
        staffPermissions: StaffPermissions | null;
        collector?: {
          id: string;
          cashboxId: string;
          flags: CollectorFlags;
          assignedPropertyIds: string[];
        } | null;
      };
    }
  }
}

export type AuthenticatedRequest = Request;

export function hashPassword(plain: string, minLength = 12): string {
  if (!plain || plain.length < minLength) {
    throw new HttpError(400, `كلمة المرور يجب أن تكون ${minLength} حرفاً على الأقل`);
  }
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    out[k] = v;
  }
  return out;
}

export function buildDefaultStaffPermissions(allowAll = false): StaffPermissions {
  const domains: StaffDomain[] = [
    'properties',
    'parties',
    'contracts',
    'services',
    'collections',
    'maintenance',
    'evictions',
    'accounting',
    'reports',
    'notifications',
    'settings',
  ];
  const out = {} as StaffPermissions;
  for (const d of domains) {
    out[d] = {
      read: allowAll,
      create: allowAll,
      update: allowAll,
      delete: allowAll,
    };
  }
  return out;
}

// In-memory login IP rate limiter (FR-IAM-01)
const loginAttemptsByIp = new Map<string, { count: number; resetAt: number }>();

export function checkLoginRateLimit(ip: string): void {
  const now = Date.now();
  const entry = loginAttemptsByIp.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttemptsByIp.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return;
  }
  entry.count += 1;
  if (entry.count > 25) {
    throw new HttpError(429, 'تم تجاوز الحد المسموح لمحاولات الدخول، يرجى المحاولة لاحقاً');
  }
}

export function createSessionForUser(
  db: Database.Database,
  user: { id: string; token_version: number },
  ttlHours = 8,
): { rawToken: string; expiresAt: string } {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, token_version, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(newId('ses'), user.id, tokenHash, user.token_version, expiresAt, nowIso());
  return { rawToken, expiresAt };
}

export function csrfOriginMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        return next(new HttpError(403, 'تم رفض الطلب: مصدر غير موثوق (CSRF)'));
      }
    } catch {
      return next(new HttpError(403, 'تم رفض الطلب: ترويسة Origin غير صالحة'));
    }
  }
  next();
}

export function attachAuthContext(db: Database.Database) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    req.db = db;
    const cookies = parseCookies(req.headers.cookie);
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : undefined;
    const rawToken = cookies[SESSION_COOKIE_NAME] || bearer;
    if (!rawToken) return next();

    const tokenHash = hashToken(rawToken);
    const session = db
      .prepare(`SELECT * FROM sessions WHERE token_hash = ?`)
      .get(tokenHash) as any;
    if (!session) return next();
    if (session.expires_at <= nowIso()) {
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(session.id);
      return next();
    }

    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(session.user_id) as any;
    if (!user || !user.is_active || user.token_version !== session.token_version) {
      return next();
    }

    if (user.organization_id) {
      const org = db
        .prepare(`SELECT status FROM organizations WHERE id = ?`)
        .get(user.organization_id) as { status: string } | undefined;
      if (!org || org.status !== OrgStatus.ACTIVE) {
        return next();
      }
    }

    let collectorInfo: AuthenticatedRequest['actor'] extends infer A
      ? A extends { collector?: infer C }
        ? C
        : never
      : never = null;

    if (user.role === Role.COLLECTOR) {
      const col = db
        .prepare(`SELECT * FROM collectors WHERE user_id = ? AND organization_id = ?`)
        .get(user.id, user.organization_id) as any;
      if (!col || !col.is_active) return next();
      const props = db
        .prepare(`SELECT property_id FROM collector_properties WHERE collector_id = ? AND organization_id = ?`)
        .all(col.id, user.organization_id) as Array<{ property_id: string }>;
      collectorInfo = {
        id: col.id,
        cashboxId: col.cashbox_id,
        flags: {
          canCollectRent: Boolean(col.can_collect_rent),
          canCollectServices: Boolean(col.can_collect_services),
          canCollectMaintenance: Boolean(col.can_collect_maintenance),
          canCreateServices: Boolean(col.can_create_services),
        },
        assignedPropertyIds: props.map((p) => p.property_id),
      };
    }

    req.actor = {
      userId: user.id,
      role: user.role as Role,
      organizationId: user.organization_id ?? null,
      email: user.email,
      fullName: user.full_name,
      partyId: user.party_id ?? null,
      staffPermissions: user.staff_permissions_json
        ? (JSON.parse(user.staff_permissions_json) as StaffPermissions)
        : null,
      collector: collectorInfo,
    };
    next();
  };
}

// FR-IAM-04: Deny by default
export function requireAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  if (!req.actor) {
    return next(new HttpError(401, 'يجب تسجيل الدخول للوصول إلى هذا المسار', 'UNAUTHORIZED'));
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.actor) {
      return next(new HttpError(401, 'يجب تسجيل الدخول للوصول إلى هذا المسار', 'UNAUTHORIZED'));
    }
    if (!roles.includes(req.actor.role)) {
      return next(new HttpError(403, 'ليست لديك صلاحية لتنفيذ هذه العملية', 'FORBIDDEN'));
    }
    next();
  };
}

export function requireOrgPermission(domain: StaffDomain, action: StaffAction) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.actor) {
      return next(new HttpError(401, 'يجب تسجيل الدخول للوصول إلى هذا المسار', 'UNAUTHORIZED'));
    }
    if (req.actor.role === Role.SUPER_ADMIN) {
      return next(new HttpError(403, 'الوصول إلى البيانات التشغيلية محظور على مالك النظام', 'SUPER_ADMIN_ISOLATED'));
    }
    if (req.actor.role === Role.OWNER) {
      return next();
    }
    if (req.actor.role === Role.STAFF) {
      const allowed = req.actor.staffPermissions?.[domain]?.[action] === true;
      if (!allowed) {
        return next(new HttpError(403, `صلاحية غير كافية في مجال ${domain} (${action})`, 'FORBIDDEN'));
      }
      return next();
    }
    return next(new HttpError(403, 'ليست لديك صلاحية إدارية لهذا المسار', 'FORBIDDEN'));
  };
}

export function getTenantDb(req: AuthenticatedRequest): TenantDb {
  if (!req.actor) throw new HttpError(401, 'غير مصرح');
  return new TenantDb(req.db, req.actor);
}

export function getPlatformDb(req: AuthenticatedRequest): PlatformDb {
  if (!req.actor) throw new HttpError(401, 'غير مصرح');
  return new PlatformDb(req.db, req.actor);
}
