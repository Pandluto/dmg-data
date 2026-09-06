import { installMainWorkbenchTransport, enqueueMainWorkbenchCommand, readMainWorkbenchCommandQueue,
  readMainWorkbenchSnapshot, patchMainWorkbenchCommand } from '../../utils/mainWorkbenchControl';
import { createRiaUiActionSink, type RiaUiActionSink } from './riaUiActionSink';
import type { SkillReleaseAnchor } from '../../types';

type DebugKind = 'interaction' | 'app-action' | 'console' | 'error' | 'network' | 'state' | 'calculation' | 'command';
type Section = 'workbench' | 'timeline' | 'planner' | 'calculation' | 'inspection' | 'report' | 'releaseLens' | 'ui';
type DebugEvent = { clientSequence: number; occurredAt: string; kind: DebugKind; type: string;
  runId: string | null; commandId?: string | null; payload: unknown };
type Context = { caseId: string; sessionId: string };
type TimelineDragStep = { clientX: number; clientY: number; holdMs?: number };
export type RiaDebugCommand = { op: 'inspect-command' | 'open-details' | 'set-panel' | 'recalculate' | 'snapshot' | 'workspace-snapshot' | 'edit-timeline' | 'timeline-drag'; commandId?: string; timelineId?: string; panel?: 'tools' | 'combat';
  buttonId?: string; steps?: TimelineDragStep[]; finish?: 'release' | 'cancel';
  edit?: { kind: 'add'; characterId: string; runtimeSkillId: string; nodeIndex?: number; staffIndex?: number; releaseAnchor?: SkillReleaseAnchor } | { kind: 'remove'; buttonId: string } };
type CommandEntry = { id: string; command: RiaDebugCommand };
type CommandResult = { status: 'done' | 'error'; result?: unknown; error?: string };

const enabled = () => import.meta.env.VITE_AKE_DEMO === '1' && typeof window !== 'undefined'
  && ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
let context: Context | null = null;
let connecting: Promise<Context | null> | null = null;
let started = false;
let sequence = 0;
let activeRunId: string | null = null;
let lastInteractionSequence: number | null = null;
let lastError = '';
let nextConnectAt = 0;
let events: DebugEvent[] = [];
let dirty: Partial<Record<Section, unknown>> = {};
const sections: Partial<Record<Section, unknown>> = {};
const signatures = new Map<Section, string>();
let flushing = false;
let polling = false;
let dragReplay: AbortController | null = null;
let lastReleaseLensOpenedSequence = 0;
let dropped = 0;
let handler: ((command: RiaDebugCommand) => unknown | Promise<unknown>) | null = null;
const completed = new Map<string, CommandResult>();
const rawFetch: typeof fetch = (...args) => fetch(...args);
let transportFetch = rawFetch;
const cleanups: Array<() => void> = [];
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function bounded(value: unknown, maxBytes: number) {
  const length = bytes(value);
  return length <= maxBytes ? value : { truncated: true, originalBytes: length,
    reason: 'Live observation limit; full simulation facts are available through the linked RIA Run.',
    preview: JSON.stringify(value).slice(0, 8000) };
}

function serialize(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/password|passwd|secret|token|authorization|cookie|credential|api[-_]?key/i.test(key)) return '[REDACTED]';
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
    if (typeof item === 'bigint') return String(item);
    if (item && typeof item === 'object') { if (seen.has(item)) return '[CIRCULAR]'; seen.add(item); }
    return item;
  }) ?? 'null');
}

export function recordRiaDebugEvent(kind: DebugKind, type: string, payload: unknown,
  refs: { runId?: string | null; commandId?: string | null } = {}) {
  if (!enabled()) return;
  try {
    const event = { clientSequence: ++sequence, occurredAt: new Date().toISOString(), kind, type,
      runId: refs.runId === undefined ? activeRunId : refs.runId, commandId: refs.commandId, payload: bounded(serialize(payload), 128_000) };
    if (kind === 'interaction' || kind === 'app-action' || type === 'DebugCommandStarted') lastInteractionSequence = event.clientSequence;
    if (kind === 'interaction' && type === 'ReleaseLensOpened') lastReleaseLensOpenedSequence = event.clientSequence;
    events.push(event);
    if (events.length > 2000) { events.shift(); dropped += 1; }
  } catch { lastError = '无法序列化一条调试事件'; }
}

