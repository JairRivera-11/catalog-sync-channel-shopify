import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AlertCircle, LogOut, Pause, Play, RefreshCw, RotateCcw, ShieldCheck, Wrench } from 'lucide-react';
import type { AppStatus, ProductState } from './lib/types';

class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function api<T>(endpoint: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: 'El servidor devolvió una respuesta inválida.' }));
  if (!res.ok) throw new ApiError(data.error || 'No se pudo completar la operación.', res.status);
  return data as T;
}
const labels: Record<ProductState, string> = {
  pending: 'Pendiente', fixing: 'Corrigiendo', fixed: 'Corregido', complete: 'Completo', error: 'Error', skipped: 'Omitido',
};
const stateLabels = { idle: 'En pausa', running: 'En curso', completed: 'Terminado', error: 'Requiere revisión' };
const button = 'rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold transition hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed';
const input = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500';
function Notice({ children }: { children: ReactNode }) {
  return <div role="alert" className="flex gap-2 rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-300"><AlertCircle className="h-5 w-5 shrink-0" /><div className="break-words">{children}</div></div>;
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [domain, setDomain] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [pending, setPending] = useState(false);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<'incomplete' | 'all' | 'skipped'>('incomplete');
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [confirmation, setConfirmation] = useState<'fix' | 'reset' | 'scan' | 'targets' | null>(null);

  function clearSession() {
    setAuthenticated(false); setStatus(null); setToken(''); setPassword('');
    setSelection(null); setConfirmation(null); setPage(1); setPending(false);
  }
  useEffect(() => {
    const abort = new AbortController();
    api<{ authenticated: boolean; passwordRequired: boolean }>('session', undefined, abort.signal)
      .then(data => { setAuthenticated(data.authenticated); setPasswordRequired(data.passwordRequired); })
      .catch(e => { if (!abort.signal.aborted) { setError(e.message); setAuthenticated(false); } });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api<AppStatus>(`status?page=${page}&filter=${filter}`, undefined, abort.signal);
        if (abort.signal.aborted) return;
        setStatus(data); setConnectionError('');
        if (data.pagination.page !== page) setPage(data.pagination.page);
      } catch (e) {
        if (abort.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) { clearSession(); setError(e.message); return; }
        setConnectionError(e instanceof Error ? e.message : 'Sin conexión con el servidor.');
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [authenticated, page, filter, revision]);
  useEffect(() => {
    if (!authenticated) return;
    const end = () => {
      // pagehide covers tab close, navigation and reload. The server lease is the fallback.
      navigator.sendBeacon('/api/session/end', new Blob(['{}'], { type: 'application/json' }));
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) { clearSession(); setError('Vuelve a conectar Shopify para iniciar otra sesión.'); }
    };
    window.addEventListener('pagehide', end);
    window.addEventListener('pageshow', restore);
    return () => { window.removeEventListener('pagehide', end); window.removeEventListener('pageshow', restore); };
  }, [authenticated]);

  async function connect(e: FormEvent) {
    e.preventDefault(); setPending(true); setError('');
    const credentials = { shop_domain: domain, access_token: token, password };
    setToken(''); setPassword('');
    try {
      await api('session', credentials);
      setAuthenticated(true); setStatus(null); setConnectionError(''); setSelection(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo conectar.'); }
    finally { credentials.access_token = ''; credentials.password = ''; setPending(false); }
  }
  async function action(endpoint: string, body: unknown = {}) {
    setPending(true); setError('');
    try {
      await api(endpoint, body);
      if (endpoint === 'session/end') clearSession();
      if (endpoint === 'publications/select') setSelection(null);
      if (endpoint === 'reset' || endpoint === 'scan/start') setPage(1);
      setConfirmation(null); setRevision(n => n + 1);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) clearSession();
      setError(e instanceof Error ? e.message : 'La operación falló.');
    } finally { setPending(false); }
  }

  if (authenticated === null) return <main className="grid min-h-screen place-items-center">Cargando…</main>;
  if (!authenticated) return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 px-5 py-12">
      <div><p className="mb-3 text-xs font-bold uppercase tracking-widest text-cyan-400">Shopify Channel Sync</p><h1 className="text-3xl font-bold text-white">Conecta tu tienda</h1><p className="mt-3 text-sm text-slate-400">Audita y corrige las publicaciones de tus productos en los canales que elijas.</p></div>
      <form onSubmit={connect} autoComplete="off" className="space-y-5 rounded-xl border border-slate-800 bg-slate-900 p-6">
        {error && <Notice>{error}</Notice>}
        <label className="block text-sm">Dominio de Shopify<input className={`${input} mt-2`} value={domain} onChange={e => setDomain(e.target.value)} placeholder="mi-tienda.myshopify.com" required disabled={pending} autoCapitalize="none" spellCheck={false} /></label>
        <label className="block text-sm">Token de Admin API<input className={`${input} mt-2`} type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Token de acceso de Shopify" required disabled={pending} autoComplete="off" /></label>
        {passwordRequired && <label className="block text-sm">Contraseña de la aplicación<input className={`${input} mt-2`} type="password" value={password} onChange={e => setPassword(e.target.value)} required disabled={pending} autoComplete="off" /></label>}
        <p className="text-xs leading-relaxed text-slate-400">La aplicación de Shopify necesita permisos read_products, read_publications y write_publications.</p>
        <button disabled={pending} className={`${button} w-full border-cyan-600 bg-cyan-600 text-white hover:bg-cyan-500`}>{pending ? 'Validando conexión…' : 'Conectar por esta sesión'}</button>
        <div className="flex gap-2 text-xs leading-relaxed text-slate-400"><ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" /><p>El token se usa solo en esta sesión. Se elimina al salir o caducar. Al cerrar o recargar la pestaña tendrás que volver a conectarte.</p></div>
      </form>
    </main>
  );

  const selected = selection ?? status?.publications.filter(p => p.selected).map(p => p.id) ?? [];
  const savedTargets = status?.publications.filter(p => p.selected) ?? [];
  const busy = pending || !!status?.busy;
  const unavailable = busy || !!connectionError || !status;
  const job = status?.job;
  const progress = job?.total_products ? Math.min(100, job.scanned_products / job.total_products * 100) : 0;
  function confirm() {
    if (confirmation === 'targets') void action('publications/select', { ids: selected });
    else if (confirmation === 'fix') void action('fix/start');
    else if (confirmation === 'scan') void action('scan/start');
    else if (confirmation === 'reset') void action('reset');
  }
  return (
    <main className="mx-auto max-w-7xl space-y-5 p-4 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div><h1 className="text-xl font-bold text-white">Shopify Channel Sync</h1><p className="mt-1 text-sm text-cyan-400">{status?.shopDomain || 'Cargando tienda…'}</p></div>
        <button className={`${button} flex items-center gap-2`} disabled={pending} onClick={() => void action('session/end')}><LogOut className="h-4 w-4" />Cerrar sesión y borrar token</button>
      </header>
      {error && <Notice>{error}</Notice>}
      {connectionError && <Notice>{connectionError} Los datos mostrados pueden estar desactualizados.</Notice>}
      {job?.error_message && <Notice>{job.error_message}</Notice>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {[
          ['Catálogo', job?.total_products ?? 0], ['Auditados', job?.scanned_products ?? 0],
          ['Pendientes', status?.analytics.incomplete ?? 0], ['Corregidos', status?.analytics.fixed ?? 0],
          ['Errores', status?.analytics.errors ?? 0], ['Omitidos', status?.analytics.skipped ?? 0],
        ].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs text-slate-400">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums text-white">{value}</p></div>)}
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_310px]">
        <section className="min-w-0 overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4"><h2 className="font-semibold">Resultados de auditoría</h2><select aria-label="Filtrar productos" className="rounded border border-slate-700 bg-slate-950 p-2 text-sm" value={filter} onChange={e => { setFilter(e.target.value as typeof filter); setPage(1); }}><option value="incomplete">Pendientes y errores</option><option value="all">Todos los productos</option><option value="skipped">Omitidos</option></select></div>
          <div className="max-h-[600px] overflow-auto"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-slate-800 text-xs text-slate-300"><tr><th className="p-3">Producto / SKU</th><th className="p-3">Publicaciones</th><th className="p-3">Canales faltantes</th><th className="p-3">Estado</th></tr></thead><tbody>
            {!status?.products.length && <tr><td colSpan={4} className="p-10 text-center text-slate-400">{!job?.initialized ? 'Selecciona los canales y comienza el escaneo.' : 'No hay productos para este filtro.'}</td></tr>}
            {status?.products.map(p => <tr key={p.id} className="border-t border-slate-800 align-top"><td className="min-w-48 p-3"><p className="font-medium text-slate-100">{p.title}</p><p className="mt-1 text-xs text-slate-500">{p.id.split('/').pop()}</p><p className="mt-2 max-w-72 break-words text-xs text-cyan-400">{p.variants_skus.join(', ') || 'Sin SKU'}</p></td><td className="p-3 text-xs"><span>{p.active_channels_count} activas</span>{p.scheduled_channels_count > 0 && <p className="mt-1 text-sky-400">{p.scheduled_channels_count} programadas</p>}</td><td className="min-w-40 p-3 text-xs text-slate-400">{p.missing_channels.map(c => c.name).join(', ') || 'Ninguno'}</td><td className="min-w-40 p-3"><span className={p.status === 'error' ? 'text-red-400' : p.status === 'fixed' || p.status === 'complete' ? 'text-emerald-400' : 'text-amber-400'}>{labels[p.status]}</span>{(p.error_message || p.skip_reason) && <p className="mt-2 max-w-64 break-words text-xs text-slate-400">{p.error_message || p.skip_reason}</p>}</td></tr>)}
          </tbody></table></div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 p-4 text-xs text-slate-400"><span>{status?.pagination.total ?? 0} resultados · Página {status?.pagination.page ?? 1} de {status?.pagination.pages ?? 1}</span><div className="flex gap-2"><button className={button} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Anterior</button><button className={button} disabled={!status || page >= status.pagination.pages} onClick={() => setPage(p => p + 1)}>Siguiente</button></div></div>
        </section>
        <aside className="space-y-4">
          <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
            <h2 className="font-semibold">Operaciones</h2>
            <div className="text-xs text-slate-400">Escaneo: {job ? stateLabels[job.scan_status] : '…'}<div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-800"><div className="h-full bg-cyan-500" style={{ width: `${progress}%` }} /></div></div>
            {status?.busy === 'scan' ? <button className={`${button} flex w-full items-center justify-center gap-2`} disabled={pending} onClick={() => void action('scan/stop')}><Pause className="h-4 w-4" />Detener escaneo</button> : <button className={`${button} flex w-full items-center justify-center gap-2 border-cyan-700 bg-cyan-700 text-white`} disabled={unavailable || !savedTargets.length || selection !== null} onClick={() => job?.scan_status === 'completed' ? setConfirmation('scan') : void action('scan/start')}><Play className="h-4 w-4" />{job?.initialized && job.scan_status !== 'completed' ? 'Reanudar escaneo' : 'Iniciar escaneo'}</button>}
            <p className="text-xs text-slate-400">Corrección: {job ? stateLabels[job.fix_status] : '…'}</p>
            {status?.busy === 'fix' ? <button className={`${button} flex w-full items-center justify-center gap-2`} disabled={pending} onClick={() => void action('fix/stop')}><Pause className="h-4 w-4" />Detener corrección</button> : <button className={`${button} flex w-full items-center justify-center gap-2 border-emerald-800 bg-emerald-800 text-white`} disabled={unavailable || job?.scan_status !== 'completed' || !status?.analytics.incomplete || selection !== null} onClick={() => setConfirmation('fix')}><Wrench className="h-4 w-4" />Corregir / reintentar</button>}
            <button className={`${button} flex w-full items-center justify-center gap-2 text-slate-400`} disabled={pending} onClick={() => setConfirmation('reset')}><RotateCcw className="h-4 w-4" />Reiniciar progreso</button>
          </section>
          <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="flex items-center justify-between"><h2 className="font-semibold">Canales de destino</h2><button aria-label="Actualizar canales" className="rounded p-2 hover:bg-slate-800 disabled:opacity-40" disabled={unavailable} onClick={() => { setSelection(null); void action('publications/refresh'); }}><RefreshCw className="h-4 w-4" /></button></div><p className="text-xs text-slate-400">Elige dónde deben estar publicados tus productos activos.</p><div className="max-h-60 space-y-2 overflow-auto">{status?.publications.map(p => <label key={p.id} className="flex items-start gap-2 text-sm"><input className="mt-1 accent-cyan-500" type="checkbox" checked={selected.includes(p.id)} disabled={unavailable} onChange={e => setSelection(e.target.checked ? [...selected, p.id] : selected.filter(id => id !== p.id))} /><span>{p.name}</span></label>)}</div>{!status?.publications.length && <p className="text-xs text-amber-400">No hay canales disponibles para esta aplicación.</p>}<button className={`${button} w-full`} disabled={unavailable || !selected.length || selection === null} onClick={() => job?.initialized ? setConfirmation('targets') : void action('publications/select', { ids: selected })}>Guardar selección ({selected.length})</button></section>
          <p className="flex gap-2 px-1 text-xs leading-relaxed text-slate-500"><ShieldCheck className="h-4 w-4 shrink-0" />Token temporal. Cerrar sesión detiene las tareas y elimina las credenciales de esta sesión.</p>
        </aside>
      </div>
      {confirmation && <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"><section role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="w-full max-w-md space-y-5 rounded-xl border border-slate-700 bg-slate-900 p-6"><h2 id="confirm-title" className="text-lg font-semibold">{confirmation === 'fix' ? 'Publicar en los canales seleccionados' : confirmation === 'reset' ? 'Reiniciar progreso' : confirmation === 'targets' ? 'Cambiar los canales de destino' : 'Comenzar una nueva auditoría'}</h2><p className="text-sm leading-relaxed text-slate-400">{confirmation === 'fix' ? `Se revisarán ${status?.analytics.incomplete || 0} productos pendientes y se publicarán únicamente los canales faltantes: ${savedTargets.map(p => p.name).join(', ')}. Los borradores, archivados y productos exclusivos por suscripción se omiten; las publicaciones programadas se respetan.` : confirmation === 'reset' ? 'Se detendrán las tareas activas y se borrará el progreso de la auditoría. Las publicaciones ya realizadas en Shopify permanecen.' : 'Esto reemplazará los resultados de la auditoría anterior. Después podrás iniciar un nuevo escaneo.'}</p><div className="flex justify-end gap-3"><button className={button} disabled={pending} onClick={() => setConfirmation(null)}>Cancelar</button><button className={`${button} bg-cyan-700 text-white`} disabled={pending} onClick={confirm}>{pending ? 'Procesando…' : 'Confirmar'}</button></div></section></div>}
    </main>
  );
}
