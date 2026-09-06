import { useEffect, useMemo, useState } from 'react';
import type { Character } from '../../types';
import type { AkeTeamReport } from '../../integrations/ake/akeProvider';
import type { AkeRealtimeTimeline } from '../../integrations/ake/akeRealtimeTimeline';
import { getInstalledAkeCatalog } from '../../integrations/ake/akeCatalogAdapter';
import {
  buildAkeCombatStateEvents, buildAkeCombatStatesAt, buildAkeRuntimeCommandViewState,
  buildAkeRuntimeStatusLabelMap, buildAkeMainTimelineStateEvents, buildAkeCombatInteractions,
} from '../../core/services/akeRuntimeLedger';
import { akeSkillTypeLabel, buildAkeCombatIssues, describeAkeReleaseReason } from '../../core/services/akeCombatInspection';
import './TimelineCombatPanel.css';
import { publishRiaDebugSection } from '../../integrations/ake/riaLiveDebug';

interface TimelineCombatPanelProps {
  report: AkeTeamReport | null;
  preview: AkeRealtimeTimeline | null;
  characters: Character[];
  selectedCommandId: string | null;
  onSelectCommand: (id: string) => void;
  onOpenDetails: (id: string) => void;
  isUpdating: boolean;
  error: string;
  onRetry: () => void;
}

