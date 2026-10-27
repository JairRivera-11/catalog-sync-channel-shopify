import { createStore } from '../src/lib/db.ts';
import { JobManager } from '../src/lib/jobs.ts';
import type { ShopifyGateway } from '../src/lib/shopify.ts';
import type { Publication, ShopifyProduct } from '../src/lib/types.ts';
export const pubs: Publication[] = [{ id: 'gid://shopify/Publication/1', name: 'Tienda online' }, { id: 'gid://shopify/Publication/2', name: 'POS' }];
export function product(id: string, publishedIds: string[] = []): ShopifyProduct {
  return { id: `gid://shopify/Product/${id}`, title: `Producto ${id}`, status: 'ACTIVE', requiresSellingPlan: false, skus: [`SKU-${id}`], publishedIds, scheduledIds: [] };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
export function gateway(initial = [product('1', [pubs[0].id])]) {
  const products = new Map(initial.map(p => [p.id, structuredClone(p)]));
  const calls: { id: string; ids: string[] }[] = [];
  const client: ShopifyGateway = {
    async getPublications() { return structuredClone(pubs); },
    async getProductCount() { return products.size; },
    async getProductsBatch() { return { products: structuredClone([...products.values()]), nextCursor: null }; },
    async getProduct(id) { return structuredClone(products.get(id) || null); },
    async publish(id, ids) { calls.push({ id, ids }); products.get(id)!.publishedIds.push(...ids); },
  };
  return { client, products, calls };
}
export function fixture(initial?: ShopifyProduct[]) {
  const store = createStore(':memory:');
  store.saveSettings('example.myshopify.com', pubs);
  store.selectPublications(pubs.map(p => p.id));
  const remote = gateway(initial);
  const jobs = new JobManager(store, () => remote.client, () => ({ domain: 'example.myshopify.com', token: 'fake-test-token' }), 0);
  return { store, jobs, ...remote };
}
