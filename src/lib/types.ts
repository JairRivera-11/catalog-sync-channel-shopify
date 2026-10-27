export interface Publication { id: string; name: string }
export interface SelectablePublication extends Publication { selected: boolean }
export interface ProductTarget {
  id: string; title: string; variants_skus: string[]; channels: Publication[];
}
export interface CatalogProduct extends ProductTarget {
  configured: boolean; shopify_status?: string; published_ids?: string[];
}
export interface ProductChoices {
  products: CatalogProduct[]; total?: number; pages?: number; page?: number; nextCursor?: string | null;
}
export type ProductState = 'pending' | 'complete' | 'fixing' | 'fixed' | 'error' | 'skipped';
export type JobState = 'idle' | 'running' | 'completed' | 'error';
export interface ShopifyProduct {
  id: string; title: string; status: string; requiresSellingPlan: boolean;
  skus: string[]; publishedIds: string[]; scheduledIds: string[];
}
export interface AuditProduct {
  id: string; title: string; variants_skus: string[];
  active_channels_count: number; scheduled_channels_count: number;
  missing_channels: Publication[]; status: ProductState;
  error_message: string | null; skip_reason: string | null;
}
export interface Job {
  scan_status: JobState; fix_status: JobState; total_products: number;
  scanned_products: number; incomplete_products: number; fixed_products: number;
  error_message: string | null; next_cursor: string | null; initialized: number;
}
export interface Analytics {
  total: number; complete: number; fixed: number; incomplete: number; errors: number; skipped: number;
}
export interface AppStatus {
  isConfigured: boolean; shopDomain: string; job: Job; analytics: Analytics;
  publications: SelectablePublication[]; products: AuditProduct[];
  configuredProducts: number;
  pagination: { page: number; pageSize: number; total: number; pages: number };
  busy: string | null;
}
export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error inesperado';
}
