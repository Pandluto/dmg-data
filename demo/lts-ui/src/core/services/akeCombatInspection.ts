import type { AkeRealtimeTimeline } from '../../integrations/ake/akeRealtimeTimeline';
import type { AkeTeamReport } from '../../integrations/ake/akeProvider';

const REASONS: Record<string, string> = {
  INSUFFICIENT_ATB: '共享技力不足；调整同帧技能，或在前方加入等待。',
  INSUFFICIENT_RESOURCE: '释放所需资源不足；检查共享技力和干员能量。',
  INSUFFICIENT_ULTIMATE_SP: '终结技能量不足；需要先获得足够能量。',
  COMBO_TRIGGER_MISSING: '连携条件尚未触发；先安排能开启连携窗口的动作。',
  COMBO_NOT_READY: '连携尚未就绪；检查触发条件和冷却。',
  COMBO_COOLDOWN_ACTIVE: '连携仍在冷却；移动到冷却结束之后。',
  COOLDOWN_ACTIVE: '技能仍在冷却；移动到冷却结束之后。',
  QUEUE_WINDOW_EXPIRED: '输入超出排队窗口；将它接到可释放的动作边界。',
  TIMELINE_END: '排轴结束前未能释放；延长等待或调整前置动作。',
  COMBO_RULE_UNVERIFIED: '此连携触发规则尚未确认，当前只能预演。',
  COMBO_TRIGGER_UNVERIFIED: '此连携的触发条件尚未验证；已有结算不代表触发门槛已确认。',
  CENTER_STATE_BLOCKED: '前一动作仍在释放；本次输入已排队，按实际释放帧执行。',
  RELEASE_ANCHOR_PENDING: '跟随来源技能的实际命中释放，排队和终结技暂停会同步移动释放时间。',
  RELEASE_ANCHOR_BLOCKED: '指定接点到达时动作仍受占用；请增加延迟或选择其他接点。',
  RELEASE_WINDOW_EXPIRED: '指定输入已越过窗口右端；请重新选择窗口内的接续时刻。',
  RELEASE_WINDOW_NOT_ACTIVE: '保存的窗口与本次实际窗口不匹配；请重新核对来源和接续点。',
  RELEASE_ANCHOR_NOT_REACHED: '来源技能在本次计算内没有到达指定命中，后续技能未释放。',
  TIMELINE_MODULE_RUNTIME_REQUIRED: '这个时间操作尚未接入完整结算，当前只能预演。',
  BASIC_ATTACK_NOT_CONTROLLED: '普攻干员不是当前主控；先切换到该干员。',
  ATTACK_NOT_CONTROLLED: '普攻干员不是当前主控；先切换到该干员。',
  PLUNGING_IMPACT_BLOCKED: '指定落地时刻仍被前一动作占用；请调整落地动作的位置。下落不会排队到未来自动执行。',
  PLUNGING_ATTACK_UNAVAILABLE: '该干员尚无已解析的下落落地程序，不能代替为普通攻击。',
  PLUNGING_IMPACT_REQUIRES_MAIN_CHARACTER: '下落攻击需要由该时刻的主控干员执行；请先安排切换主控。',
};

export function describeAkeReleaseReason(reason: string | null | undefined): string {
  if (!reason) return '释放条件未满足，请检查前置动作、资源和连携窗口。';
  if (REASONS[reason]) return REASONS[reason];
  if (reason.startsWith('RELEASE_ANCHOR_')) return '释放位置与前置动作不匹配；重新选择该动作的吸附位置。';
  if (reason.startsWith('QUEUED_')) return '输入已排队，等待前置动作允许释放。';
  if (/[\u4e00-\u9fff]/.test(reason)) return reason;
  return '当前释放条件未满足；展开技术原因查看运行时返回值。';
}

export type AkeCombatIssue = {
  key: string;
  commandIds: string[];
  frame: number | null;
  message: string;
  rawReason: string;
  source: 'plan' | 'runtime';
};

