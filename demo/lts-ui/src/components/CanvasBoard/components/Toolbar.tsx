/**
 * Toolbar 工具栏组件
 *
 * 功能说明：
 * - 页面顶部的操作栏，提供返回、快照保存、快照恢复、排轴分享、伤害计算等功能
 * - 左侧：返回按钮
 * - 中间：干员组数量控制；下限会随已有排轴自动扩展
 * - 右侧：保存按钮、恢复按钮、计算伤害按钮
 *
 * 使用场景：
 * - CanvasBoard 画布区域顶部
 */

interface ToolbarProps {
  /** 当前干员组数量 */
  staffCount: number;
  /** 已有节点实际占用的最少组数 */
  minStaffCount?: number;
  /** 手动可增加到的最多组数 */
  maxStaffCount?: number;
  /** 返回按钮点击事件 */
  onBack: () => void;
  /** 增加干员组按钮点击事件 */
  onAddGroup: () => void;
  /** 减少干员组按钮点击事件 */
  onRemoveGroup: () => void;
  /** 导出存档管理按钮点击事件 */
  onSave?: () => void;
  /** 恢复按钮点击事件 */
  onRestore?: () => void;
  /** 分享按钮点击事件 */
  onShare?: () => void;
  /** 计算伤害/生成报表点击事件 */
  onCalculate?: () => void;
  calculateLabel?: string;
  calculateDisabled?: boolean;
  onInspectIssues?: () => void;
}

/**
 * Toolbar 工具栏组件
 *
 * @param props - 组件属性
 * @param props.staffCount - 当前干员组数量
 * @param props.onBack - 返回按钮回调
 * @param props.onAddGroup - 增加干员组回调
 * @param props.onRemoveGroup - 减少干员组回调
 */
export function Toolbar({
  staffCount,
  minStaffCount = 2,
  maxStaffCount = 24,
  onBack,
  onAddGroup,
  onRemoveGroup,
  onSave,
  onRestore,
  onShare,
  onCalculate,
  calculateLabel,
  calculateDisabled = false,
  onInspectIssues,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      {/* 左侧：返回按钮 */}
      <button className="btn-back" onClick={onBack}>
        返回
      </button>

      {/* 中间：干员组数量控制（加减按钮 + 当前组号显示） */}
      <div className="staff-group-controls">
        {/* 不能删掉仍被旧排轴占用的组。 */}
        <button
          className="btn-remove-group"
          onClick={onRemoveGroup}
          disabled={staffCount <= minStaffCount}
        >
          -
        </button>

        {/* 当前组号显示 */}
        <span className="staff-group-count">第{staffCount}组</span>

        {/* 手动追加空白组。 */}
        <button
          className="btn-add-group"
          onClick={onAddGroup}
          disabled={staffCount >= maxStaffCount}
        >
          +
        </button>
      </div>

      {/* 右侧：保存和伤害计算按钮 */}
      <div className="toolbar-right">
        <button
          className="btn-save"
          onClick={onSave}
          title="新建、打开或导出队伍与排轴存档"
        >
          存档管理
        </button>
        <button className="btn-save" onClick={onRestore}>恢复</button>
        <button className="btn-save" onClick={onShare}>导出</button>
        <button className="btn-calculate" onClick={onInspectIssues ?? onCalculate} disabled={calculateDisabled && !onInspectIssues}>
          {calculateLabel || '计算伤害'}
          {onInspectIssues && ' · 查看原因'}
        </button>
      </div>
    </div>
  );
}
