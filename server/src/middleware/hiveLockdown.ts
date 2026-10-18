import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

// Opt-in deployment guard. No environment flag can enable Hive inference here.
// A future enablement requires a reviewed code change and evidence for every gate.
export function hiveLockdown(req: Request, res: Response, next: NextFunction): void {
  if (process.env.FREEAPI_HIVE_LOCKDOWN !== 'true') { next(); return; }
  if (req.method === 'GET' && req.path === '/api/ping' && !req.url.includes('?')) { next(); return; }
  res.setHeader('Cache-Control', 'no-store');
  const token = process.env.FREEAPI_HIVE_TOKEN || '';
  if (token.length < 32) { res.status(503).json({ code: 'HIVE_NOT_CONFIGURED' }); return; }
  const actual = crypto.createHash('sha256').update(req.headers.authorization || '').digest();
  const expected = crypto.createHash('sha256').update('Bearer ' + token).digest();
  if (!crypto.timingSafeEqual(actual, expected)) { res.status(401).json({ code: 'UNAUTHORIZED' }); return; }
  res.status(503).json({ code: 'HIVE_INFERENCE_NOT_ENABLED' });
}
