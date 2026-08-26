import type { TimelineDetailStatus } from './TimelineSkillDetailWorkbench';

interface TimelineStatusPanelProps {
  statuses: TimelineDetailStatus[];
  contextLabel?: string;
}

type TimelineStatusGroup = {
  label: string;
  order: number;
  statuses: TimelineDetailStatus[];
};

function fallbackGroup(status: TimelineDetailStatus): Pick<TimelineStatusGroup, 'label' | 'order'> {
  if (/破防|碎甲|击飞|倒地|失衡|猛击|导电|附着|源石结晶/.test(`${status.title} ${status.kind}`)) {
    return { label: '关键战斗状态', order: 0 };
  }
  if (status.kind.includes('武器')) return { label: '当前 Hit · 武器', order: 40 };
  if (status.kind.includes('三件套') || status.kind.includes('装备')) {
    return { label: '当前 Hit · 装备', order: 50 };
  }
  if (status.kind.includes('干员')) return { label: '当前 Hit · 干员自身', order: 30 };
  if (status.kind.includes('异常伤害')) return { label: '异常与额外伤害', order: 80 };
  if (status.kind.includes('变化') || status.kind.includes('刷新') || status.kind.includes('叠层')) {
    return { label: '本 Hit 状态变化', order: 65 };
  }
  return { label: status.kind || '其他状态', order: 90 };
}

function groupStatuses(statuses: TimelineDetailStatus[]): TimelineStatusGroup[] {
  const groups = new Map<string, TimelineStatusGroup>();
  statuses.forEach((status) => {
    const fallback = fallbackGroup(status);
    const label = status.groupLabel || fallback.label;
    const order = status.groupOrder ?? fallback.order;
    const group = groups.get(label) ?? { label, order, statuses: [] };
    group.order = Math.min(group.order, order);
    group.statuses.push(status);
    groups.set(label, group);
  });
  return [...groups.values()]
    .map((group) => ({
      ...group,
      statuses: [...group.statuses].sort((left, right) => (
        (left.priority ?? 1000) - (right.priority ?? 1000)
        || left.title.localeCompare(right.title, 'zh-CN')
        || left.key.localeCompare(right.key)
      )),
    }))
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label, 'zh-CN'));
}

export function TimelineStatusPanel({ statuses, contextLabel }: TimelineStatusPanelProps) {
  const groups = groupStatuses(statuses);
  return (
    <section className="timeline-detail-card timeline-status-card">
      <header className="timeline-status-card-head">
        <h3>命中状态</h3>
        {contextLabel ? <span>{contextLabel}</span> : null}
      </header>
      <div className="timeline-status-list">
        {groups.length === 0 ? <p className="timeline-detail-empty">当前 Hit 没有状态或 Buff 生效</p> : groups.map((group) => (
          <section className="timeline-status-group" key={group.label}>
            <header>
              <strong>{group.label}</strong>
              <span>{group.statuses.length}</span>
            </header>
            <div>
              {group.statuses.map((status) => (
                <button
                  type="button"
                  key={status.key}
                  onContextMenu={status.onRemove ? (event) => {
                    event.preventDefault();
                    status.onRemove?.();
                  } : undefined}
                  title={[status.detail, status.onRemove ? '右键移除' : '由命中与木桩状态机自动解析']
                    .filter(Boolean)
                    .join(' · ')}
                >
                  {status.iconUrl ? (
                    <img
                      className="timeline-status-icon"
                      src={status.iconUrl}
                      alt={status.iconAlt ?? status.title}
                    />
                  ) : <span className="timeline-status-icon-fallback" aria-hidden="true">{status.title.slice(0, 1)}</span>}
                  <span className="timeline-status-copy">
                    <strong>{status.title}</strong>
                    <small>{status.kind}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
