import {
  createRiaUiActionSink,
  configuredRiaUiActionSink,
  RIA_ACTIVE_RUN_STORAGE_KEY,
} from './riaUiActionSink';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: ${String(actual)} !== ${String(expected)}`);
}

export async function runRiaUiActionSinkTests(): Promise<void> {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  }) as typeof fetch;
  const sink = createRiaUiActionSink({
    baseUrl: 'http://127.0.0.1:43822',
    caseId: 'case-ui',
    sessionId: 'session-ui',
    runId: 'run-ui',
  }, fakeFetch);
  assertEqual(await sink.record({ actionType: 'CalculationRequested', payload: { commandCount: 2 } }), true, 'action accepted');
  await sink.flush();
  assertEqual(requests.length, 1, 'one request');
  assertEqual(requests[0].body.actionType, 'CalculationRequested', 'action type');
  assertEqual(requests[0].url.includes('caseId=case-ui'), true, 'case query');

  const configured = configuredRiaUiActionSink({
    getItem(key: string) {
      return key === RIA_ACTIVE_RUN_STORAGE_KEY
        ? JSON.stringify({ caseId: 'case-ui', sessionId: 'session-ui', runId: 'run-ui' })
        : null;
    },
  }, fakeFetch);
  assertEqual(configured !== null, true, 'configured sink');
}

await runRiaUiActionSinkTests();
