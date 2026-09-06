import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Character, SkillButton } from '../../types';
import { ForcedWaitConfigDialog } from './ForcedWaitConfigDialog';
import { LaneWaitConfigDialog } from './LaneWaitConfigDialog';
import { OperatorSwitchDialog } from './OperatorSwitchDialog';
import { InitialControllerDialog } from './InitialControllerDialog';
import { SkillSandbox } from './SkillSandbox';
import { TimelineOperatorSwitchSegment } from './TimelineOperatorSwitchSegment';
import { TimelineWaitContextMenu, TimelineWaitSegment } from './TimelineWaitSegment';

const character = {
  id: 'operator-1',
  name: '测试干员',
  sandboxSkills: [],
} as Character;

const html = renderToStaticMarkup(
  <SkillSandbox
    selectedCharacters={[character]}
    onDragStart={() => undefined}
    onAvatarDoubleClick={() => undefined}
  />,
);

assert.match(html, /第五站位/);
assert.match(html, /强制等待/);
assert.match(html, /普通等待/);
assert.match(html, /极限闪避/);
assert.match(html, /切人/);
assert.match(html, /普通等待接尾链/);
assert.match(html, /强制等待只吸附组边界/);
assert.match(html, /批量选择/);
assert.equal((html.match(/sandbox-timeline-module/g) ?? []).length, 5);

const browseBatchHtml = renderToStaticMarkup(
  <SkillSandbox
    selectedCharacters={[character]}
    isBrowseMode
    isBatchMode
    onDragStart={() => undefined}
    onAvatarDoubleClick={() => undefined}
  />,
);
assert.match(browseBatchHtml, /aria-label="阅读模式"[^>]*aria-pressed="true"/);
assert.match(browseBatchHtml, /aria-label="批量选择"[^>]*aria-pressed="true"/);

const waitDialogHtml = renderToStaticMarkup(
  <ForcedWaitConfigDialog
    initialConfig={{ schemaVersion: 1, mode: 'fixed-duration', durationSeconds: 2 }}
    tickRate={30}
    onCancel={() => undefined}
    onConfirm={() => undefined}
  />,
);
assert.match(waitDialogHtml, /设置强制等待/);
assert.match(waitDialogHtml, /固定时间/);
assert.match(waitDialogHtml, /自然恢复共享技力/);
assert.match(waitDialogHtml, /执行 60 帧/);

const laneWaitDialogHtml = renderToStaticMarkup(
  <LaneWaitConfigDialog
    initialConfig={{ schemaVersion: 1, mode: 'fixed-duration', durationSeconds: 2 }}
    tickRate={30}
    onCancel={() => undefined}
    onConfirm={() => undefined}
  />,
);
assert.match(laneWaitDialogHtml, /设置普通等待/);
assert.match(laneWaitDialogHtml, /只接入当前角色的尾链/);
assert.match(laneWaitDialogHtml, /不封组/);
assert.match(laneWaitDialogHtml, /执行 60 帧/);

const waitSegmentHtml = renderToStaticMarkup(
  <TimelineWaitSegment
    button={{
      id: 'ordinary-wait-1',
      characterId: '__timeline_tools__',
      characterName: '时间工具',
      skillType: 'Dot',
      skillDisplayName: '普通等待',
      position: { x: 120, y: 100 },
      staffIndex: 0,
      lineIndex: 0,
      nodeIndex: 0,
      timelineModuleKind: 'lane-wait',
      laneWaitConfig: {
        schemaVersion: 1,
        mode: 'fixed-duration',
        durationSeconds: 1,
      },
    } as SkillButton}
    left={80}
    top={85}
    width={80}
    startFrame={30}
    endFrame={60}
    tickRate={30}
    onMouseDown={() => undefined}
    onContextMenu={() => undefined}
    onConfigure={() => undefined}
  />,
);
assert.match(waitSegmentHtml, /timeline-wait-segment/);
assert.match(waitSegmentHtml, /data-timeline-module="lane-wait"/);
assert.match(waitSegmentHtml, /is-lane-wait/);
assert.match(waitSegmentHtml, /timeline-wait-cursor is-start/);
assert.match(waitSegmentHtml, /timeline-wait-cursor is-end/);
assert.match(waitSegmentHtml, /1\.00秒/);
assert.match(waitSegmentHtml, /2\.00秒/);
assert.doesNotMatch(waitSegmentHtml, /skill-button-orb/);

const switchDialogHtml = renderToStaticMarkup(
  <OperatorSwitchDialog
    sourceCharacterId="operator-1"
    characters={[
      character,
      { ...character, id: 'operator-2', name: '目标干员' },
    ]}
    initialConfig={{ schemaVersion: 1, targetCharacterId: 'operator-2' }}
    onCancel={() => undefined}
    onConfirm={() => undefined}
  />,
);
assert.match(switchDialogHtml, /选择切换目标/);
assert.match(switchDialogHtml, /目标干员/);
assert.match(switchDialogHtml, /保留默认/);

const initialControllerDialogHtml = renderToStaticMarkup(
  <InitialControllerDialog
    characters={[
      character,
      { ...character, id: 'operator-2', name: '目标干员' },
    ]}
    initialCharacterId="operator-2"
    onCancel={() => undefined}
    onConfirm={() => undefined}
  />,
);
assert.match(initialControllerDialogHtml, /选择初始主控干员/);
assert.match(initialControllerDialogHtml, /0\.00 秒/);
assert.match(initialControllerDialogHtml, /设为初始主控/);

const switchSegmentHtml = renderToStaticMarkup(
  <TimelineOperatorSwitchSegment
    button={{
      id: 'switch-1',
      characterId: 'operator-1',
      characterName: '测试干员',
      skillType: 'Dot',
      position: { x: 120, y: 100 },
      staffIndex: 0,
      lineIndex: 0,
      nodeIndex: 0,
      timelineModuleKind: 'operator-switch',
      operatorSwitchConfig: { schemaVersion: 1, targetCharacterId: 'operator-2' },
    } as SkillButton}
    targetName="目标干员"
    left={80}
    top={85}
    width={80}
    frame={30}
    tickRate={30}
    onMouseDown={() => undefined}
    onContextMenu={() => undefined}
    onConfigure={() => undefined}
  />,
);
assert.match(switchSegmentHtml, /timeline-operator-switch-segment/);
assert.match(switchSegmentHtml, /data-timeline-module="operator-switch"/);
assert.match(switchSegmentHtml, /切至 目标干员/);
assert.match(switchSegmentHtml, /0秒 · 强制打断/);

const waitContextMenuHtml = renderToStaticMarkup(
  <TimelineWaitContextMenu
    position={{ x: 100, y: 120 }}
    onConfigure={() => undefined}
    onCopy={() => undefined}
    onRemove={() => undefined}
    onCancel={() => undefined}
  />,
);
assert.match(waitContextMenuHtml, /修改等待/);
assert.match(waitContextMenuHtml, /复制/);
assert.match(waitContextMenuHtml, /删除/);
assert.match(waitContextMenuHtml, /取消/);

console.log('Timeline fifth-toolbox controls: PASS');
