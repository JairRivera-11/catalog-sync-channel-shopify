import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from './db.ts';
import { normalizeDomain, type ShopifyFactory, type ShopifyGateway } from './shopify.ts';
import { AppError, errorMessage, type AuditProduct, type Publication, type ShopifyProduct } from './types.ts';

export function auditProduct(product: ShopifyProduct, targets: Publication[]): AuditProduct {
  const published = new Set(product.publishedIds);
  const scheduled = new Set(product.scheduledIds);
  const missing = targets.filter(p => !published.has(p.id) && !scheduled.has(p.id));
  const skipReason = product.status !== 'ACTIVE' ? `Estado de Shopify: ${product.status}. Solo se publican productos activos.`
    : product.requiresSellingPlan ? 'Venta exclusiva por suscripción: revisa los destinos manualmente en Shopify.' : null;
  return {
    id: product.id, title: product.title, variants_skus: product.skus,
    active_channels_count: targets.filter(p => published.has(p.id)).length,
    scheduled_channels_count: targets.filter(p => !published.has(p.id) && scheduled.has(p.id)).length,
    missing_channels: missing, status: skipReason ? 'skipped' : missing.length ? 'pending' : 'complete',
    error_message: null, skip_reason: skipReason,
  };
}

type ActiveTask = { kind: string; controller: AbortController; promise: Promise<void> };
export class JobManager {
  private active: ActiveTask | null = null;
  private maintenance = false;
  constructor(private store: Store, private factory: ShopifyFactory, private credentials: () => { domain: string; token: string } | null, private verificationDelay = 500) {}
  get busy(): string | null { return this.maintenance ? 'reset' : this.active?.kind || null; }
  private ensureIdle() {
    if (this.busy) throw new AppError('Espera a que termine o detén la operación actual.', 409);
  }
  private client(): ShopifyGateway {
    const credentials = this.credentials();
    if (!credentials) throw new AppError('Conecta Shopify para esta sesión.', 401);
    return this.factory(credentials.domain, credentials.token);
  }
  private targets(): Publication[] {
    const targets = this.store.getPublications().filter(p => p.selected);
    if (!targets.length) throw new AppError('Selecciona al menos un canal de destino.');
    return targets.map(({ id, name }) => ({ id, name }));
  }
  private run(kind: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    this.ensureIdle();
    const task: ActiveTask = { kind, controller: new AbortController(), promise: Promise.resolve() };
    this.active = task;
    task.promise = Promise.resolve().then(() => work(task.controller.signal)).finally(() => {
      if (this.active === task) this.active = null;
    });
    return task.promise;
  }
  private runJob(kind: 'scan' | 'fix', work: (signal: AbortSignal) => Promise<void>) {
    return this.run(kind, async signal => {
      this.store.setJobState(kind, 'running');
      try { await work(signal); }
      catch (error) {
        this.store.setJobState(kind, signal.aborted ? 'idle' : 'error', signal.aborted ? null : errorMessage(error));
      }
    });
  }
  private assertTargetsAvailable(targets: Publication[], pubs: Publication[]) {
    if (targets.some(p => !pubs.some(current => current.id === p.id))) {
      throw new AppError('Un canal seleccionado ya no está disponible. Actualiza los canales y realiza un nuevo escaneo.');
    }
  }
  startScan() {
    this.ensureIdle();
    const client = this.client();
    const targets = this.targets();
    const previous = this.store.getJob();
    const fresh = previous.scan_status === 'completed' || !previous.initialized;
    void this.runJob('scan', async signal => {
      if (fresh) this.store.beginScan(0, true);
      const pubs = await client.getPublications(signal);
      this.assertTargetsAvailable(targets, pubs);
      const total = await client.getProductCount(signal);
      signal.throwIfAborted();
      this.store.refreshPublications(pubs);
      this.store.beginScan(total, false);
      let cursor = fresh ? null : previous.next_cursor;
      do {
        signal.throwIfAborted();
        const batch = await client.getProductsBatch(cursor, signal);
        signal.throwIfAborted();
        const products = batch.products.map(p => auditProduct(p, targets));
        this.store.saveScanBatch(products, batch.nextCursor, batch.nextCursor === null);
        cursor = batch.nextCursor;
      } while (cursor);
    });
  }
  startFix() {
    this.ensureIdle();
    const client = this.client();
    const targets = this.targets();
    if (this.store.getJob().scan_status !== 'completed') throw new AppError('Completa el escaneo antes de corregir canales.', 409);
    if (!this.store.getAnalytics().incomplete) throw new AppError('No hay productos pendientes de corrección.');
    void this.runJob('fix', async signal => {
      this.assertTargetsAvailable(targets, await client.getPublications(signal));
      signal.throwIfAborted();
      // Retry each previously failed product once per explicit correction run.
      this.store.retryErrors();
      let saved: AuditProduct | null;
      while ((saved = this.store.nextPending())) {
        signal.throwIfAborted();
        let current = saved;
        this.store.saveProduct({ ...current, status: 'fixing', error_message: null });
        try {
          const remote = await client.getProduct(current.id, signal);
          signal.throwIfAborted();
          if (!remote) {
            this.store.saveProduct({ ...current, status: 'skipped', skip_reason: 'El producto fue eliminado de Shopify.', missing_channels: [], error_message: null });
            continue;
          }
          current = auditProduct(remote, targets);
          if (current.status !== 'pending') { this.store.saveProduct(current); continue; }
          const ids = current.missing_channels.map(p => p.id);
          await client.publish(current.id, ids, signal);
          signal.throwIfAborted();
          let verified = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await delay(this.verificationDelay * attempt, undefined, { signal });
            const updated = await client.getProduct(current.id, signal);
            signal.throwIfAborted();
            if (!updated) throw new Error('El producto desapareció durante la verificación.');
            current = auditProduct(updated, targets);
            if (current.status === 'skipped') break;
            // Newly scheduled destinations are respected, but not counted as a successful publish.
            if (ids.every(id => updated.publishedIds.includes(id)) && !current.missing_channels.length) {
              verified = true;
              break;
            }
          }
          if (!verified) throw new Error('Shopify aún no confirma todos los canales publicados. Reintenta para reconciliar el estado.');
          this.store.saveProduct({ ...current, status: 'fixed' });
        } catch (error) {
          this.store.saveProduct({ ...current, status: signal.aborted ? 'pending' : 'error', error_message: signal.aborted ? null : errorMessage(error) });
          signal.throwIfAborted();
        }
      }
      const errors = this.store.getAnalytics().errors;
      this.store.setJobState('fix', errors ? 'error' : 'completed', errors ? `${errors} producto(s) requieren otro intento. Consulta el detalle de cada error.` : null);
    });
  }
  async stop(kind?: 'scan' | 'fix') {
    const task = this.active;
    if (!task || (kind && task.kind !== kind)) return;
    task.controller.abort();
    await task.promise.catch(() => undefined);
  }
  async reset() {
    if (this.maintenance) throw new AppError('Ya hay un reinicio en curso.', 409);
    this.maintenance = true;
    try { await this.stop(); this.store.reset(); }
    finally { this.maintenance = false; }
  }
  async saveSettings(domainInput: unknown, tokenInput: unknown) {
    const domain = normalizeDomain(domainInput);
    if (typeof tokenInput !== 'string' || !tokenInput.trim() || tokenInput.length > 4096 || /\s/.test(tokenInput.trim())) {
      throw new AppError('Introduce un token de acceso válido.');
    }
    const token = tokenInput.trim();
    await this.run('settings', async signal => {
      const client = this.factory(domain, token);
      const pubs = await client.getPublications(signal);
      await client.getProductCount(signal); // Verify read_products as well as read_publications.
      signal.throwIfAborted();
      this.store.saveSettings(domain, pubs);
    });
  }
  async refreshPublications() {
    const client = this.client();
    await this.run('publications', async signal => {
      const pubs = await client.getPublications(signal);
      signal.throwIfAborted();
      this.store.refreshPublications(pubs);
    });
  }
  selectPublications(input: unknown) {
    this.ensureIdle();
    if (!Array.isArray(input) || !input.length || input.some(id => typeof id !== 'string')) throw new AppError('Selecciona al menos un canal.');
    const ids = [...new Set(input as string[])];
    const pubs = this.store.getPublications();
    if (ids.some(id => !pubs.some(p => p.id === id))) throw new AppError('La selección incluye canales no disponibles.');
    const current = pubs.filter(p => p.selected).map(p => p.id);
    if (ids.length === current.length && ids.every(id => current.includes(id))) return;
    this.store.selectPublications(ids);
  }
  async waitForIdle() { await this.active?.promise; }
}
