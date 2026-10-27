import { setTimeout as delay } from 'node:timers/promises';
import { AppError, errorMessage, type Publication, type ShopifyProduct } from './types.ts';

export const DEFAULT_API_VERSION = '2026-10';
type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type ResourcePublication = { isPublished: boolean; publishDate: string | null; publication: { id: string } };
type ProductNode = {
  id: string; title: string; status: string; requiresSellingPlan: boolean;
  variants: Connection<{ sku: string | null }>;
  resourcePublicationsV2: Connection<ResourcePublication>;
};
type ClientOptions = { apiVersion?: string; fetch?: typeof fetch; minIntervalMs?: number; retryDelayMs?: number; timeoutMs?: number };
class ShopifyError extends Error {
  constructor(message: string, public retryable = false, public retryAfterMs = 0) { super(message); }
}

export function normalizeDomain(input: unknown): string {
  if (typeof input !== 'string') throw new AppError('Indica el dominio de Shopify.');
  const domain = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) || domain.length > 255) {
    throw new AppError('Usa un dominio como mi-tienda.myshopify.com, sin rutas ni parámetros.');
  }
  return domain;
}
function nextCursor<T>(connection: Connection<T>, previous: string | null): string | null {
  if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
    throw new Error('Shopify devolvió una página incompleta.');
  }
  if (!connection.pageInfo.hasNextPage) return null;
  const cursor = connection.pageInfo.endCursor;
  if (!cursor || cursor === previous || connection.nodes.length === 0) throw new Error('Shopify no avanzó el cursor de paginación.');
  return cursor;
}
const pageFields = 'pageInfo { hasNextPage endCursor }';
const productFields = `id title status requiresSellingPlan
  variants(first: 25) { nodes { sku } ${pageFields} }
  resourcePublicationsV2(first: 25, onlyPublished: false, catalogType: APP) {
    nodes { isPublished publishDate publication { id } } ${pageFields}
  }`;

export class ShopifyClient {
  private readonly domain: string;
  private readonly apiVersion: string;
  private readonly fetcher: typeof fetch;
  private readonly minInterval: number;
  private readonly retryDelay: number;
  private readonly timeout: number;
  private queue: Promise<unknown> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(domain: string, private readonly token: string, options: ClientOptions = {}) {
    this.domain = normalizeDomain(domain);
    this.apiVersion = options.apiVersion || process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
    if (!/^20\d{2}-(01|04|07|10)$/.test(this.apiVersion)) throw new AppError('SHOPIFY_API_VERSION debe ser una versión trimestral, por ejemplo 2026-10.');
    if (!token || /\s/.test(token)) throw new AppError('El token de Shopify es inválido.');
    this.fetcher = options.fetch || globalThis.fetch;
    this.minInterval = options.minIntervalMs ?? 333;
    this.retryDelay = options.retryDelayMs ?? 1000;
    this.timeout = options.timeoutMs ?? 30_000;
  }

