import type { AkeCharacterReport, AkeTeamReport } from './akeProvider';
import './AkeReportDrawer.css';

function integer(value: number): string {
  return Math.round(Number(value) || 0).toLocaleString('zh-CN');
}

function decimal(value: number): string {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function statusLabel(status: AkeCharacterReport['status']): string {
  if (status === 'calculated') return '已结算';
  if (status === 'no-commands') return '没有排轴输入';
  if (status === 'unsupported') return 'AKE 尚未收录';
  return '结算失败';
}

function commandStatus(command: NonNullable<AkeCharacterReport['simulation']>['commands'][number]): string {
  if (command.status === 'queued-then-executed') return '排队后执行';
  if (command.status === 'executed') return '执行';
  if (command.status === 'expired') return '排队过期';
  return '失败';
}

function CharacterResult({ report }: { report: AkeCharacterReport }) {
  const simulation = report.simulation;
  const damageBonuses = report.loadout.damageBonuses ?? [];
  return (
    <details className="ake-report-character" open={report.status === 'calculated'}>
      <summary>
        <span>
          <strong>{report.characterName}</strong>
          <small>{report.loadout.weaponName || '未选择武器'} · {report.loadout.equipment.length}/4 件装备</small>
        </span>
        <span className={`ake-report-status is-${report.status}`}>{statusLabel(report.status)}</span>
        <b>{simulation ? integer(simulation.summary.totalDamage) : '—'}</b>
      </summary>
      <div className="ake-report-loadout">
        <span>Lv.{report.loadout.level}</span>
        <span>技能 {report.loadout.skillLevel}</span>
        <span>面板 ATK {decimal(report.loadout.panelAtk)}</span>
        <span>{report.loadout.weaponId || '武器 ID 未映射'}</span>
      </div>
      <div className="ake-report-equipment">
        {report.loadout.equipment.length > 0
          ? report.loadout.equipment.map((piece) => (
            <span key={piece.slotKey}>{piece.slotKey} · {piece.name}</span>
          ))
          : <span>未选择装备</span>}
      </div>
      {damageBonuses.length > 0 ? (
        <div className="ake-report-equipment ake-report-configured-bonuses">
          {damageBonuses.map((bonus) => (
            <span key={bonus.label}>{bonus.label} +{decimal(bonus.value * 100)}%</span>
          ))}
        </div>
      ) : null}
      {report.error ? <p className="ake-report-error">{report.error}</p> : null}
      {simulation ? (
        <>
          <div className="ake-report-metrics">
            <span><small>DPS</small><strong>{decimal(simulation.summary.dps)}</strong></span>
            <span><small>成功输入</small><strong>{simulation.summary.successfulCommands}</strong></span>
            <span><small>失败输入</small><strong>{simulation.summary.failedCommands}</strong></span>
            <span><small>命中</small><strong>{simulation.summary.hitCount}</strong></span>
          </div>
          <div className="ake-report-command-list">
            {simulation.commands.map((command) => (
              <div key={command.commandId} className={`ake-report-command is-${command.status}`}>
                <span>{command.commandType}</span>
                <code>F{command.requestedFrame} → {command.actualFrame === null ? '—' : `F${command.actualFrame}`}</code>
                <span>{commandStatus(command)}{command.delayFrames ? ` +${command.delayFrames}F` : ''}</span>
                <b>{integer(command.damage)}</b>
                {command.reason || command.admissionReason ? (
                  <small>{command.reason || command.admissionReason}</small>
                ) : null}
              </div>
            ))}
          </div>
          <p className="ake-report-diagnostics">
            AKE 编译未解析 {simulation.diagnostics.compilerUnresolvedEffectCount} 项 ·
            运行时未解析 {simulation.diagnostics.unresolvedEffectCount} 项 ·
            末态技力 {decimal(simulation.finalState.resources.Atb)} ·
            终结技能量 {decimal(simulation.finalState.resources.UltimateSp)}
          </p>
        </>
      ) : null}
      {report.skippedButtonIds.length > 0 ? (
        <p className="ake-report-diagnostics">跳过 {report.skippedButtonIds.length} 个 AKE 尚未映射的按钮。</p>
      ) : null}
    </details>
  );
}

export function AkeReportDrawer({ report, onClose }: { report: AkeTeamReport; onClose: () => void }) {
  return (
    <aside className="ake-report-drawer" aria-label="AKE 实际时序结算">
      <header>
        <div>
          <strong>AKE 实际时序结算</strong>
          <span>{report.enemyId} · {report.timelineMode === 'shared-variable-rate'
            ? '共享变速时间轴 · 强事件边界'
            : `1 个节点 = ${report.nodeFrameScale} 帧`}</span>
        </div>
        <button type="button" onClick={onClose}>关闭</button>
      </header>
      <section className="ake-report-team-summary">
        <span><small>总伤害</small><strong>{integer(report.summary.totalDamage)}</strong></span>
        <span><small>韧性伤害</small><strong>{integer(report.summary.totalPoiseDamage)}</strong></span>
        <span><small>延迟输入</small><strong>{report.summary.delayedCommands}</strong></span>
        <span><small>支持干员</small><strong>{report.summary.calculatedCharacters}/{report.characters.length}</strong></span>
      </section>
      <div className="ake-report-character-list">
        {report.characters.map((character) => (
          <CharacterResult key={character.localCharacterId} report={character} />
        ))}
      </div>
      <footer>
        本抽屉与主排轴使用同一次 AKE 小队结算；Calc 只作为开发期冻结边界的最终对照，不提供角色、武器或装备数据。
      </footer>
    </aside>
  );
}
