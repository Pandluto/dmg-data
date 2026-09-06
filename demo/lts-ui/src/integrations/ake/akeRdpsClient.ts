import type { AkeTeamReport } from './akeProvider';
import type { calculateAkeRdps } from './akeRdpsAttribution';
import { publishRiaDebugSection, recordRiaDebugEvent } from './riaLiveDebug';
type Result = ReturnType<typeof calculateAkeRdps>;
let requestSequence = 0;
const cache = new Map<string, Promise<Result>>();
export async function prepareAkeReportRdps(report: AkeTeamReport): Promise<AkeTeamReport> {
  const requestId = ++requestSequence;
  const key = `${report.workspaceId}|${report.generatedAt}|${report.executionDigest}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = new Promise<Result>((resolve, reject) => {
      const worker = new Worker(new URL('./akeRdps.worker.ts', import.meta.url), { type: 'module' });
      const timer = window.setTimeout(() => { worker.terminate(); reject(new Error('RD 归因计算超时，请重新计算。')); }, 30_000);
      const finish = () => { clearTimeout(timer); worker.terminate(); };
      worker.onmessage = (event: MessageEvent<{ result?: Result; error?: string }>) => {
        finish();
        if (event.data.result) resolve(event.data.result);
        else reject(new Error(event.data.error ?? 'RD 归因失败。'));
      };
      worker.onerror = event => { finish(); reject(new Error(event.message || 'RD 后台线程加载失败。')); };
      worker.postMessage(report);
    });
    cache.set(key, pending);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
    void pending.catch(() => cache.delete(key));
  }
  publishRiaDebugSection('report', { phase: 'attributing', workspaceId: report.workspaceId, executionDigest: report.executionDigest });
  try {
    const { summary, audit } = await pending;
    if (requestId === requestSequence) publishRiaDebugSection('report', { phase: 'completed', workspaceId: report.workspaceId, executionDigest: report.executionDigest,
      generatedAt: report.generatedAt, rdps: summary, audit });
    recordRiaDebugEvent('calculation', 'RdpsCompleted', { hitCount: audit.hitCount, elapsedMs: audit.elapsedMs,
      coalitionEvaluationCount: summary.diagnostics.coalitionEvaluationCount, accountingError: summary.accountingError });
    return { ...report, rdps: summary, rdpsAudit: audit };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (requestId === requestSequence) publishRiaDebugSection('report', { phase: 'failed', workspaceId: report.workspaceId, error: message });
    recordRiaDebugEvent('error', 'RdpsFailed', { message });
    throw error;
  }
}
