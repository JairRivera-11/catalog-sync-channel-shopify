import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/lib/sessions.ts';
import { deferred } from './helpers.ts';

test('logout removes credentials immediately, waits for cancellation, and invalidates the old session', async () => {
  const stopped = deferred<void>();
  let block = false;
  const sessions = new SessionManager(async () => { if (block) await stopped.promise; });
  const id = await sessions.connect('example.myshopify.com', 'session-test-secret', async () => {});
  assert.equal(sessions.authenticated(id), true);
  block = true;
  const closing = sessions.end(id);
  assert.equal(sessions.credentials(), null);
  assert.equal(sessions.authenticated(id), false);
  await assert.rejects(sessions.connect('example.myshopify.com', 'next-secret', async () => {}), /cierre/);
  stopped.resolve(); await closing;
  block = false;
  const next = await sessions.connect('example.myshopify.com', 'next-secret', async () => {});
  assert.notEqual(next, id);
  await sessions.end(id);
  assert.equal(sessions.authenticated(next), true);
  await sessions.end();
});

test('a vanished browser loses its token after the lease, with an absolute session limit despite polling', async () => {
  let time = 0;
  let stops = 0;
  const sessions = new SessionManager(async () => { stops++; }, { leaseMs: 100, maxAgeMs: 250, now: () => time });
  const id = await sessions.connect('example.myshopify.com', 'test-key', async () => {});
  time = 101; await sessions.sweep();
  assert.equal(sessions.credentials(), null); assert.equal(sessions.authenticated(id), false);
  const next = await sessions.connect('example.myshopify.com', 'next-key', async () => {});
  time = 190; assert.equal(sessions.authenticated(next), true);
  time = 280; assert.equal(sessions.authenticated(next), true);
  time = 352; await sessions.sweep();
  assert.equal(sessions.credentials(), null); assert.ok(stops >= 4);
});

test('cancelled connection validation cannot resurrect a session', async () => {
  const validation = deferred<void>(); const started = deferred<void>();
  const sessions = new SessionManager(async () => {});
  const controller = new AbortController();
  const connecting = sessions.connect('example.myshopify.com', 'test-key', async () => { started.resolve(); await validation.promise; }, undefined, controller.signal);
  await started.promise;
  controller.abort(); validation.resolve();
  await assert.rejects(connecting);
  assert.equal(sessions.credentials(), null);
});

test('another browser cannot replace an active session', async () => {
  const sessions = new SessionManager(async () => {});
  const id = await sessions.connect('example.myshopify.com', 'test-key', async () => {});
  await assert.rejects(sessions.connect('other.myshopify.com', 'other-key', async () => {}), /otra sesión/);
  assert.equal(sessions.authenticated(id), true);
  await sessions.end();
});
