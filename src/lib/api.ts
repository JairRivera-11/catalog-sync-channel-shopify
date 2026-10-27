import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Store } from './db.ts';
import { JobManager } from './jobs.ts';
import { SessionManager } from './sessions.ts';
import { normalizeDomain, ShopifyClient, type ShopifyFactory } from './shopify.ts';
import { AppError, errorMessage } from './types.ts';

type ApiOptions = {
  store: Store; origins: string[]; password?: string; factory?: ShopifyFactory;
  leaseMs?: number; maxAgeMs?: number; now?: () => number; verificationDelay?: number;
};
const cookieName = 'channel_sync_session';
function sessionId(req: Request): string | undefined {
  return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}
function asyncRoute(fn: (req: Request, res: express.Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => { void fn(req, res).catch(next); };
}
function equalSecret(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function createApi(options: ApiOptions) {
  const { store } = options;
  const app = express();
  app.disable('x-powered-by');
  const allowedOrigins = new Set(options.origins.map(o => new URL(o).origin));
  const allowedHosts = new Set(options.origins.map(o => new URL(o).host));
  const secure = options.origins.every(o => o.startsWith('https:'));
  const cookie = { httpOnly: true, sameSite: 'strict' as const, secure, path: '/api' };
  const sessions: SessionManager = new SessionManager(() => jobs.stop(), options);
  const jobs: JobManager = new JobManager(store, options.factory || ((domain, token) => new ShopifyClient(domain, token)), () => sessions.credentials(), options.verificationDelay);
  const sweeper = setInterval(() => { void sessions.sweep().catch(() => undefined); }, 5000);
  sweeper.unref();
  const attempts = new Map<string, { count: number; until: number }>();

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!allowedHosts.has(req.headers.host || '')) return res.status(403).json({ error: 'Host no permitido.' });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: 'Origen no permitido.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Solicitud entre sitios rechazada.' });
    next();
  });
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (req, res, next) => {
    if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'Se requiere application/json.' });
    next();
  });
  app.get('/api/session', (req, res) => {
    res.json({ authenticated: sessions.authenticated(sessionId(req)), passwordRequired: !!options.password });
  });
  app.post('/api/session', asyncRoute(async (req, res) => {
    const address = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const attempt = attempts.get(address) || { count: 0, until: now + 60_000 };
    if (++attempt.count > 10) throw new AppError('Demasiados intentos. Espera un minuto.', 429);
    attempts.set(address, attempt);
    if (options.password && (typeof req.body?.password !== 'string' || !equalSecret(req.body.password, options.password))) {
      throw new AppError('Contraseña de acceso incorrecta.', 401);
    }
    const domain = normalizeDomain(req.body?.shop_domain);
    const token = req.body?.access_token;
    // Drop parsed request references as soon as validation owns the credentials.
    if (req.body) { delete req.body.access_token; delete req.body.password; }
    if (typeof token !== 'string' || !token.trim() || token.length > 4096 || /\s/.test(token.trim())) throw new AppError('Token de Shopify inválido.');
    let disconnected = false;
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) { disconnected = true; controller.abort(); } };
    res.on('close', onClose);
    try {
      const id = await sessions.connect(domain, token.trim(), () => jobs.saveSettings(domain, token.trim()), sessionId(req), controller.signal);
      if (disconnected) { await sessions.end(id); return; }
      attempts.delete(address);
      res.cookie(cookieName, id, cookie).json({ success: true });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(errorMessage(error).split(token.trim()).join('[token oculto]'), 502);
    } finally { res.off('close', onClose); }
  }));
  app.post('/api/session/end', asyncRoute(async (req, res) => {
    const id = sessionId(req);
    if (id) await sessions.end(id);
    res.clearCookie(cookieName, cookie).json({ success: true });
  }));
  app.use('/api', (req, res, next) => {
    if (!sessions.authenticated(sessionId(req))) {
      res.clearCookie(cookieName, cookie);
      return res.status(401).json({ error: 'La sesión terminó. Vuelve a conectar Shopify.' });
    }
    next();
  });
  app.get('/api/status', (req, res) => {
    const page = Number(req.query.page || 1);
    if (!Number.isSafeInteger(page) || page < 1) throw new AppError('Página inválida.');
    const filter = req.query.filter || 'incomplete';
    if (filter !== 'all' && filter !== 'incomplete' && filter !== 'skipped') throw new AppError('Filtro inválido.');
    res.json({
      isConfigured: !!sessions.credentials(), shopDomain: store.getSettings().shop_domain,
      job: store.getJob(), analytics: store.getAnalytics(), publications: store.getPublications(),
      ...store.getProducts(page, 50, filter), busy: jobs.busy,
    });
  });
  app.post('/api/publications/refresh', asyncRoute(async (_req, res) => { await jobs.refreshPublications(); res.json({ success: true }); }));
  app.post('/api/publications/select', (req, res) => { jobs.selectPublications(req.body?.ids); res.json({ success: true }); });
  app.post('/api/scan/start', (_req, res) => { jobs.startScan(); res.status(202).json({ success: true }); });
  app.post('/api/fix/start', (_req, res) => { jobs.startFix(); res.status(202).json({ success: true }); });
  app.post('/api/scan/stop', asyncRoute(async (_req, res) => { await jobs.stop('scan'); res.json({ success: true }); }));
  app.post('/api/fix/stop', asyncRoute(async (_req, res) => { await jobs.stop('fix'); res.json({ success: true }); }));
  app.post('/api/reset', asyncRoute(async (_req, res) => { await jobs.reset(); res.json({ success: true }); }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof AppError ? error.status : error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: status === 500 ? 'Error interno del servidor.' : errorMessage(error) });
  };
  app.use(errors);
  return { app, jobs, sessions, async dispose() { clearInterval(sweeper); await sessions.end(); } };
}