export function TimelineCombatPanel({ report, preview, characters, selectedCommandId, onSelectCommand,
  onOpenDetails, isUpdating, error, onRetry }: TimelineCombatPanelProps) {
  const [view, setView] = useState<'action' | 'states'>('action');
  const [cursor, setCursor] = useState<{ report: AkeTeamReport; key: string } | null>(null);
  const labels = useMemo(() => buildAkeRuntimeStatusLabelMap(getInstalledAkeCatalog()), [report, preview]);
  const issues = useMemo(() => buildAkeCombatIssues(preview, report), [preview, report]);
  const events = useMemo(() => report ? buildAkeCombatStateEvents(report, labels) : [], [report, labels]);
  const mainTimelineStateEvents = useMemo(() => report ? buildAkeMainTimelineStateEvents(report, labels) : [], [report, labels]);
  const interactions = useMemo(() => report ? buildAkeCombatInteractions(report) : [], [report]);
  const settlement = useMemo(() => {
    if (!report) return null;
    // Read the recorded pool at the end of real actions and hits, before the
    // provider's idle padding. Recovery during padding is not burst resources.
    const actionEnd = report.timeline.commands.reduce((end, command) => command.success
      ? Math.max(end, command.endFrame ?? command.actualFrame ?? 0) : end, 0);
    const frame = report.hits.reduce((end, hit) => Math.max(end, hit.frame), actionEnd);
    const pool = report.timeline.sharedAtb;
    const points = pool?.points.filter(point => point.frame <= frame) ?? [];
    const point = points[points.length - 1];
    return { frame, totalDamage: report.summary.totalDamage,
      remainingAtb: point?.value ?? pool?.initial ?? null,
      hitCount: report.hits.filter(hit => hit.damageAttributeType === 'Hp').length };
  }, [report]);
  const commands = preview?.commands ?? report?.timeline.commands ?? [];
  const selected = commands.find(command => command.commandId === selectedCommandId)
    ?? commands[0] ?? null;
  const selectedId = selected?.commandId ?? null;
  useEffect(() => { setCursor(null); setView('action'); }, [selectedId]);
  const commandView = useMemo(() => buildAkeRuntimeCommandViewState({
    runtimeMode: true, report, commandId: selectedId ?? '', labels,
  }), [report, selectedId, labels]);
  const ledger = commandView.ledger;
  const settledCommand = report?.timeline.commands.find(command => command.commandId === selectedId);
  const previewCommand = preview?.commands.find(command => command.commandId === selectedId);
  const tickRate = report?.tickRate ?? preview?.tickRate ?? 30;
  const frameLabel = (frame: number) => `F${frame} · ${(frame / tickRate).toFixed(2)}秒`;
  const names = new Map(characters.map(character => [character.id, character.name]));
  for (const character of report?.characters ?? []) {
    names.set(character.localCharacterId, character.characterName);
    names.set(character.memberId, character.characterName);
    if (character.akeCharacterId) names.set(character.akeCharacterId, character.characterName);
  }
  const actorName = (id: string | null) => id ? names.get(id) ?? '其他来源' : '状态到期或移除';
  const readableMessage = (message: string) => {
    let result = message;
    for (const [id, name] of names) if (id) result = result.split(id).join(name);
    return result;
  };
  const commandLabel = (id: string) => {
    const command = commands.find(item => item.commandId === id)
      ?? report?.timeline.commands.find(item => item.commandId === id);
    return command ? `${actorName(command.characterId)} · ${akeSkillTypeLabel(command.commandType, command.attackMode)}` : '对应时间操作';
  };
  const selectedEvent = cursor?.report === report ? events.find(event => event.key === cursor.key) : null;
  const sameFrameEvents = selectedEvent ? events.filter(event => event.frame === selectedEvent.frame) : [];
  const defaultFrame = selected
    ? Math.max(settledCommand?.endFrame ?? selected.actualFrame ?? selected.requestedFrame,
      ...(ledger?.hits.map(hit => hit.hit.frame) ?? [])) : 0;
  const inspectFrame = selectedEvent?.frame ?? defaultFrame;
  const states = useMemo(() => report ? buildAkeCombatStatesAt(report, inspectFrame, labels, selectedEvent?.sequence) : [],
    [report, inspectFrame, labels, selectedEvent?.sequence]);
  const actionEvents = events.filter(event => event.commandId === selectedId || event.triggerCommandId === selectedId);
  const effectiveTypes = settledCommand?.effectiveSkillTypes?.length ? settledCommand.effectiveSkillTypes
    : [...new Set(ledger?.hits.map(hit => hit.hit.effectiveSkillType).filter((type): type is string => Boolean(type)) ?? [])];
  const comboSettlement = report?.teamComboLedger?.settlements.find(item => item.commandId === selectedId
    || Boolean(settledCommand?.castId && item.rootCastId === settledCommand.castId));
  const blocked = Boolean(preview?.sharedVariableRateTimeline
    && preview.sharedVariableRateTimeline.admissionStatus !== 'valid');
  const statusText = error ? '本次结算失败' : isUpdating ? '正在更新当前排轴'
    : report ? blocked || report.summary.failedCommands > 0 ? '部分动作已结算' : '当前排轴已结算' : '等待当前排轴结算';
  const selectCommand = (id: string) => { setCursor(null); setView('action'); onSelectCommand(id); };

  useEffect(() => {
    publishRiaDebugSection('inspection', { selectedCommandId: selectedId, view, inspectFrame,
      selectedEvent: selectedEvent ?? null, states, issues, mainTimelineStateEvents, interactions,
      ledger: ledger ? { command: ledger.command, summary: ledger.summary,
        hits: ledger.hits.map(hit => ({ key: hit.key, title: hit.title, meta: hit.meta, expected: hit.expected,
          crit: hit.crit, nonCrit: hit.nonCrit, hitId: hit.hit.hitId, frame: hit.hit.frame,
          rootCastId: hit.hit.rootCastId, castId: hit.hit.castId, effectiveSkillType: hit.hit.effectiveSkillType,
          triggerRootCastId: hit.hit.triggerRootCastId, triggerCastId: hit.hit.triggerCastId,
          triggerSourceId: hit.hit.triggerSourceId, triggerSkillId: hit.hit.triggerSkillId, triggerFrame: hit.hit.triggerFrame,
          criticalStates: hit.statuses.filter(status => status.groupOrder === 0) })) } : null,
      commandViewKind: commandView.kind,
      settlement,
      executionDigest: report?.executionDigest ?? null, isUpdating, error });
  }, [selectedId, view, inspectFrame, selectedEvent, states, issues, mainTimelineStateEvents, interactions, ledger, commandView.kind, settlement, report, isUpdating, error]);

  return <section className="timeline-combat-panel" aria-label="战斗状态与排轴原因">
    <header className="combat-panel-header">
      <strong>战斗状态</strong>
      <span role="status" className={error ? 'combat-warning' : ''}>{statusText}</span>
    </header>
    {settlement && !isUpdating && !error && <div className="combat-run-summary" aria-label="当前排轴结算汇总">
      <span>期望总伤害</span>
      <strong>{settlement.totalDamage.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</strong>
      <span>{report!.summary.successfulCommands} 个动作已执行 · {settlement.hitCount} 次伤害命中</span>
      <dl>
        <dt>动作与尾伤结束</dt><dd>{frameLabel(settlement.frame)}</dd>
        <dt>此时剩余技力</dt><dd>{settlement.remainingAtb === null ? '未记录' : settlement.remainingAtb.toFixed(2)}</dd>
      </dl>
    </div>}
    {error && <div className="combat-error" role="alert"><p>{error}</p><button type="button" onClick={onRetry}>重新结算</button></div>}
    {issues.length > 0 && <details className="combat-issues" open>
      <summary>排轴需调整 · {issues.length} 项</summary>
      {issues.map(issue => <div className="combat-issue" key={issue.key}>
        <span className="combat-eyebrow">{issue.source === 'plan' ? '释放规划' : '实际结算'}{issue.frame !== null ? ` · ${frameLabel(issue.frame)}` : ''}</span>
        <p>{readableMessage(issue.message)}</p>
        <div className="combat-actions">{issue.commandIds.map(id => <button type="button" key={id} onClick={() => selectCommand(id)}>{commandLabel(id)}</button>)}</div>
        <details className="combat-technical"><summary>技术原因</summary><code>{issue.rawReason}</code></details>
      </div>)}
      {report && <p className="combat-muted">下方仅展示已执行动作的结果，不代表整条排轴可执行。</p>}
    </details>}
    {commands.length === 0 ? <p className="combat-empty">从排轴工具添加技能后，这里会显示释放条件与结算状态。</p> : <>
      <label className="combat-command-picker">查看动作
        <select value={selectedId ?? ''} onChange={event => selectCommand(event.target.value)}>
          {commands.map(command => <option key={command.commandId} value={command.commandId}>
            {frameLabel(command.actualFrame ?? command.requestedFrame)} · {commandLabel(command.commandId)}
          </option>)}
        </select>
      </label>
      <div className="combat-view-tabs" role="tablist" aria-label="战斗查看内容">
        <button type="button" role="tab" id="combat-action-tab" aria-controls="combat-action-view" aria-selected={view === 'action'} onClick={() => setView('action')}>本次动作</button>
        <button type="button" role="tab" id="combat-state-tab" aria-controls="combat-state-view" aria-selected={view === 'states'} onClick={() => setView('states')}>状态历程{events.length ? ` · ${events.length}` : ''}</button>
      </div>
      <div id="combat-action-view" role="tabpanel" aria-labelledby="combat-action-tab" hidden={view !== 'action'}>
        {selected && <>
          <dl className="combat-facts">
            <dt>按钮输入</dt><dd>{akeSkillTypeLabel(selected.commandType, selected.attackMode)}</dd>
            <dt>实际结算</dt><dd>{settledCommand?.success ? effectiveTypes.map(type => akeSkillTypeLabel(type, settledCommand.attackMode)).join(' / ') || akeSkillTypeLabel(settledCommand.commandType, settledCommand.attackMode) : settledCommand ? '未执行' : '等待结算'}</dd>
            <dt>请求释放</dt><dd>{frameLabel(selected.requestedFrame)}</dd>
            <dt>{settledCommand ? '实际释放' : '预演释放'}</dt><dd>{(settledCommand ?? selected).actualFrame !== null ? frameLabel((settledCommand ?? selected).actualFrame!) : '未释放'}</dd>
            {settledCommand?.completion && <><dt>动作结果</dt><dd>{({ completed: '完整结束', interrupted: '被打断', open: '尚未结束' } as Record<string, string>)[settledCommand.completion.toLowerCase()] ?? '结束状态未确认'}</dd></>}
            {settledCommand?.endFrame !== null && settledCommand?.endFrame !== undefined && <><dt>动作结束</dt><dd>{frameLabel(settledCommand.endFrame)}</dd></>}
            {settledCommand && settledCommand.delayFrames !== null && settledCommand.delayFrames > 0 && <><dt>排队等待</dt><dd>{settledCommand.delayFrames} 帧</dd></>}
          </dl>
          {selected?.attackMode === 'plunging-impact' && <p className="combat-explanation">排轴指定的是落地动作开始时刻，冲击命中遵循原始动作偏移；起跳与空中移动未建模。是否触发领域或其他效果，由命中时的主控、范围与监听条件决定。</p>}
          {settledCommand?.completion?.toLowerCase() === 'interrupted' && <p className="combat-explanation">动作已被打断。下方记录的是实际发生的命中与状态变化；释放成功不代表后续效果全部执行。</p>}
          {previewCommand && ['invalid', 'unverified', 'queued'].includes(previewCommand.releaseVerdict) && <p className="combat-explanation">{describeAkeReleaseReason(previewCommand.releaseReason)}{previewCommand.cooldownEndFrame !== null && /COOLDOWN/.test(previewCommand.releaseReason) ? ` 冷却结束：${frameLabel(previewCommand.cooldownEndFrame)}。` : ''}</p>}
          {comboSettlement?.eligible && <p className="combat-explanation">{comboSettlement.consumedStacks > 0 ? `本次消费 ${comboSettlement.consumedStacks} 层共享连击；后续命中使用本次消费快照。`
              : '本次具备共享连击消费资格，释放时没有可消费层数。'}</p>}
          {commandView.kind === 'partial' && <p className="combat-warning">{commandView.message}</p>}
          {commandView.kind === 'rejected' && <p className="combat-warning">{describeAkeReleaseReason(commandView.command.reason)}</p>}
          {interactions.filter(item => item.triggerCommandId === selectedId || item.effectCommandId === selectedId).map(item => <div className="combat-explanation" key={item.key}>
            <strong>交互触发 · {frameLabel(item.frame)}</strong>
            <p>{commandLabel(item.triggerCommandId)} → {commandLabel(item.effectCommandId)}</p>
            <p>触发后的 {item.hitCount} 次伤害命中归属 {actorName(item.effectActorId)}，发生在 F{item.firstHitFrame}—F{item.lastHitFrame}。</p>
            <div className="combat-actions">
              <button type="button" onClick={() => selectCommand(item.triggerCommandId)}>查看触发动作</button>
              <button type="button" onClick={() => selectCommand(item.effectCommandId)}>查看派生伤害</button>
            </div>
          </div>)}
          <h4>本次引起的状态变化</h4>
          {actionEvents.length ? <ol className="combat-event-list">{actionEvents.map(event => <li key={event.key}>
            <button type="button" onClick={() => { if (report) setCursor({report, key:event.key}); setView('states'); }}>
              <span className="combat-eyebrow">{frameLabel(event.frame)}</span><strong>{event.label} · {event.change}</strong>
              <span>{event.before ?? '—'} → {event.after ?? '—'} 层 · {event.scope === 'team' ? '队伍共享' : '敌方'}</span>
            </button>
          </li>)}</ol> : <p className="combat-muted">{report ? '本次没有记录到共享或敌方关键状态变化。持续状态可在“状态历程”查看。' : '当前结果更新后显示。'}</p>}
          <h4>逐次命中</h4>
          {ledger?.hits.length ? <div className="combat-hit-list">{ledger.hits.map(hit => <div key={hit.key}>
            <span>{frameLabel(hit.hit.frame)} · {hit.title}</span><strong>{hit.expected} <small>期望</small></strong>
          </div>)}</div> : <p className="combat-muted">{report ? '当前动作没有可展示的伤害命中。' : '等待当前计算结果。'}</p>}
          <button type="button" className="combat-detail-button" onClick={() => onOpenDetails(selected.commandId)}>打开完整命中与乘区详情</button>
        </>}
      </div>
      <div id="combat-state-view" role="tabpanel" aria-labelledby="combat-state-tab" hidden={view !== 'states'}>
        <div className="combat-state-heading"><strong>{frameLabel(inspectFrame)}</strong><span>{selectedEvent
          ? `所选事件之后 · 同帧第 ${sameFrameEvents.indexOf(selectedEvent) + 1} / ${sameFrameEvents.length} 项`
          : '所选动作结束时'}</span></div>
        <div className="combat-state-chips">{states.map(item => <div key={item.key}>
          <span>{item.scope === 'team' ? '队伍' : '敌方'} · {item.label}</span><strong>{item.stacks} 层</strong>
          {item.sourceId && <small>来源：{actorName(item.sourceId)}</small>}
        </div>)}</div>
        {states.length === 0 && <p className="combat-muted">{report ? '该时刻没有记录到活动的共享或敌方关键状态。' : '等待当前计算结果。'}</p>}
        {selectedEvent && <div className="combat-explanation">
          <strong>{selectedEvent.label} · {selectedEvent.change} {selectedEvent.before ?? '—'} → {selectedEvent.after ?? '—'}</strong>
          <p>执行来源：{actorName(selectedEvent.actorId)}</p>
          {selectedEvent.triggerCommandId && selectedEvent.triggerCommandId !== selectedEvent.commandId && <p>关联触发：{commandLabel(selectedEvent.triggerCommandId)}</p>}
          {selectedEvent.sourceId && <p>原始来源：{actorName(selectedEvent.sourceId)}</p>}
          {selectedEvent.consumedSources?.map((source, index) => <p key={index}>消费来源：{source.sourceId ? actorName(source.sourceId) : '来源未记录'} · {source.count} 层</p>)}
          {selectedEvent.commandId && <button type="button" onClick={() => { selectCommand(selectedEvent.commandId!); setView('action'); }}>查看触发动作</button>}
          {selectedEvent.sourceCommandIds?.map(id => <button type="button" key={id} onClick={() => { selectCommand(id); setView('action'); }}>来源：{commandLabel(id)}</button>)}
          {selectedEvent.sourceCommandId && selectedEvent.sourceCommandId !== selectedEvent.commandId && <button type="button" onClick={() => selectCommand(selectedEvent.sourceCommandId!)}>查看来源动作</button>}
        </div>}
        <h4>状态变化时间线</h4>
        <ol className="combat-event-list">{events.map(event => <li key={event.key}>
          <button type="button" aria-pressed={event.key === selectedEvent?.key} onClick={() => { if (report) setCursor({report, key:event.key}); }}>
            <span className="combat-eyebrow">{frameLabel(event.frame)} · {actorName(event.actorId)}</span>
            <strong>{event.label} · {event.change}</strong><span>{event.before ?? '—'} → {event.after ?? '—'} 层</span>
          </button>
        </li>)}</ol>
      </div>
    </>}
  </section>;
}
