import { normalizeCompatibleTimelinePayload } from '../../platform/timeline/timelinePayloadCompatibility';
import { createTimelineRepositoryClient } from '../../agentKernel/timelineRepository/localTimelineClient';
import { activateTimelineSession, getTimelineSessionSnapshot } from '../../agentKernel/timelineRepository/timelineSession';
import { saveTimelineCheckpoint } from '../../core/services/timelineCheckpointService';
import { createEmptyTimelineData } from '../../core/services/timelineService';
import { flushPersistentStorage } from '../../platform/storage/persistentStorage';
import { applyTimelineSnapshotPayload, buildTimelineBundleV2, getCurrentTimelineSnapshotPayload,
  parseTimelineBundleV2, parseTimelineShareFile, type TimelineSnapshotPayload, type TimelineSnapshotEntry } from '../../utils/timelineSnapshotStorage';
import { getInstalledAkeCatalog } from './akeCatalogAdapter';

const repository = createTimelineRepositoryClient();
let pending: Promise<unknown> | null = null;
async function exclusively<T>(operation: () => Promise<T>): Promise<T> {
  if (pending) throw new Error('存档操作尚未完成，请稍候。');
  const task = operation(); pending = task;
  try { return await task; } finally { if (pending === task) pending = null; }
}

async function saveWorkspaceNow(payload = getCurrentTimelineSnapshotPayload(), label?: string) {
  if (!payload) throw new Error('当前工作区尚未载入。');
  payload = normalizeCompatibleTimelinePayload(payload).payload;
  const session = getTimelineSessionSnapshot();
  const result = await saveTimelineCheckpoint({ timelineId: session.activeTimelineId,
    timelineLabel: label?.trim() || session.activeTimelineLabel, payload, reason: '保存队伍配置与 AKE 排轴输入。' });
  if (label?.trim() || session.activeTimelineIsTemporary) {
    const document = await repository.ensureDocument({ id: session.activeTimelineId,
      label: label?.trim() || session.activeTimelineLabel || '未命名排轴', isTemporary: false });
    activateTimelineSession({ document, checkoutRef: result.checkoutRef, workingPayload: payload });
  }
  await flushPersistentStorage();
  return result;
}

export function saveAkeWorkspace(payload = getCurrentTimelineSnapshotPayload(), label?: string) {
  return exclusively(() => saveWorkspaceNow(payload, label));
}

async function preserveCurrent() {
  const payload = getCurrentTimelineSnapshotPayload();
  if (payload) await saveWorkspaceNow(payload);
}

function activate(applied: Awaited<ReturnType<typeof repository.applySqliteWorkspace>>) {
  applyTimelineSnapshotPayload(applied.payload);
  activateTimelineSession({ document: applied.document, checkoutRef: applied.checkoutRef, workingPayload: applied.payload });
}

export const listAkeWorkspaces = () => repository.listSqliteWorkspaces();

export function createAkeWorkspace(label: string) {
  return exclusively(async () => {
    await preserveCurrent();
    const id = `ake-workspace-${crypto.randomUUID()}`;
    const now = Date.now();
    const catalog = getInstalledAkeCatalog();
    const payload: TimelineSnapshotPayload = {
      source: { engine: 'ake', schemaVersion: 1, dataVersion: catalog?.source.version ?? '', sharedRevision: catalog?.source.sharedRevision ?? '' },
      selectedCharacters: [], timelineData: createEmptyTimelineData([]), skillButtonTable: {}, allBuffList: [],
      anomalyStateSnapshots: [], characterInputMap: {}, characterComputedMap: {}, characterDisplayCacheMap: {}, operatorConfigPageCache: {},
    };
    await repository.importDocumentBundle({ document: { id, label: label.trim() || '未命名排轴', isTemporary: false },
      snapshots: [{ id: `${id}-initial`, label: '初始版本', payload, createdAt: now }],
      checkoutRef: { targetType: 'snapshot', targetId: `${id}-initial`, updatedAt: now } });
    const applied = await repository.applySqliteWorkspace(id);
    activate(applied); await flushPersistentStorage();
    return applied;
  });
}

export function openAkeWorkspace(id: string) {
  return exclusively(async () => {
    await preserveCurrent();
    const applied = await repository.applySqliteWorkspace(id);
    activate(applied); await flushPersistentStorage();
    return applied;
  });
}

