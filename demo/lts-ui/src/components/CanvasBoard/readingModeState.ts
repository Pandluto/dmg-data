import type { AkeCombatStateEvent } from '../../core/services/akeRuntimeLedger';

/**
 * 阅读卡只显示一个来源动作对同一状态的最终结果。
 *
 * 这只是展示层摘要：调用方传入的事件数组从不被修改，完整事务仍由战斗
 * 状态面板消费。sourceId 被纳入键中，避免把同一状态从不同来源合并到一
 * 张卡片的角标里；commandId 则由调用方先做来源动作筛选。
 */
export function summarizeReadingStateEvents(
  events: readonly AkeCombatStateEvent[],
  sourceCommandId: string,
): AkeCombatStateEvent[] {
  const latestBySource = new Map<string, AkeCombatStateEvent>();

  events
    .filter((event) => event.commandId === sourceCommandId)
    .sort((left, right) => (
      left.frame - right.frame
      || left.sequence - right.sequence
      || left.key.localeCompare(right.key)
    ))
    .forEach((event) => {
      const key = JSON.stringify([event.scope, event.buffId, event.sourceId]);
      latestBySource.set(key, event);
    });

  return [...latestBySource.values()].sort((left, right) => (
    left.frame - right.frame
    || left.sequence - right.sequence
    || left.key.localeCompare(right.key)
  ));
}

export function formatReadingStateStack(event: Pick<AkeCombatStateEvent, 'after'>): string {
  if (event.after === 0) return '×';
  return event.after == null ? '?' : String(event.after);
}