export function publishRiaDebugSection(name: Section, value: unknown) {
  if (!enabled()) return;
  try {
    const safe = bounded(serialize(value), 512_000);
    const signature = JSON.stringify(safe);
    if (signatures.get(name) === signature) return;
    signatures.set(name, signature); sections[name] = safe; dirty[name] = safe;
  } catch { lastError = `无法序列化调试快照 ${name}`; }
}

async function request(url: string, body?: unknown) {
  const response = await transportFetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`调试接口 ${response.status}: ${url}`);
  return response.json();
}

async function connect(): Promise<Context | null> {
  if (!enabled()) return null;
  if (context) return context;
  if (connecting) return connecting;
  if (Date.now() < nextConnectAt) return null;
  connecting = (async () => {
    try {
      context = await request('/api/ria/live/connect', {
        title: document.title, route: location.hash.split('?')[0], userAgent: navigator.userAgent,
        viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
      });
      dirty = { ...sections }; lastError = '';
      return context;
    } catch (error) {
      lastError = String(error); nextConnectAt = Date.now() + 5000; return null;
    } finally { connecting = null; }
  })();
  return connecting;
}

function targetInfo(target: EventTarget | null) {
  const el = target instanceof Element ? target : null;
  const control = el?.closest('button, input, select, textarea, [role], [data-skill-button-id]') ?? el;
  if (!control) return null;
  const skill = el?.closest('[data-skill-button-id]');
  return { tag: control.tagName, id: control.id, role: control.getAttribute('role'),
    label: control.getAttribute('aria-label') ?? control.getAttribute('title') ?? control.textContent?.trim().slice(0, 200),
    commandId: skill?.getAttribute('data-skill-button-id') ?? null,
    name: control.getAttribute('name'), inputType: control.getAttribute('type') };
}
function captureUi() {
  const controls = [...document.querySelectorAll('button, input, select, [role="tab"], [data-skill-button-id], [data-drag-source-id]')]
    .filter(el => el.getClientRects().length > 0).slice(0, 500).map(el => ({ ...targetInfo(el),
      dragSourceId: el.getAttribute('data-drag-source-id'),
      disabled: el.hasAttribute('disabled'), dragDisabled: el.getAttribute('data-drag-disabled') === 'true', selected: el.getAttribute('aria-selected'),
      expanded: el.getAttribute('aria-expanded'),
      pressed: el.getAttribute('aria-pressed'), batchSelected: el.getAttribute('data-batch-selected') === 'true',
      value: el instanceof HTMLSelectElement ? el.value
        : el instanceof HTMLInputElement && ['number', 'range', 'checkbox', 'radio'].includes(el.type)
          ? ['checkbox', 'radio'].includes(el.type) ? el.checked : el.value : undefined,
      bounds: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })(),
    }));
  const images = [...document.images].slice(0, 200).map(img => {
    const rect = img.getBoundingClientRect();
    return { alt: img.alt, src: resourceUrl(img.currentSrc || img.src), complete: img.complete,
      naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
      width: Math.round(rect.width), height: Math.round(rect.height), loading: img.loading,
      loadState: img.dataset.assetState ?? null,
      inViewport: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
        && rect.right > 0 && rect.left < innerWidth };
  });
  publishRiaDebugSection('ui', { route: location.hash.split('?')[0], title: document.title,
    viewport: { width: innerWidth, height: innerHeight }, focused: targetInfo(document.activeElement), controls, images,
    batchSelection: {
      active: Boolean(document.querySelector('.canvas-batch-selection-layer')),
      reading: Boolean(document.querySelector('.canvas-container.is-browse-mode')),
      selectedButtonIds: [...document.querySelectorAll('[data-skill-button-id][data-batch-selected="true"]')]
        .map(el => el.getAttribute('data-skill-button-id')),
      menu: document.querySelector('.timeline-batch-context-menu')?.textContent?.trim() ?? null,
      notice: document.querySelector('.canvas-work-node-save-notice')?.textContent?.trim() ?? null,
      undoAvailable: Boolean(document.querySelector('.canvas-batch-undo-notice')),
    },
    dragPreviews: [...document.querySelectorAll<HTMLElement>('.dragging-skill-button-preview')].map(el => {
      const r = el.getBoundingClientRect(); const style = getComputedStyle(el);
      return { text: el.textContent, bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
        opacity: style.opacity, filter: style.filter, backdropFilter: style.backdropFilter, boxShadow: style.boxShadow,
        pointerEvents: style.pointerEvents, parent: el.parentElement?.tagName };
    }),
    stateMarkerLayouts: [...document.querySelectorAll<HTMLElement>('.ake-state-markers-layer')].map(layer => {
      const bounds = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const selector = layer.dataset.stateObstacleSelector;
      const obstacles = selector ? [...(layer.closest('.canvas-container')?.querySelectorAll(selector) ?? [])]
        .filter(el => { const r = el.getBoundingClientRect(), style = getComputedStyle(el); return r.width > 0 && r.height > 0
          && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'; })
        .map(el => ({ className: el.className, bounds: bounds(el) })) : [];
      return { bounds: bounds(layer), obstacles, markers: [...layer.querySelectorAll<HTMLElement>('[data-state-event-keys]')].map(el => ({
        keys: JSON.parse(el.dataset.stateEventKeys ?? '[]'), frame: el.dataset.stateEventFrame,
        stacks: el.dataset.stateStacks, tone: el.dataset.stateTone, text: el.textContent,
        anchor: { x: el.dataset.stateAnchorX, y: el.dataset.stateAnchorY }, bounds: bounds(el),
        countBounds: el.querySelector('b') ? bounds(el.querySelector('b')!) : null,
        color: getComputedStyle(el).color, collapsed: el.classList.contains('ake-state-event-summary'),
        backgroundColor: getComputedStyle(el).backgroundColor,
        iconColor: el.querySelector('.ake-state-icon-mask')
          ? getComputedStyle(el.querySelector('.ake-state-icon-mask')!).backgroundColor : null,
      })) };
    }),
    resourceTimings: performance.getEntriesByType('resource').filter(isImageResource).slice(-100).map(resourceTiming) });
}

function resourceUrl(value: string) {
  if (!value) return '';
  if (/^(?:blob|data):/i.test(value)) return value.split(':', 1)[0] + ':[local image]';
  try { const url = new URL(value, location.href); return url.origin === location.origin ? url.pathname : url.origin + url.pathname; }
  catch { return value.slice(0, 180); }
}
function isImageResource(entry: PerformanceEntry) {
  return (entry as PerformanceResourceTiming).initiatorType === 'img'
    || /\.(png|webp|avif|jpe?g|svg|zip|bin)(?:\?|$)/i.test(entry.name);
}
function resourceTiming(entry: PerformanceEntry) {
  const value = entry as PerformanceResourceTiming;
  return { url: resourceUrl(value.name), initiatorType: value.initiatorType,
    startTime: Math.round(value.startTime), durationMs: Math.round(value.duration),
    transferSize: value.transferSize, encodedBodySize: value.encodedBodySize,
    decodedBodySize: value.decodedBodySize, responseStatus: value.responseStatus };
}

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const session = await connect(); if (!session) return;
    const batch: DebugEvent[] = [];
    let batchBytes = 0;
    for (const event of events.slice(0, 200)) {
      const length = bytes(event);
      if (batch.length && batchBytes + length > 512_000) break;
      batch.push(event); batchBytes += length;
    }
    const changed = dirty; dirty = {};
    try {
      await request(`/api/ria/live/sessions/${session.sessionId}/ingest`, { events: batch, sections: changed, runId: activeRunId });
      const accepted = batch[batch.length - 1]?.clientSequence ?? 0;
      events = events.filter(event => event.clientSequence > accepted);
      lastError = '';
      if (dropped) { const count = dropped; dropped = 0; recordRiaDebugEvent('error', 'ObservationBufferOverflow', { dropped: count }); }
    } catch (error) { dirty = { ...changed, ...dirty }; lastError = String(error); }
  } finally { flushing = false; }
}

