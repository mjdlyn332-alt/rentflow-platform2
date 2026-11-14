import { Router } from 'express';
import crypto from 'node:crypto';
import { OrgStatus, Role } from '../../domain/types';
import {
  AuthenticatedRequest,
  checkLoginRateLimit,
  createSessionForUser,
  hashPassword,
  hashToken,
  parseCookies,
  requireAuth,
  SESSION_COOKIE_NAME,
  verifyPassword,
} from '../auth';
import { HttpError, newId, nowIso } from '../db';

export function createAuthRouter(): Router {
  const router = Router();

  // FR-IAM-01: Unified error message, rate limiting, account lockout, HTTP 401
  router.post('/login', (req: AuthenticatedRequest, res, next) => {
    try {
      const ip = req.ip || 'unknown';
      checkLoginRateLimit(ip);

      const { email, password } = req.body ?? {};
      if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
        throw new HttpError(400, 'البريد الإلكتروني وكلمة المرور مطلوبان');
      }

      const normalizedEmail = email.trim().toLowerCase();
      const user = req.db
        .prepare(`SELECT * FROM users WHERE lower(email) = ?`)
        .get(normalizedEmail) as any;

      if (!user) {
        throw new HttpError(401, 'بيانات الدخول غير صحيحة');
      }

      if (user.locked_until && user.locked_until > nowIso()) {
        throw new HttpError(423, 'تم قفل الحساب مؤقتاً بسبب محاولات دخول متكررة، يرجى المحاولة لاحقاً');
      }

      if (!verifyPassword(password, user.password_hash)) {
        const nextFail = Number(user.failed_login_count ?? 0) + 1;
        const lockUntil =
          nextFail >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
        req.db
          .prepare(`UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?`)
          .run(nextFail, lockUntil, user.id);
        throw new HttpError(401, 'بيانات الدخول غير صحيحة');
      }

      if (!user.is_active) {
        throw new HttpError(403, 'هذا الحساب موقوف، يرجى التواصل مع المسؤول');
      }

      if (user.organization_id) {
        const org = req.db
          .prepare(`SELECT id, name, status FROM organizations WHERE id = ?`)
          .get(user.organization_id) as { id: string; name: string; status: string } | undefined;
        if (!org || org.status !== OrgStatus.ACTIVE) {
          throw new HttpError(403, 'المنشأة معلّقة حالياً');
        }
      }

      req.db
        .prepare(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?`)
        .run(user.id);

      // FR-IAM-07: Two-factor authentication challenge for SUPER_ADMIN & OWNER when enabled
      if (user.two_factor_enabled && (user.role === Role.SUPER_ADMIN || user.role === Role.OWNER)) {
        const otp = String(crypto.randomInt(100000, 999999));
        const challengeToken = crypto.randomBytes(24).toString('hex');
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        req.db
          .prepare(
            `INSERT INTO two_factor_challenges (id, user_id, otp_hash, challenge_token_hash, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(newId('2fa'), user.id, hashToken(otp), hashToken(challengeToken), expiresAt, nowIso());

        const ps = req.db
          .prepare(`SELECT email_2fa_template FROM platform_settings WHERE id = 'default'`)
          .get() as { email_2fa_template?: string } | undefined;
        const tpl = ps?.email_2fa_template || 'رمز التحقق الثنائي لتسجيل الدخول: {{otp}}';
        req.db
          .prepare(
            `INSERT INTO email_outbox_log (id, organization_id, recipient_email, subject, body, kind, created_at)
             VALUES (?, ?, ?, 'رمز التحقق الثنائي - منصة مِلاك', ?, '2FA_OTP', ?)`,
          )
          .run(newId('mail'), user.organization_id ?? null, user.email, tpl.replace('{{otp}}', otp), nowIso());

        return res.json({
          requiresTwoFactor: true,
          challengeToken,
          devOtp: process.env.NODE_ENV !== 'production' ? otp : undefined,
        });
      }

      const settings = req.db
        .prepare(`SELECT session_ttl_hours FROM platform_settings WHERE id = 'default'`)
        .get() as { session_ttl_hours: number } | undefined;

      const { rawToken, expiresAt } = createSessionForUser(
        req.db,
        user,
        settings?.session_ttl_hours ?? 8,
      );

      res.cookie(SESSION_COOKIE_NAME, rawToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        expires: new Date(expiresAt),
        path: '/',
      });

      res.json({
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
          organizationId: user.organization_id,
          partyId: user.party_id,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login/verify-2fa', (req: AuthenticatedRequest, res, next) => {
    try {
      const { challengeToken, otp } = req.body ?? {};
      if (!challengeToken || !otp) {
        throw new HttpError(400, 'رمز التحدي ورمز التحقق مطلوبان');
      }
      const ch = req.db
        .prepare(
          `SELECT * FROM two_factor_challenges
           WHERE challenge_token_hash = ? AND used_at IS NULL AND expires_at > ?`,
        )
        .get(hashToken(String(challengeToken)), nowIso()) as any;
      if (!ch || ch.otp_hash !== hashToken(String(otp).trim())) {
        throw new HttpError(401, 'رمز التحقق الثنائي غير صحيح أو منتهي الصلاحية');
      }

      const user = req.db.prepare(`SELECT * FROM users WHERE id = ?`).get(ch.user_id) as any;
      if (!user || !user.is_active) {
        throw new HttpError(403, 'هذا الحساب موقوف');
      }
      if (user.organization_id) {
        const org = req.db
          .prepare(`SELECT status FROM organizations WHERE id = ?`)
          .get(user.organization_id) as { status: string } | undefined;
        if (!org || org.status !== OrgStatus.ACTIVE) {
          throw new HttpError(403, 'المنشأة معلّقة حالياً');
        }
      }

      req.db.prepare(`UPDATE two_factor_challenges SET used_at = ? WHERE id = ?`).run(nowIso(), ch.id);
      const settings = req.db
        .prepare(`SELECT session_ttl_hours FROM platform_settings WHERE id = 'default'`)
        .get() as { session_ttl_hours: number } | undefined;

      const { rawToken, expiresAt } = createSessionForUser(req.db, user, settings?.session_ttl_hours ?? 8);
      res.cookie(SESSION_COOKIE_NAME, rawToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        expires: new Date(expiresAt),
        path: '/',
      });

      res.json({
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
          organizationId: user.organization_id,
          partyId: user.party_id,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req: AuthenticatedRequest, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const rawToken = cookies[SESSION_COOKIE_NAME];
    if (rawToken) {
      req.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(rawToken));
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
    const actor = req.actor!;
    let organization: any = null;
    if (actor.organizationId) {
      organization = req.db
        .prepare(
          `SELECT id, name, status, timezone, base_currency, default_grace_days, post_grace_rent_enabled, rounding_step, contract_expiry_alert_days, show_hijri_dates
           FROM organizations WHERE id = ?`,
        )
        .get(actor.organizationId);
    }
    const userRow = req.db
      .prepare(`SELECT two_factor_enabled FROM users WHERE id = ?`)
      .get(actor.userId) as { two_factor_enabled: number } | undefined;

    res.json({
      user: {
        id: actor.userId,
        email: actor.email,
        fullName: actor.fullName,
        role: actor.role,
        organizationId: actor.organizationId,
        partyId: actor.partyId,
        staffPermissions: actor.staffPermissions,
        collector: actor.collector,
        twoFactorEnabled: Boolean(userRow?.two_factor_enabled),
      },
      organization,
    });
  });

  router.get('/session', (req: AuthenticatedRequest, res) => {
    const actor = req.actor;
    if (!actor) {
      return res.json({ authenticated: false, user: null, organization: null });
    }
    let organization: any = null;
    if (actor.organizationId) {
      organization = req.db
        .prepare(
          `SELECT id, name, status, timezone, base_currency, default_grace_days, post_grace_rent_enabled, rounding_step, contract_expiry_alert_days, show_hijri_dates
           FROM organizations WHERE id = ?`,
        )
        .get(actor.organizationId);
    }
    const userRow = req.db
      .prepare(`SELECT two_factor_enabled FROM users WHERE id = ?`)
      .get(actor.userId) as { two_factor_enabled: number } | undefined;

    return res.json({
      authenticated: true,
      user: {
        id: actor.userId,
        email: actor.email,
        fullName: actor.fullName,
        role: actor.role,
        organizationId: actor.organizationId,
        partyId: actor.partyId,
        staffPermissions: actor.staffPermissions,
        collector: actor.collector,
        twoFactorEnabled: Boolean(userRow?.two_factor_enabled),
      },
      organization,
    });
  });

  // FR-IAM-03: Password reset OTP request
  router.post('/password-reset/request', (req: AuthenticatedRequest, res, next) => {
    try {
      const { email } = req.body ?? {};
      if (!email || typeof email !== 'string') {
        throw new HttpError(400, 'البريد الإلكتروني مطلوب');
      }
      const user = req.db
        .prepare(`SELECT id, full_name, email, organization_id FROM users WHERE lower(email) = ?`)
        .get(email.trim().toLowerCase()) as { id: string; full_name: string; email: string; organization_id: string | null } | undefined;
      if (user) {
        const otp = String(crypto.randomInt(100000, 999999));
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        req.db
          .prepare(
            `INSERT INTO password_reset_tokens (id, user_id, otp_hash, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(newId('prt'), user.id, hashToken(otp), expiresAt, nowIso());

        const ps = req.db
          .prepare(`SELECT email_reset_subject, email_reset_template FROM platform_settings WHERE id = 'default'`)
          .get() as { email_reset_subject?: string; email_reset_template?: string } | undefined;
        const body = (ps?.email_reset_template || 'رمز استعادة كلمة المرور: {{otp}}')
          .replace('{{name}}', user.full_name)
          .replace('{{otp}}', otp);
        req.db
          .prepare(
            `INSERT INTO email_outbox_log (id, organization_id, recipient_email, subject, body, kind, created_at)
             VALUES (?, ?, ?, ?, ?, 'PASSWORD_RESET', ?)`,
          )
          .run(
            newId('mail'),
            user.organization_id,
            user.email,
            ps?.email_reset_subject || 'رمز استعادة كلمة المرور',
            body,
            nowIso(),
          );
      }
      // Uniform response so account existence is never leaked
      res.json({
        ok: true,
        message: 'إن كان البريد مسجلاً فسيتم إرسال رمز التحقق لإعادة تعيين كلمة المرور.',
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/password-reset/confirm', (req: AuthenticatedRequest, res, next) => {
    try {
      const { email, otp, newPassword } = req.body ?? {};
      if (!email || !otp || !newPassword) {
        throw new HttpError(400, 'جميع الحقول مطلوبة');
      }
      const user = req.db
        .prepare(`SELECT id FROM users WHERE lower(email) = ?`)
        .get(String(email).trim().toLowerCase()) as { id: string } | undefined;
      if (!user) throw new HttpError(400, 'رمز التحقق غير صحيح أو منتهي الصلاحية');

      const tokenRow = req.db
        .prepare(
          `SELECT * FROM password_reset_tokens
           WHERE user_id = ? AND otp_hash = ? AND used_at IS NULL AND expires_at > ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(user.id, hashToken(String(otp)), nowIso()) as any;
      if (!tokenRow) throw new HttpError(400, 'رمز التحقق غير صحيح أو منتهي الصلاحية');

      const settings = req.db
        .prepare(`SELECT min_password_length FROM platform_settings WHERE id = 'default'`)
        .get() as { min_password_length: number } | undefined;
      const hash = hashPassword(String(newPassword), settings?.min_password_length ?? 12);

      req.db.prepare(`UPDATE password_reset_tokens SET used_at = ? WHERE id = ?`).run(nowIso(), tokenRow.id);
      req.db
        .prepare(`UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?`)
        .run(hash, user.id);

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // FR-IAM-07: Toggle 2FA for OWNER & SUPER_ADMIN
  router.post('/2fa/toggle', requireAuth, (req: AuthenticatedRequest, res, next) => {
    try {
      const actor = req.actor!;
      if (actor.role !== Role.SUPER_ADMIN && actor.role !== Role.OWNER) {
        throw new HttpError(403, 'المصادقة الثنائية مخصصة لمالك النظام ومالك العقار');
      }
      const enabled = Boolean(req.body?.enabled);
      req.db
        .prepare(`UPDATE users SET two_factor_enabled = ? WHERE id = ?`)
        .run(enabled ? 1 : 0, actor.userId);
      res.json({ twoFactorEnabled: enabled });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
