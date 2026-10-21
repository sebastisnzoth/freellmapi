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
  // Inference requires a dedicated Hive token in x-hive-token, leaving
  // Authorization for the independent FreeLLMAPI unified/client API key.
  const inferenceRoute =
    (req.method === 'POST' && req.path === '/v1/chat/completions') ||
    (req.method === 'GET' && req.path === '/v1/models');
  const hiveCredential = inferenceRoute ? req.headers['x-hive-token'] : req.headers.authorization;
  const actual = crypto.createHash('sha256').update(typeof hiveCredential === 'string' ? hiveCredential : '').digest();
  const expected = crypto.createHash('sha256').update(inferenceRoute ? token : 'Bearer ' + token).digest();
  if (!crypto.timingSafeEqual(actual, expected)) { res.status(401).json({ code: 'UNAUTHORIZED' }); return; }
  // Permit inference only behind BOTH the Hive bearer and the proxy's
  // separate unified/profile API key. Dashboard/admin routes remain closed.
  if (inferenceRoute && process.env.FREEAPI_HIVE_INFERENCE_ENABLED === 'true') {
    next();
    return;
  }
  res.status(503).json({ code: 'HIVE_INFERENCE_NOT_ENABLED' });
}
