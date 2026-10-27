import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain, ShopifyClient } from '../src/lib/shopify.ts';

function client(respond: (query: string, variables: Record<string, unknown>, signal?: AbortSignal | null) => Promise<Response> | Response, timeoutMs = 100) {
  return new ShopifyClient('example.myshopify.com', 'fake-token', {
    minIntervalMs: 0, retryDelayMs: 0, timeoutMs,
    fetch: (async (_url, options) => {
      const body = JSON.parse(options!.body as string);
      return respond(body.query, body.variables, options!.signal);
    }) as typeof fetch,
  });
}
const response = (data: unknown) => Response.json({ data });
const page = <T>(nodes: T[], cursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } });
const resource = (id: number, isPublished = true) => ({ isPublished, publishDate: isPublished ? null : '2099-01-01T00:00:00Z', publication: { id: `gid://shopify/Publication/${id}` } });

test('domain validation restricts outgoing credentials to Shopify hosts', () => {
  assert.equal(normalizeDomain(' https://My-Shop.myshopify.com/ '), 'my-shop.myshopify.com');
  for (const domain of ['evil.example', 'shop.myshopify.com.evil.example', 'evil.example@shop.myshopify.com', 'shop.myshopify.com/path', 'shop.myshopify.com:443', '127.0.0.1']) assert.throws(() => normalizeDomain(domain));
});

test('throttling exhausts retries with an explicit error; permanent HTTP errors are not retried', async () => {
  let attempts = 0;
  const throttled = client(() => { attempts++; return Response.json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }); });
  await assert.rejects(throttled.request('query {}'), /Throttled/); assert.equal(attempts, 3);
  attempts = 0;
  const unauthorized = client(() => { attempts++; return new Response('', { status: 401 }); });
  await assert.rejects(unauthorized.request('query {}'), /credenciales/); assert.equal(attempts, 1);
});

test('null mutation payload, missing confirmation, and user errors cannot report success', async () => {
  for (const payload of [null, {}, { publishable: null, userErrors: [] }, { publishable: {}, userErrors: [{ message: 'Invalid publication' }] }]) {
    await assert.rejects(client(() => response({ publishablePublish: payload })).publish('p1', ['pub1']));
  }
  await assert.rejects(client(() => response({ publishablePublish: { publishable: null, userErrors: [{ message: 'Error fake-token' }] } })).publish('p1', ['pub1']), e => {
    assert.doesNotMatch((e as Error).message, /fake-token/); return true;
  });
});

test('timeout and cancellation settle requests; version fallback is rejected', async () => {
  let calls = 0;
  const stalled = client((_q, _v, signal) => { calls++; return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); }, 5);
  await assert.rejects(stalled.request('query {}'), /tiempo/); assert.equal(calls, 3);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(stalled.request('query {}', {}, abort.signal)); assert.equal(calls, 3);
  await assert.rejects(client(() => Response.json({ data: {} }, { headers: { 'X-Shopify-API-Version': '2027-01' } })).request('query {}'), /versión/);
});

test('publications, product variants and product publications traverse all pages', async () => {
  const seen: string[] = [];
  const api = client((q, v) => {
    seen.push(q);
    if (q.includes('query ChannelSyncPublications')) return response({ publications: v.cursor ? page([{ id: 'gid://shopify/Publication/101', name: 'Last' }]) : page(Array.from({ length: 100 }, (_, i) => ({ id: `gid://shopify/Publication/${i + 1}`, name: `P${i}` })), 'pubs-2') });
    if (q.includes('query ChannelSyncVariants')) return response({ product: { variants: page([{ sku: 'SKU-26' }]) } });
    if (q.includes('query ChannelSyncProductPublications')) return response({ product: { resourcePublicationsV2: page([resource(26, false)]) } });
    return response({ products: page([{
      id: 'gid://shopify/Product/1', title: 'Product', status: 'ACTIVE', requiresSellingPlan: false,
      variants: page(Array.from({ length: 25 }, (_, i) => ({ sku: `SKU-${i + 1}` })), 'variants-2'),
      resourcePublicationsV2: page(Array.from({ length: 25 }, (_, i) => resource(i + 1)), 'product-pubs-2'),
    }]) });
  });
  assert.equal((await api.getPublications()).length, 101);
  const batch = await api.getProductsBatch(null);
  assert.equal(batch.products[0].skus.length, 26);
  assert.equal(batch.products[0].publishedIds.length, 25);
  assert.deepEqual(batch.products[0].scheduledIds, ['gid://shopify/Publication/26']);
  assert.ok(seen.some(q => q.includes('onlyPublished: false')));
});

test('pagination that cannot advance fails instead of looping forever', async () => {
  const api = client(() => response({ publications: page([{ id: 'gid://shopify/Publication/1', name: 'P1' }], 'same') }));
  await assert.rejects(api.getPublications(), /cursor/);
});

test('an unpublished staged resource without a future date is not mistaken for a scheduled publication', async () => {
  const api = client(() => response({ product: {
    id: 'gid://shopify/Product/1', title: 'Product', status: 'ACTIVE', requiresSellingPlan: false,
    variants: page([{ sku: 'SKU' }]),
    resourcePublicationsV2: page([{ isPublished: false, publishDate: null, publication: { id: 'gid://shopify/Publication/1' } }]),
  } }));
  const product = await api.getProduct('gid://shopify/Product/1');
  assert.deepEqual(product?.publishedIds, []);
  assert.deepEqual(product?.scheduledIds, []);
});
