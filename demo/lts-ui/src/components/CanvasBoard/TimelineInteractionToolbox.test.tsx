import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Character, SkillButton } from '../../types';
import { ForcedWaitConfigDialog } from './ForcedWaitConfigDialog';
import { SkillSandbox } from './SkillSandbox';
import { TimelineWaitSegment } from './TimelineWaitSegment';

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
assert.match(html, /封组等待/);
assert.match(html, /普通等待/);
assert.match(html, /极限闪避/);
assert.match(html, /等待只吸附完整组边界/);
assert.equal((html.match(/sandbox-timeline-module/g) ?? []).length, 4);

const waitDialogHtml = renderToStaticMarkup(
  <ForcedWaitConfigDialog
    initialConfig={{ schemaVersion: 1, mode: 'fixed-duration', durationSeconds: 2 }}
    tickRate={30}
    onCancel={() => undefined}
    onConfirm={() => undefined}
  />,
);
assert.match(waitDialogHtml, /设置等待/);
assert.match(waitDialogHtml, /普通等待/);
assert.match(waitDialogHtml, /自然恢复共享技力/);
assert.match(waitDialogHtml, /执行 60 帧/);

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
      timelineModuleKind: 'forced-wait',
      forcedWaitConfig: {
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
assert.match(waitSegmentHtml, /timeline-wait-cursor is-start/);
assert.match(waitSegmentHtml, /timeline-wait-cursor is-end/);
assert.match(waitSegmentHtml, /1\.00秒/);
assert.match(waitSegmentHtml, /2\.00秒/);
assert.doesNotMatch(waitSegmentHtml, /skill-button-orb/);

console.log('Timeline fifth-toolbox controls: PASS');
