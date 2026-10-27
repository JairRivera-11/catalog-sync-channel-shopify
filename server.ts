import 'dotenv/config';
import path from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import { createStore } from './src/lib/db.ts';
import { createApi } from './src/lib/api.ts';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (![22, 24].includes(nodeMajor)) throw new Error('Usa Node.js 24 LTS (consulta .nvmrc) y reinstala las dependencias con npm ci.');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválido.');
const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
const publicOrigin = process.env.PUBLIC_ORIGIN;
const origins = publicOrigin ? [new URL(publicOrigin).origin] : [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
const remote = !local || origins.some(o => !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(o).hostname));
if (remote && (!publicOrigin || !process.env.APP_PASSWORD || process.env.APP_PASSWORD.length < 16)) {
  throw new Error('Para acceso remoto configura PUBLIC_ORIGIN y APP_PASSWORD de al menos 16 caracteres.');
}
if (remote && !publicOrigin?.startsWith('https://')) throw new Error('El acceso remoto requiere PUBLIC_ORIGIN con HTTPS y un proxy TLS.');
const databasePath = path.resolve(process.env.DATABASE_PATH || 'shopify_sync.db');
if (!existsSync(databasePath) && existsSync(`${databasePath}-wal`)) {
  throw new Error('Existe un WAL sin su base principal. Restaura la base completa o retira el archivo huérfano antes de iniciar.');
}
const store = createStore(databasePath);
const api = createApi({ store, origins, password: process.env.APP_PASSWORD });
let vite: { close(): Promise<void> } | undefined;
if (process.env.NODE_ENV !== 'production') {
  const { createServer } = await import('vite');
  const dev = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  vite = dev;
  api.app.use(dev.middlewares);
} else {
  const dist = path.resolve('dist');
  if (!existsSync(path.join(dist, 'index.html'))) throw new Error('Ejecuta npm run build antes de npm start.');
  api.app.use(express.static(dist));
  api.app.get('*', (_req, res) => { res.sendFile(path.join(dist, 'index.html')); });
}
const server = api.app.listen(port, host, () => {
  console.log(`Shopify Channel Sync: ${origins[0]}`);
  console.log('Los tokens de Shopify se conservan solo durante la sesión del navegador.');
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const close = new Promise<void>(resolve => server.close(() => resolve()));
  await api.dispose();
  await vite?.close();
  await close;
  store.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
