import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Analytics, AuditProduct, Job, JobState, ProductTarget, Publication, SelectablePublication } from './types.ts';

type ProductRow = Omit<AuditProduct, 'variants_skus' | 'missing_channels'> & { variants_skus: string; missing_channels: string };
type Settings = { shop_domain: string };
const pendingWhere = "status IN ('pending', 'fixing', 'error') AND json_array_length(missing_channels) > 0";
type TargetRow = { product_id: string; title: string; variants_skus: string; channels: string };

export function createStore(filename: string) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('secure_delete = ON');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > 3) { db.close(); throw new Error('La base pertenece a una versión más reciente de la aplicación.'); }
  const legacy = version === 0 && !!db.prepare("SELECT name FROM sqlite_master WHERE name = 'settings'").get();
  const oldSettings = legacy ? db.prepare('SELECT shop_domain FROM settings WHERE id = 1').get() as Settings : undefined;
  db.transaction(() => {
    if (version === 1) {
      db.exec("ALTER TABLE settings DROP COLUMN access_token;");
    }
    if (legacy) {
      // Old audits used incompatible Channel/Publication IDs. Preserve them as an archive.
      db.exec('ALTER TABLE products RENAME TO legacy_products; ALTER TABLE jobs RENAME TO legacy_jobs; ALTER TABLE publications RENAME TO legacy_publications; DROP TABLE settings;');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK(id = 1), shop_domain TEXT NOT NULL DEFAULT '', session_only INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, variants_skus TEXT NOT NULL,
        active_channels_count INTEGER NOT NULL, scheduled_channels_count INTEGER NOT NULL DEFAULT 0,
        missing_channels TEXT NOT NULL, status TEXT NOT NULL,
        error_message TEXT, skip_reason TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS product_targets (
        product_id TEXT PRIMARY KEY, title TEXT NOT NULL, variants_skus TEXT NOT NULL, channels TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS products_status ON products(status, id);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY CHECK(id = 1), scan_status TEXT NOT NULL DEFAULT 'idle',
        fix_status TEXT NOT NULL DEFAULT 'idle', total_products INTEGER NOT NULL DEFAULT 0,
        scanned_products INTEGER NOT NULL DEFAULT 0, incomplete_products INTEGER NOT NULL DEFAULT 0,
        fixed_products INTEGER NOT NULL DEFAULT 0, error_message TEXT, next_cursor TEXT,
        initialized INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO settings(id) VALUES(1);
      INSERT OR IGNORE INTO jobs(id) VALUES(1);
      PRAGMA user_version = 3;
    `);
    if (version < 3) {
      // A shared channel selection is not an explicit selection for an individual product.
      reset();
      db.exec('UPDATE publications SET selected = 0');
    }
    if (oldSettings) {
      db.prepare('UPDATE settings SET shop_domain = ? WHERE id = 1').run(oldSettings.shop_domain || '');
      db.prepare('UPDATE jobs SET error_message = ? WHERE id = 1').run('La versión anterior requiere un nuevo escaneo. Selecciona los canales de destino.');
    }
    db.exec("UPDATE jobs SET scan_status = 'idle' WHERE scan_status = 'running'; UPDATE jobs SET fix_status = 'idle' WHERE fix_status = 'running'; UPDATE products SET status = 'pending' WHERE status = 'fixing';");
  })();
  if (legacy || version === 1) { db.pragma('wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); db.pragma('wal_checkpoint(TRUNCATE)'); }
  if (filename !== ':memory:') {
    for (const file of [filename, `${filename}-wal`, `${filename}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  }
  function analytics(): Analytics {
    return db.prepare(`SELECT COUNT(*) AS total,
      coalesce(SUM(status = 'complete'), 0) AS complete,
      coalesce(SUM(status = 'fixed'), 0) AS fixed,
      coalesce(SUM(${pendingWhere}), 0) AS incomplete,
      coalesce(SUM(status = 'error'), 0) AS errors,
      coalesce(SUM(status = 'skipped'), 0) AS skipped FROM products`).get() as Analytics;
  }
  function syncCounts() {
    const a = analytics();
    db.prepare('UPDATE jobs SET scanned_products = ?, incomplete_products = ?, fixed_products = ? WHERE id = 1').run(a.total, a.incomplete, a.fixed);
  }
  function reset() {
    db.exec(`DELETE FROM products; UPDATE jobs SET scan_status = 'idle', fix_status = 'idle',
      total_products = 0, scanned_products = 0, incomplete_products = 0, fixed_products = 0,
      error_message = NULL, next_cursor = NULL, initialized = 0 WHERE id = 1;`);
  }
  function decode(row: ProductRow): AuditProduct {
    return { ...row, variants_skus: JSON.parse(row.variants_skus), missing_channels: JSON.parse(row.missing_channels) };
  }
  function decodeTarget(row: TargetRow): ProductTarget {
    return { id: row.product_id, title: row.title, variants_skus: JSON.parse(row.variants_skus), channels: JSON.parse(row.channels) };
  }
  function configuredCount(): number {
    return (db.prepare('SELECT COUNT(*) AS total FROM product_targets').get() as { total: number }).total;
  }
  function getTarget(id: string): ProductTarget | null {
    const row = db.prepare('SELECT * FROM product_targets WHERE product_id = ?').get(id) as TargetRow | undefined;
    return row ? decodeTarget(row) : null;
  }
  function targetChannels(): Publication[] {
    const channels = (db.prepare('SELECT channels FROM product_targets').all() as { channels: string }[])
      .flatMap(row => JSON.parse(row.channels) as Publication[]);
    return [...new Map(channels.map(p => [p.id, p])).values()];
  }
  const upsert = db.prepare(`INSERT INTO products
    (id, title, variants_skus, active_channels_count, scheduled_channels_count, missing_channels, status, error_message, skip_reason)
    VALUES (@id, @title, @variants_skus, @active_channels_count, @scheduled_channels_count, @missing_channels, @status, @error_message, @skip_reason)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, variants_skus=excluded.variants_skus,
      active_channels_count=excluded.active_channels_count, scheduled_channels_count=excluded.scheduled_channels_count,
      missing_channels=excluded.missing_channels, status=excluded.status, error_message=excluded.error_message,
      skip_reason=excluded.skip_reason, updated_at=CURRENT_TIMESTAMP`);
  function saveProduct(p: AuditProduct) {
    upsert.run({ ...p, variants_skus: JSON.stringify(p.variants_skus), missing_channels: JSON.stringify(p.missing_channels) });
  }
  function publications(): SelectablePublication[] {
    return (db.prepare('SELECT * FROM publications ORDER BY name, id').all() as (Publication & { selected: number })[])
      .map(p => ({ ...p, selected: !!p.selected }));
  }
  function replacePublications(pubs: Publication[], selected: string[]) {
    db.exec('DELETE FROM publications');
    const insert = db.prepare('INSERT INTO publications(id, name, selected) VALUES (?, ?, ?)');
    for (const p of pubs) insert.run(p.id, p.name, selected.includes(p.id) ? 1 : 0);
  }
  return {
    close: () => db.close(),
    getSettings(): Settings {
      const row = db.prepare('SELECT shop_domain FROM settings WHERE id = 1').get() as Settings;
      return row;
    },
    saveSettings: db.transaction((domain: string, pubs: Publication[]) => {
      const previous = db.prepare('SELECT shop_domain FROM settings WHERE id = 1').get() as { shop_domain: string };
      const selected = previous.shop_domain === domain ? targetChannels().map(p => p.id) : [];
      if (previous.shop_domain !== domain || selected.some(id => !pubs.some(p => p.id === id))) reset();
      if (previous.shop_domain !== domain) db.exec('DELETE FROM product_targets');
      db.prepare('UPDATE settings SET shop_domain = ? WHERE id = 1').run(domain);
      replacePublications(pubs, []);
    }),
    getJob: () => db.prepare('SELECT * FROM jobs WHERE id = 1').get() as Job,
    setJobState(kind: 'scan' | 'fix', status: JobState, error: string | null = null) {
      db.prepare(`UPDATE jobs SET ${kind}_status = ?, error_message = ? WHERE id = 1`).run(status, error);
    },
    beginScan: db.transaction((total: number, fresh: boolean) => {
      if (fresh) reset();
      db.prepare("UPDATE jobs SET scan_status = 'running', total_products = ?, initialized = 1, error_message = NULL WHERE id = 1").run(total);
    }),
    saveScanBatch: db.transaction((products: AuditProduct[], cursor: string | null, completed: boolean) => {
      products.forEach(saveProduct);
      syncCounts();
      db.prepare('UPDATE jobs SET next_cursor = ?, scan_status = ? WHERE id = 1').run(cursor, completed ? 'completed' : 'running');
      if (completed) db.exec('UPDATE jobs SET total_products = scanned_products WHERE id = 1');
    }),
    saveProduct: db.transaction((p: AuditProduct) => { saveProduct(p); syncCounts(); }),
    nextPending: () => {
      const row = db.prepare("SELECT * FROM products WHERE status = 'pending' AND json_array_length(missing_channels) > 0 ORDER BY id LIMIT 1").get() as ProductRow | undefined;
      return row ? decode(row) : null;
    },
    retryErrors: () => db.exec("UPDATE products SET status = 'pending', error_message = NULL WHERE status = 'error'"),
    getAnalytics: analytics,
    getProducts(page: number, pageSize: number, filter: 'incomplete' | 'all' | 'skipped') {
      const where = filter === 'incomplete' ? `WHERE ${pendingWhere}` : filter === 'skipped' ? "WHERE status = 'skipped'" : '';
      const { total } = db.prepare(`SELECT COUNT(*) AS total FROM products ${where}`).get() as { total: number };
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const current = Math.min(page, pages);
      const rows = db.prepare(`SELECT * FROM products ${where} ORDER BY id LIMIT ? OFFSET ?`).all(pageSize, (current - 1) * pageSize) as ProductRow[];
      return { products: rows.map(decode), pagination: { page: current, pageSize, total, pages } };
    },
    getPublications: publications,
    getTarget,
    getTargetCount: configuredCount,
    getTargetChannels: targetChannels,
    nextTarget(after: string | null): ProductTarget | null {
      const row = db.prepare('SELECT * FROM product_targets WHERE product_id > ? ORDER BY product_id LIMIT 1').get(after || '') as TargetRow | undefined;
      return row ? decodeTarget(row) : null;
    },
    getTargets(page: number, pageSize = 20) {
      const total = configuredCount();
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const current = Math.min(page, pages);
      const rows = db.prepare('SELECT * FROM product_targets ORDER BY product_id LIMIT ? OFFSET ?').all(pageSize, (current - 1) * pageSize) as TargetRow[];
      return { products: rows.map(row => ({ ...decodeTarget(row), configured: true })), total, pages, page: current };
    },
    saveTarget: db.transaction((target: ProductTarget) => {
      const previous = getTarget(target.id);
      const changed = !previous || previous.channels.length !== target.channels.length || previous.channels.some(p => !target.channels.some(c => c.id === p.id));
      db.prepare(`INSERT INTO product_targets(product_id, title, variants_skus, channels) VALUES (?, ?, ?, ?)
        ON CONFLICT(product_id) DO UPDATE SET title=excluded.title, variants_skus=excluded.variants_skus, channels=excluded.channels`)
        .run(target.id, target.title, JSON.stringify(target.variants_skus), JSON.stringify(target.channels));
      if (changed) reset();
    }),
    removeTarget: db.transaction((id: string) => {
      const result = db.prepare('DELETE FROM product_targets WHERE product_id = ?').run(id);
      if (result.changes) reset();
    }),
    refreshPublications: db.transaction((pubs: Publication[]) => {
      const selected = targetChannels().map(p => p.id);
      if (selected.some(id => !pubs.some(p => p.id === id))) reset();
      replacePublications(pubs, []);
    }),
    reset: db.transaction(reset),
  };
}
export type Store = ReturnType<typeof createStore>;