export function exportAkeWorkspace(id = getTimelineSessionSnapshot().activeTimelineId) {
  return exclusively(async () => {
  if (id === getTimelineSessionSnapshot().activeTimelineId) await preserveCurrent();
  const bundle = await repository.exportDocumentBundle(id);
  const snapshots: TimelineSnapshotEntry[] = bundle.snapshots.flatMap(snapshot => snapshot.payload ? [{ ...snapshot, payload: snapshot.payload,
    summary: { characterCount: snapshot.payload.selectedCharacters.length,
      buttonCount: Object.keys(snapshot.payload.skillButtonTable).length, buffCount: snapshot.payload.allBuffList.length } }] : []);
  if (!snapshots.length) {
    const payload = bundle.workNodes.find(node => node.id === bundle.checkoutRef?.targetId)?.workingPayload
      ?? bundle.workNodes[0]?.workingPayload;
    if (!payload) throw new Error('存档没有可导出的版本。');
    snapshots.push({ id: `${id}-export-base`, label: '存档基线', createdAt: bundle.document.createdAt, payload,
      summary: { characterCount: payload.selectedCharacters.length, buttonCount: Object.keys(payload.skillButtonTable).length, buffCount: payload.allBuffList.length } });
  }
  return buildTimelineBundleV2({ timelineId: id, label: bundle.document.label, snapshot: snapshots[0], snapshots,
    workNodes: bundle.workNodes, commits: bundle.commits, checkoutRef: bundle.checkoutRef, scope: 'document' });
  });
}

export function importAkeWorkspace(raw: string) {
  return exclusively(async () => {
    let bundle = await parseTimelineBundleV2(raw);
    if (!bundle) {
      const share = parseTimelineShareFile(raw);
      if (!share) throw new Error('无法识别这个存档文件，或文件校验失败。');
      bundle = await buildTimelineBundleV2({ timelineId: `import-${crypto.randomUUID()}`, label: share.label,
        snapshot: { id: `snapshot-${crypto.randomUUID()}`, label: share.label, createdAt: share.exportedAt,
          summary: { characterCount: share.payload.selectedCharacters.length, buttonCount: Object.keys(share.payload.skillButtonTable).length, buffCount: 0 }, payload: share.payload } });
    }
    const known = new Set(getInstalledAkeCatalog()?.characters.map(character => character.id) ?? []);
    const missing = [...new Set(bundle.payloads.flatMap(payload => payload.selectedCharacters))].filter(id => !known.has(id));
    if (missing.length) throw new Error(`存档含当前 AKE 目录未收录的干员：${missing.join('、')}`);
    await preserveCurrent();
    const imported = await repository.importLegacyTimelineBundle({ bundle, sourceName: `${bundle.manifest.label}.json` });
    const converted = await repository.convertTimelineArchive({ source: 'local', archiveId: imported.archive.archiveId, payloadOnly: false, updatedAt: Date.now() });
    applyTimelineSnapshotPayload(converted.payload);
    activateTimelineSession({ document: converted.document, checkoutRef: converted.checkoutRef, workingPayload: converted.payload });
    await flushPersistentStorage();
    return converted;
  });
}

/** Full archive evidence for developer inspection, available outside the Canvas too. */
export async function inspectAkeWorkspace(timelineId?: string) {
  const session = getTimelineSessionSnapshot();
  const bundle = await repository.exportDocumentBundle(timelineId ?? session.activeTimelineId);
  const payload = timelineId
    ? (bundle.checkoutRef?.targetType === 'work-node'
      ? bundle.workNodes.find(node => node.id === bundle.checkoutRef?.targetId)?.workingPayload
      : bundle.snapshots.find(snapshot => snapshot.id === bundle.checkoutRef?.targetId)?.payload)
    : getCurrentTimelineSnapshotPayload();
  return { activeTimelineId: session.activeTimelineId, activeTimelineLabel: session.activeTimelineLabel,
    activeTimelineIsTemporary: session.activeTimelineIsTemporary, checkout: session.checkoutRef,
    payload, documents: await repository.listDocuments(), document: bundle.document, documentCheckout: bundle.checkoutRef,
    nodes: bundle.workNodes.map(node => ({ id: node.id, parentNodeId: node.parentNodeId, label: node.label, updatedAt: node.updatedAt })) };
}
