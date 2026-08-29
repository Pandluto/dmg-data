export const RIA_ACTIVE_RUN_STORAGE_KEY = 'def.ria.active-run.v1';

export type RiaUiAction = {
  actionType: string;
  occurredAt?: string;
  actor?: string;
  frame?: number;
  commandId?: string | number | null;
  payload?: Record<string, unknown>;
};

export type RiaUiActionContext = {
  baseUrl?: string;
  caseId: string;
  sessionId: string;
  runId: string;
  actor?: string;
};

export type RiaUiActionSink = {
  readonly context: Readonly<RiaUiActionContext>;
  record(action: RiaUiAction): Promise<boolean>;
  flush(): Promise<void>;
  readonly lastError: Error | null;
};

type FetchLike = typeof fetch;

export function createRiaUiActionSink(
  context: RiaUiActionContext,
  fetchImpl: FetchLike = fetch,
): RiaUiActionSink {
  const baseUrl = (context.baseUrl ?? '').replace(/\/$/, '');
  const boundContext = Object.freeze({ ...context });
  let chain = Promise.resolve();
  let lastError: Error | null = null;
  const sink: RiaUiActionSink = {
    context: boundContext,
    get lastError() { return lastError; },
    async record(action) {
      let accepted = false;
      chain = chain.then(async () => {
        try {
          const response = await fetchImpl(
            `${baseUrl}/api/ria/runs/${encodeURIComponent(context.runId)}/ui-actions?caseId=${encodeURIComponent(context.caseId)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...action,
                occurredAt: action.occurredAt ?? new Date().toISOString(),
                actor: action.actor ?? context.actor ?? 'lts-ui',
                payload: action.payload ?? {},
              }),
            },
          );
          if (!response.ok) throw new Error(`RIA UI action HTTP ${response.status}`);
          accepted = true;
          lastError = null;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      });
      await chain;
      return accepted;
    },
    async flush() { await chain; },
  };
  return sink;
}

export function configuredRiaUiActionSink(
  storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined' ? null : window.sessionStorage,
  fetchImpl: FetchLike = fetch,
): RiaUiActionSink | null {
  const raw = storage?.getItem(RIA_ACTIVE_RUN_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RiaUiActionContext>;
    if (typeof value.caseId !== 'string'
      || typeof value.sessionId !== 'string'
      || typeof value.runId !== 'string') return null;
    // The configured provider path is deliberately same-origin. Vite owns the
    // exact calculation writer and forwards unrelated RIA reads to 43822.
    return createRiaUiActionSink({
      caseId: value.caseId,
      sessionId: value.sessionId,
      runId: value.runId,
      actor: value.actor,
    }, fetchImpl);
  } catch {
    return null;
  }
}