/** Bounded gesture reproduction through the same DOM handlers as a mouse drag. */
async function replayTimelineDrag(command: RiaDebugCommand, commandId: string) {
  if (!enabled() || !started || !context) throw new Error('拖动复现仅限已连接的本地开发页面。');
  if (dragReplay || document.querySelector('.canvas-skill-button.dragging')
    || (sections.releaseLens as { draft?: boolean } | undefined)?.draft) throw new Error('已有拖动或接续编辑正在进行。');
  const steps = command.steps;
  if (!command.timelineId || !command.buttonId || !Array.isArray(steps) || steps.length < 1 || steps.length > 12
    || !['release', 'cancel'].includes(command.finish ?? '')) throw new Error('拖动命令缺少有效的存档、按钮、步骤或结束方式。');
  if (steps.some(step => !step || !Number.isFinite(step.clientX) || !Number.isFinite(step.clientY)
    || step.clientX < 0 || step.clientX >= innerWidth || step.clientY < 0 || step.clientY >= innerHeight
    || (step.holdMs !== undefined && (!Number.isSafeInteger(step.holdMs) || step.holdMs < 0 || step.holdMs > 1000)))
    || 220 + steps.reduce((sum, step) => sum + (step.holdMs ?? 0), 0) > 5000) throw new Error('拖动步骤必须位于当前可见窗口内，且总等待不超过 5 秒。');
  const sessionId = context.sessionId;
  const paletteSource = document.querySelector<HTMLElement>(`[data-drag-source-id="${CSS.escape(command.buttonId)}"]`);
  const checkScope = () => {
    const current = readMainWorkbenchSnapshot();
    if (context?.sessionId !== sessionId || document.visibilityState !== 'visible' || current?.currentView !== 'canvas'
      || current.activeTimelineId !== command.timelineId
      || !(paletteSource?.isConnected || current.skillButtons.some(button => button.id === command.buttonId))) {
      throw new Error('拖动复现需要可见的原排轴页面和现有按钮或技能列表来源；页面或存档变化后已取消。');
    }
  };
  checkScope();
  const button = paletteSource ?? document.querySelector<HTMLElement>(`[data-skill-button-id="${CSS.escape(command.buttonId)}"]`);
  if (!button || button.getAttribute('aria-disabled') === 'true' || button.dataset.dragDisabled === 'true' || button.classList.contains('is-browse-mode')) {
    throw new Error('该排轴按钮当前不可拖动。');
  }
  const rect = (button.querySelector('.skill-button-orb') ?? button).getBoundingClientRect();
  let point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  const origin = document.elementFromPoint(point.clientX, point.clientY);
  if (rect.width <= 0 || rect.height <= 0 || !origin || !button.contains(origin)) throw new Error('排轴按钮被遮挡或不在可见窗口内。');
  const controller = new AbortController();
  dragReplay = controller;
  const beganAt = performance.now();
  const firstSequence = sequence;
  let pressed = false;
  let stepsExecuted = 0;
  const abort = () => controller.abort();
  const visibilityChanged = () => { if (document.visibilityState !== 'visible') abort(); };
  const timeout = window.setTimeout(abort, 5000);
  window.addEventListener('resize', abort);
  window.addEventListener('blur', abort);
  document.addEventListener('visibilitychange', visibilityChanged);
  const wait = (ms: number) => new Promise<void>((resolve, reject) => {
    if (controller.signal.aborted) { reject(new Error('拖动复现已取消或超过 5 秒。')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error('拖动复现已取消或超过 5 秒。')); };
    const timer = window.setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const mouse = (type: 'mousedown' | 'mousemove' | 'mouseup', target: EventTarget, bubbles = true) => target.dispatchEvent(new MouseEvent(type,
    { bubbles, cancelable: true, view: window, button: 0, buttons: type === 'mouseup' ? 0 : 1, ...point }));
  const cancel = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    // Clear SkillButton's long-press timer without invoking the still-mounted
    // window drop listener before React has applied the Escape cancellation.
    mouse('mouseup', document, false);
    pressed = false;
  };
  const observation = () => ({ buttonId: command.buttonId, timelineId: command.timelineId, finish: command.finish,
    stepsExecuted, durationMs: Math.round(performance.now() - beganAt), releaseLensOpened: lastReleaseLensOpenedSequence > firstSequence,
    clientSequenceFromExclusive: firstSequence, clientSequenceToInclusive: sequence,
    observationSections: ['releaseLens', 'workbench', 'timeline'] });
  recordRiaDebugEvent('interaction', 'DebugTimelineDragStarted', { buttonId: command.buttonId, timelineId: command.timelineId,
    from: point, initialHoldMs: 220, steps, finish: command.finish, synthetic: true }, { commandId });
  try {
    pressed = true;
    mouse('mousedown', origin);
    await wait(220);
    checkScope();
    if (!button.isConnected || (paletteSource
      ? !document.querySelector('.dragging-skill-button-preview, .release-lens')
      : !button.classList.contains('dragging'))) throw new Error('按钮没有进入拖动状态；可能被当前排轴规则锁定。');
    for (const step of steps) {
      checkScope();
      if (controller.signal.aborted) throw new Error('拖动复现已取消或超过 5 秒。');
      point = { clientX: step.clientX, clientY: step.clientY };
      mouse('mousemove', document.elementFromPoint(point.clientX, point.clientY) ?? document);
      stepsExecuted += 1;
      await wait(step.holdMs ?? 0);
      // A short-lived lens may open and close between the normal 1 s flushes.
      // Archive its existing section at each step, without inventing preview facts.
      captureUi();
      recordRiaDebugEvent('interaction', 'DebugTimelineDragStep', { step: stepsExecuted, point,
        dragPreviews: (sections.ui as { dragPreviews?: unknown } | undefined)?.dragPreviews,
        releaseLens: sections.releaseLens ?? null }, { commandId });
    }
    checkScope();
    if (controller.signal.aborted || performance.now() - beganAt >= 5000) throw new Error('拖动复现已取消或超过 5 秒。');
    if (command.finish === 'cancel') cancel();
    else { mouse('mouseup', document.elementFromPoint(point.clientX, point.clientY) ?? document); pressed = false; }
    const value = observation();
    recordRiaDebugEvent('interaction', 'DebugTimelineDragFinished', value, { commandId });
    return value;
  } catch (error) {
    if (pressed) cancel();
    recordRiaDebugEvent('interaction', 'DebugTimelineDragCancelled', { ...observation(), error: String(error) }, { commandId });
    throw error;
  } finally {
    clearTimeout(timeout);
    window.removeEventListener('resize', abort);
    window.removeEventListener('blur', abort);
    document.removeEventListener('visibilitychange', visibilityChanged);
    if (dragReplay === controller) dragReplay = null;
  }
}

async function pollCommands() {
  if (!context || polling) return;
  polling = true;
  try {
    const response = await request(`/api/ria/live/sessions/${context.sessionId}/commands?status=pending`) as { items: CommandEntry[] };
    for (const entry of response.items) {
      let result = completed.get(entry.id);
      if (!result) {
        try {
          recordRiaDebugEvent('command', 'DebugCommandStarted', { id: entry.id, command: entry.command });
          let value: unknown = null;
          if (entry.command.op === 'snapshot') captureUi();
          else if (entry.command.op === 'timeline-drag') value = await replayTimelineDrag(entry.command, entry.id);
          else if (entry.command.op === 'workspace-snapshot') {
            value = await (await import('./akeWorkspace')).inspectAkeWorkspace(entry.command.timelineId);
          } else if (entry.command.op === 'edit-timeline') {
            const current = readMainWorkbenchSnapshot();
            if (!handler || !current || current.activeTimelineId !== entry.command.timelineId) throw new Error('调试编辑的存档与当前排轴不一致。');
            const edit = entry.command.edit;
            if (!edit) throw new Error('缺少排轴编辑内容。');
            if (edit.kind === 'add' && !current.skillCatalog?.some(skill => skill.characterId === edit.characterId && skill.skillId === edit.runtimeSkillId)) {
              throw new Error('该技能不在当前队伍的真实技能目录中。');
            }
            const commandId = `ria-edit-${entry.id}`;
            const command = edit.kind === 'add'
              ? { op: 'addSkillButton' as const, characterId: edit.characterId, runtimeSkillId: edit.runtimeSkillId,
                nodeIndex: edit.nodeIndex, staffIndex: edit.staffIndex, releaseAnchor: edit.releaseAnchor, buttonId: `ria-button-${entry.id}` }
              : { op: 'removeSkillButton' as const, buttonId: edit.buttonId };
            enqueueMainWorkbenchCommand(command, 'ria-live', commandId);
            const deadline = performance.now() + 10_000;
            while (performance.now() < deadline) {
              const queued = readMainWorkbenchCommandQueue().find(command => command.id === commandId);
              if (queued?.status === 'error') throw new Error(queued.error ?? '排轴编辑失败。');
              if (queued?.status === 'done') { value = queued.result; break; }
              await new Promise(resolve => window.setTimeout(resolve, 25));
            }
            if (value === null) {
              patchMainWorkbenchCommand(commandId, { status: 'error', error: '调试编辑等待超时，已取消。' });
              throw new Error('调试编辑等待超时，已取消。');
            }
          } else {
            if (!handler) throw new Error('当前页面没有可用的排轴检查器。');
            value = await handler(entry.command);
          }
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          captureUi();
          result = { status: 'done', result: serialize(value) };
        } catch (error) { result = { status: 'error', error: String(error) }; }
        completed.set(entry.id, result);
        if (completed.size > 500) completed.delete(completed.keys().next().value!);
      }
      await flush();
      await request(`/api/ria/live/sessions/${context.sessionId}/commands/${entry.id}`, result);
    }
  } catch (error) { lastError = String(error); }
  finally { polling = false; }
}

export function registerRiaDebugCommandHandler(value: typeof handler) {
  handler = value;
  return () => { if (handler === value) handler = null; };
}

export async function liveRiaCalculationSink(isCurrent: () => boolean = () => true): Promise<RiaUiActionSink | null> {
  const session = await connect();
  if (!session || !isCurrent()) return null;
  const runId = `run-${crypto.randomUUID()}`;
  const causedByClientSequence = lastInteractionSequence;
  activeRunId = runId;
  const sink = createRiaUiActionSink({ ...session, runId });
  return { context: sink.context, get lastError() { return sink.lastError; }, flush: () => sink.flush(),
    record(action) {
      recordRiaDebugEvent('calculation', action.actionType, { ...action.payload, causedByClientSequence }, { runId });
      return sink.record(action);
    },
  };
}

export function initRiaLiveDebug() {
  if (!enabled() || started) return;
  started = true;
  transportFetch = window.fetch.bind(window);
  const restoreTransport = installMainWorkbenchTransport({
    pushSnapshot(snapshot) {
      const { updatedAt: _updatedAt, damageReport: _legacyReport, ...stable } = snapshot;
      publishRiaDebugSection('workbench', stable);
    },
    pushCommandResult(entry) { recordRiaDebugEvent('command', 'WorkbenchCommandResult', entry); },
  });
  cleanups.push(restoreTransport);
  const listen = (type: string, listener: EventListener) => {
    window.addEventListener(type, listener, true); cleanups.push(() => window.removeEventListener(type, listener, true));
  };
  if (typeof PerformanceObserver !== 'undefined') {
    const resources = new PerformanceObserver(list => {
      for (const entry of list.getEntries().filter(isImageResource)) {
        recordRiaDebugEvent('network', 'ImageResourceLoaded', resourceTiming(entry));
      }
    });
    resources.observe({ type: 'resource', buffered: true });
    cleanups.push(() => resources.disconnect());
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      const tasks = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) recordRiaDebugEvent('state', 'MainThreadLongTask', {
          startTime: Math.round(entry.startTime), durationMs: Math.round(entry.duration), route: location.hash.split('?')[0],
        });
      });
      tasks.observe({ type: 'longtask' });
      cleanups.push(() => tasks.disconnect());
    }
  }
  let pointerStart: { x: number; y: number; at: number; target: ReturnType<typeof targetInfo> } | null = null;
  listen('pointerdown', event => { const e = event as PointerEvent; pointerStart = { x: e.clientX, y: e.clientY, at: performance.now(), target: targetInfo(e.target) }; });
  listen('pointerup', event => {
    const e = event as PointerEvent;
    if (pointerStart && (Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 3 || performance.now() - pointerStart.at > 180)) {
      recordRiaDebugEvent('interaction', 'PointerGesture', { from: pointerStart, to: { x: e.clientX, y: e.clientY, target: targetInfo(e.target) }, durationMs: performance.now() - pointerStart.at }, { commandId: pointerStart.target?.commandId });
    }
    pointerStart = null;
  });
  for (const type of ['click', 'dblclick', 'contextmenu', 'change', 'focusin']) listen(type, event => {
    const target = targetInfo(event.target);
    recordRiaDebugEvent('interaction', type, { target }, { commandId: target?.commandId });
    if (type === 'click') {
      const start = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => recordRiaDebugEvent('state', 'InteractionPainted', {
        target, durationMs: Math.round(performance.now() - start),
      })));
    }
  });
  listen('keydown', event => {
    const e = event as KeyboardEvent;
    if (['Escape', 'Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
      || e.metaKey || e.ctrlKey) recordRiaDebugEvent('interaction', 'shortcut', { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, target: targetInfo(e.target) });
  });
  listen('hashchange', () => { recordRiaDebugEvent('interaction', 'RouteChanged', { route: location.hash.split('?')[0] }); captureUi(); });
  listen('error', event => { const e = event as ErrorEvent; recordRiaDebugEvent('error', 'BrowserError', { message: e.message, error: e.error, filename: e.filename, line: e.lineno, target: targetInfo(e.target) }); });
  listen('unhandledrejection', event => recordRiaDebugEvent('error', 'UnhandledRejection', { reason: (event as PromiseRejectionEvent).reason }));
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level];
    const wrapped = (...args: unknown[]) => { original.apply(console, args); recordRiaDebugEvent('console', level, { args }); };
    console[level] = wrapped;
    cleanups.push(() => { if (console[level] === wrapped) console[level] = original; });
  }
  const wrappedFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.pathname.includes('/ria/')) return transportFetch(input, init);
    const requestId = crypto.randomUUID(); const start = performance.now();
    const runId = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('X-RIA-Run-ID') ?? activeRunId;
    let body: unknown = null;
    if (url.pathname.startsWith('/api/ake/') && typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = { bytes: init.body.length, format: 'unparsed' }; }
    }
    recordRiaDebugEvent('network', 'RequestStarted', { requestId, url: url.pathname, method: init?.method ?? (input instanceof Request ? input.method : 'GET'), body }, { runId });
    try {
      const response = await transportFetch(input, init);
      recordRiaDebugEvent('network', 'ResponseReceived', { requestId, url: url.pathname, status: response.status, durationMs: performance.now() - start,
        resultUrl: runId && context ? `/api/ria/runs/${runId}/result?caseId=${context.caseId}` : null }, { runId });
      if (!response.ok) void response.clone().json().then(error => recordRiaDebugEvent('network', 'ErrorResponse', { requestId, error }, { runId })).catch(() => {});
      return response;
    } catch (error) { recordRiaDebugEvent('network', 'RequestFailed', { requestId, url: url.pathname, error, durationMs: performance.now() - start }, { runId }); throw error; }
  };
  window.fetch = wrappedFetch;
  cleanups.push(() => { if (window.fetch === wrappedFetch) window.fetch = transportFetch; });
  const flushTimer = window.setInterval(() => { void flush(); }, 1000);
  const pollTimer = window.setInterval(() => { void pollCommands(); }, 1000);
  const uiTimer = window.setInterval(captureUi, 1500);
  cleanups.push(() => { clearInterval(flushTimer); clearInterval(pollTimer); clearInterval(uiTimer); });
  Object.assign(window, { __AKE_DEBUG__: {
    status: () => ({ context, activeRunId, bufferedEvents: events.length, dropped, lastError }),
    snapshot: () => serialize(sections), flush, capabilitiesUrl: '/api/ria/live/capabilities',
  } });
  captureUi(); void connect();
}

if (import.meta.hot) import.meta.hot.dispose(() => { dragReplay?.abort(); cleanups.splice(0).reverse().forEach(cleanup => cleanup()); started = false; });
