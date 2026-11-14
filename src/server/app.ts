import express, { type NextFunction, type Request, type Response } from 'express';
import Database from 'better-sqlite3';
import { attachAuthContext, csrfOriginMiddleware } from './auth';
import { HttpError } from './db';
import { createAccountingAndReportsRouter } from './routes/accountingAndReportsRoutes';
import { createAuthRouter } from './routes/authRoutes';
import { createContractsAndServicesRouter } from './routes/contractsAndServicesRoutes';
import { createOperationsRouter } from './routes/operationsRoutes';
import { createPlatformRouter } from './routes/platformRoutes';
import { createPropertiesAndPartiesRouter } from './routes/propertiesAndPartiesRoutes';

export function createApiApp(db: Database.Database): express.Express {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use(csrfOriginMiddleware);
  app.use(attachAuthContext(db));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', createAuthRouter());
  app.use('/api/platform', createPlatformRouter());
  app.use('/api', createPropertiesAndPartiesRouter());
  app.use('/api', createContractsAndServicesRouter());
  app.use('/api', createOperationsRouter());
  app.use('/api', createAccountingAndReportsRouter());

  // Unknown API route -> 404 JSON (deny by default)
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'المسار غير موجود', code: 'NOT_FOUND' });
  });

  // Error handler returning true HTTP status codes (never HTTP 200)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    const msg = err instanceof Error ? err.message : 'خطأ داخلي في الخادم';
    if (msg.includes('انتقال حالة غير مسموح') || msg.includes('لا يمكن') || msg.includes('يجب')) {
      return res.status(400).json({ error: msg, code: 'DOMAIN_VALIDATION' });
    }
    console.error('[API ERROR]', err);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع في الخادم', code: 'INTERNAL_ERROR' });
  });

  return app;
}