  request<T>(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const task = this.queue.then(() => this.performRequest<T>(query, variables, signal));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async performRequest<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const wait = this.nextRequestAt - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(new Error('Shopify no respondió a tiempo.')), this.timeout);
        const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const response = await this.fetcher(`https://${this.domain}/admin/api/${this.apiVersion}/graphql.json`, {
          method: 'POST', redirect: 'error', signal: requestSignal,
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': this.token },
          body: JSON.stringify({ query, variables }),
        });
        const retryHeader = response.headers.get('Retry-After');
        const retryAfter = retryHeader ? Math.max(0, Number(retryHeader) * 1000 || Date.parse(retryHeader) - Date.now() || 0) : 0;
        if (!response.ok) {
          const message = response.status === 401 || response.status === 403
            ? 'Shopify rechazó las credenciales o los permisos de la aplicación.'
            : `Shopify respondió HTTP ${response.status}.`;
          throw new ShopifyError(message, response.status === 429 || response.status >= 500, retryAfter);
        }
        const servedVersion = response.headers.get('X-Shopify-API-Version');
        if (servedVersion && servedVersion !== this.apiVersion) {
          throw new ShopifyError(`La versión ${this.apiVersion} ya no está disponible. Configura SHOPIFY_API_VERSION con una versión vigente (Shopify respondió ${servedVersion}).`);
        }
        const body = await response.json() as {
          data?: T; errors?: unknown;
          extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable: number; restoreRate: number } } };
        };
        const cost = body.extensions?.cost;
        const throttle = cost?.throttleStatus;
        const costDelay = throttle && throttle.restoreRate > 0
          ? Math.max(0, ((cost?.requestedQueryCost || 0) - throttle.currentlyAvailable) / throttle.restoreRate * 1000) : 0;
        this.nextRequestAt = Date.now() + Math.max(this.minInterval, costDelay);
        if (body.errors) {
          if (!Array.isArray(body.errors) || body.errors.length === 0) throw new ShopifyError('Shopify devolvió errores con formato inválido.');
          const errors = body.errors as { message?: string; extensions?: { code?: string } }[];
          const retryable = errors.every(e => ['THROTTLED', 'INTERNAL_SERVER_ERROR'].includes(e.extensions?.code || ''));
          throw new ShopifyError(errors.map(e => e.message || e.extensions?.code || 'Error GraphQL').join('; '), retryable, costDelay);
        }
        if (!body.data || typeof body.data !== 'object') throw new ShopifyError('Shopify devolvió una respuesta sin datos.');
        return body.data;
      } catch (error) {
        signal?.throwIfAborted();
        const retryable = !(error instanceof ShopifyError) || error.retryable;
        if (!retryable || attempt === 2) {
          throw new Error(errorMessage(error).split(this.token).join('[token oculto]'));
        }
        const backoff = Math.max(this.retryDelay * 2 ** attempt, error instanceof ShopifyError ? error.retryAfterMs : 0);
        this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + backoff);
      } finally {
        if (timeout) clearTimeout(timeout);
        this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + this.minInterval);
      }
    }
    throw new Error('Se agotaron los intentos de conexión con Shopify.');
  }

  async getPublications(signal?: AbortSignal): Promise<Publication[]> {
    const pubs: Publication[] = [];
    let cursor: string | null = null;
    do {
      const data: { publications: Connection<Publication> } = await this.request(`query ChannelSyncPublications($cursor: String) {
        publications(first: 100, after: $cursor, catalogType: APP) { nodes { id name } ${pageFields} }
      }`, { cursor }, signal);
      cursor = nextCursor(data.publications, cursor);
      for (const p of data.publications.nodes) {
        if (!p.id?.startsWith('gid://shopify/Publication/') || typeof p.name !== 'string') throw new Error('Shopify devolvió una publicación inválida.');
        pubs.push(p);
      }
    } while (cursor);
    return [...new Map(pubs.map(p => [p.id, p])).values()];
  }

  async getProductCount(signal?: AbortSignal): Promise<number> {
    const data = await this.request<{ productsCount: { count: number; precision: string } }>(
      'query ChannelSyncCount { productsCount(limit: null) { count precision } }', {}, signal);
    if (!Number.isSafeInteger(data.productsCount?.count) || data.productsCount.count < 0 || data.productsCount.precision !== 'EXACT') {
      throw new Error('Shopify no devolvió un total exacto de productos.');
    }
    return data.productsCount.count;
  }

  async getProductsBatch(cursor: string | null, signal?: AbortSignal) {
    // Keep the requested GraphQL cost below 1,000 points, even before refunds.
    const data = await this.request<{ products: Connection<ProductNode> }>(`query ChannelSyncProducts($cursor: String) {
      products(first: 10, after: $cursor, sortKey: ID) { nodes { ${productFields} } ${pageFields} }
    }`, { cursor }, signal);
    const next = nextCursor(data.products, cursor);
    const products: ShopifyProduct[] = [];
    for (const p of data.products.nodes) products.push(await this.expandProduct(p, signal));
    return { products, nextCursor: next };
  }

  async getProduct(id: string, signal?: AbortSignal): Promise<ShopifyProduct | null> {
    const data = await this.request<{ product: ProductNode | null }>(`query ChannelSyncProduct($id: ID!) {
      product(id: $id) { ${productFields} }
    }`, { id }, signal);
    if (data.product === null) return null;
    return this.expandProduct(data.product, signal);
  }

  private async expandProduct(product: ProductNode, signal?: AbortSignal): Promise<ShopifyProduct> {
    if (!product?.id || typeof product.title !== 'string' || typeof product.status !== 'string' || typeof product.requiresSellingPlan !== 'boolean') {
      throw new Error('Shopify devolvió un producto incompleto.');
    }
    const variants = [...product.variants.nodes];
    let cursor = nextCursor(product.variants, null);
    while (cursor) {
      const data: { product: { variants: Connection<{ sku: string | null }> } | null } = await this.request(`query ChannelSyncVariants($id: ID!, $cursor: String) {
        product(id: $id) { variants(first: 250, after: $cursor) { nodes { sku } ${pageFields} } }
      }`, { id: product.id, cursor }, signal);
      if (!data.product) throw new Error('Un producto se eliminó durante el escaneo. Reintenta el escaneo.');
      cursor = nextCursor(data.product.variants, cursor);
      variants.push(...data.product.variants.nodes);
    }
    const resources = [...product.resourcePublicationsV2.nodes];
    cursor = nextCursor(product.resourcePublicationsV2, null);
    while (cursor) {
      const data: { product: { resourcePublicationsV2: Connection<ResourcePublication> } | null } = await this.request(`query ChannelSyncProductPublications($id: ID!, $cursor: String) {
        product(id: $id) { resourcePublicationsV2(first: 250, after: $cursor, onlyPublished: false, catalogType: APP) {
          nodes { isPublished publishDate publication { id } } ${pageFields}
        } }
      }`, { id: product.id, cursor }, signal);
      if (!data.product) throw new Error('Un producto se eliminó durante el escaneo. Reintenta el escaneo.');
      cursor = nextCursor(data.product.resourcePublicationsV2, cursor);
      resources.push(...data.product.resourcePublicationsV2.nodes);
    }
    if (resources.some(p => !p.publication?.id?.startsWith('gid://shopify/Publication/') || typeof p.isPublished !== 'boolean')) {
      throw new Error('Shopify devolvió una relación de publicación inválida.');
    }
    return {
      id: product.id, title: product.title, status: product.status, requiresSellingPlan: product.requiresSellingPlan,
      skus: [...new Set(variants.map(v => v.sku).filter((sku): sku is string => typeof sku === 'string' && !!sku))],
      publishedIds: resources.filter(p => p.isPublished).map(p => p.publication.id),
      scheduledIds: resources.filter(p => !p.isPublished && p.publishDate && Date.parse(p.publishDate) > Date.now()).map(p => p.publication.id),
    };
  }

  async publish(id: string, publicationIds: string[], signal?: AbortSignal): Promise<void> {
    for (let offset = 0; offset < publicationIds.length; offset += 250) {
      const data = await this.request<{ publishablePublish: { publishable: { __typename: string } | null; userErrors: { message: string }[] } | null }>(
        `mutation ChannelSyncPublish($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) { publishable { __typename } userErrors { field message } }
        }`, { id, input: publicationIds.slice(offset, offset + 250).map(publicationId => ({ publicationId })) }, signal);
      const payload = data.publishablePublish;
      if (!payload || !Array.isArray(payload.userErrors)) throw new Error('Shopify no confirmó la publicación.');
      if (payload.userErrors.length) throw new Error(payload.userErrors.map(e => e.message).join('; ').split(this.token).join('[token oculto]'));
      if (!payload.publishable) throw new Error('Shopify devolvió una publicación vacía.');
    }
  }
}

export type ShopifyGateway = Pick<ShopifyClient, 'getPublications' | 'getProductCount' | 'getProductsBatch' | 'getProduct' | 'publish'>;
export type ShopifyFactory = (domain: string, token: string) => ShopifyGateway;