/** Preserve the distinction between plan admission and successful actions in a partial run. */
export function buildAkeCombatIssues(preview: AkeRealtimeTimeline | null, report: AkeTeamReport | null): AkeCombatIssue[] {
  const issues: AkeCombatIssue[] = [];
  const covered = new Set<string>();
  for (const [index, issue] of (preview?.planningIssues ?? []).entries()) {
    issue.commandIds.forEach(id => covered.add(id));
    issues.push({key: `planning:${index}`, commandIds: issue.commandIds, frame: issue.frame,
      message: issue.message, rawReason: issue.code, source: 'plan'});
  }
  for (const cohort of preview?.sharedVariableRateTimeline?.cohorts ?? []) {
    if (cohort.status === 'valid') continue;
    if (cohort.reason.startsWith('RELEASE_ANCHOR_') && cohort.actionIds.some(id => covered.has(id))) continue;
    cohort.actionIds.forEach(id => covered.add(id));
    const resourceDetail = cohort.availableSharedAtb !== null
      && cohort.requiredSharedAtb > cohort.availableSharedAtb
      ? `同帧共需 ${cohort.requiredSharedAtb.toFixed(0)} 技力，当前 ${cohort.availableSharedAtb.toFixed(0)}。` : '';
    issues.push({ key: `cohort:${cohort.id}`, commandIds: cohort.actionIds, frame: cohort.frame,
      message: resourceDetail + describeAkeReleaseReason(cohort.reason), rawReason: cohort.reason, source: 'plan' });
  }
  for (const command of preview?.commands ?? []) {
    if (covered.has(command.commandId) || !['invalid', 'unverified'].includes(command.releaseVerdict)) continue;
    covered.add(command.commandId);
    issues.push({ key: `plan:${command.commandId}`, commandIds: [command.commandId], frame: command.requestedFrame,
      message: describeAkeReleaseReason(command.releaseReason), rawReason: command.releaseReason, source: 'plan' });
  }
  // Control/anchor validation can reject the plan after cohort admission, so keep its diagnostics visible.
  if (preview?.sharedVariableRateTimeline?.admissionStatus !== 'valid') {
    for (const [index, diagnostic] of (preview?.diagnostics ?? []).entries()) {
      if (/RELEASE_ANCHOR_REPAIRED/.test(diagnostic)) continue;
      if (preview?.planningIssues?.some(issue => diagnostic.startsWith(`${issue.code}:`))) continue;
      if (!/CONTROL|DODGE|SWITCH|ANCHOR|TIMELINE_MODULE_RUNTIME_REQUIRED|普攻|主控/.test(diagnostic)) continue;
      const commandIds = (preview?.commands ?? []).filter(command => diagnostic.includes(command.commandId)).map(command => command.commandId);
      issues.push({ key: `diagnostic:${index}`, commandIds, frame: null,
        message: diagnostic.startsWith('TIMELINE_MODULE_RUNTIME_REQUIRED')
          ? REASONS.TIMELINE_MODULE_RUNTIME_REQUIRED : diagnostic.replace(/^[A-Z_]+:\s*/, ''),
        rawReason: diagnostic, source: 'plan' });
    }
  }
  for (const command of report?.timeline.commands ?? []) {
    if (command.success || covered.has(command.commandId)) continue;
    issues.push({ key: `runtime:${command.commandId}`, commandIds: [command.commandId], frame: command.actualFrame ?? command.requestedFrame,
      message: describeAkeReleaseReason(command.reason), rawReason: command.reason ?? command.state, source: 'runtime' });
  }
  if (issues.length === 0 && preview?.sharedVariableRateTimeline
    && preview.sharedVariableRateTimeline.admissionStatus !== 'valid') {
    issues.push({ key: 'plan:unresolved', commandIds: [], frame: null,
      message: '当前排轴仍有未满足或未确认的释放条件。',
      rawReason: preview.diagnostics.join('\n') || preview.sharedVariableRateTimeline.admissionStatus, source: 'plan' });
  }
  return issues;
}

export function akeSkillTypeLabel(type: string, attackMode?: string | null): string {
  if (attackMode === 'plunging-impact') return '下落攻击·落地';
  return ({ Attack: '普攻', NormalAttack: '普攻', NormalSkill: '战技', ComboSkill: '连携技', UltimateSkill: '终结技', BreakingAttack: '处决' } as Record<string, string>)[type] ?? type;
}
