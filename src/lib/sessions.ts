import { randomBytes } from 'node:crypto';
import { AppError } from './types.ts';

interface Session { id: string; domain: string; token: string; createdAt: number; lastSeen: number }
interface Options { leaseMs?: number; maxAgeMs?: number; now?: () => number }

/** Credentials are owned by one browser session and never serialized to disk. */
export class SessionManager {
  private session: Session | null = null;
  private connecting = false;
  private generation = 0;
  private closing: Promise<void> | null = null;
  private readonly leaseMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  constructor(private onEnd: () => Promise<void>, options: Options = {}) {
    this.leaseMs = options.leaseMs ?? 120_000;
    this.maxAgeMs = options.maxAgeMs ?? 8 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }
  private expired(s: Session) {
    return this.now() - s.lastSeen >= this.leaseMs || this.now() - s.createdAt >= this.maxAgeMs;
  }
  authenticated(id: string | undefined, touch = true): boolean {
    const s = this.session;
    if (!s || !id || s.id !== id) return false;
    if (this.expired(s)) { void this.end(id).catch(() => undefined); return false; }
    if (touch) s.lastSeen = this.now();
    return true;
  }
  credentials(): { domain: string; token: string } | null {
    const s = this.session;
    if (!s) return null;
    if (this.expired(s)) { void this.end(s.id).catch(() => undefined); return null; }
    return { domain: s.domain, token: s.token };
  }
  async connect(domain: string, token: string, validate: () => Promise<void>, previousId?: string, signal?: AbortSignal) {
    if (this.connecting || this.closing) throw new AppError('Espera a que termine la conexión o el cierre de sesión.', 409);
    if (this.session && !this.expired(this.session) && this.session.id !== previousId) {
      throw new AppError('Hay otra sesión conectada. Ciérrala o espera a que caduque.', 409);
    }
    this.connecting = true;
    const cancel = () => { void this.end().catch(() => undefined); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await this.end();
      signal?.throwIfAborted();
      const generation = this.generation;
      await validate();
      signal?.throwIfAborted();
      if (generation !== this.generation) throw new AppError('La conexión se canceló.', 409);
      const id = randomBytes(32).toString('base64url');
      this.session = { id, domain, token, createdAt: this.now(), lastSeen: this.now() };
      return id;
    } finally { signal?.removeEventListener('abort', cancel); this.connecting = false; }
  }
  async end(id?: string): Promise<void> {
    if (id && this.session?.id !== id) return;
    this.generation++;
    if (this.session) {
      this.session.token = '';
      this.session = null;
    }
    if (!this.closing) {
      this.closing = this.onEnd().finally(() => { this.closing = null; });
    }
    await this.closing;
  }
  async sweep() {
    if (this.session && this.expired(this.session)) await this.end(this.session.id);
  }
}
