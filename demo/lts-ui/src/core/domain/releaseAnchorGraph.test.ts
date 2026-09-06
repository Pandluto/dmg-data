import assert from 'node:assert/strict';
import {
  attachLegacyLanePredecessors,
  buildReleaseSnapPoints,
  getReleaseDeletionBlockers,
  solveReleaseStartOffsets,
  wouldCreateReleaseCycle,
} from './releaseAnchorGraph';

const groupStart = {
  schemaVersion: 1 as const,
  kind: 'group-start' as const,
  debounceFrames: 0,
};

{
  const solution = solveReleaseStartOffsets([
    { id: 'A1', durationFrames: 60, releaseAnchor: groupStart },
    {
      id: 'B1',
      durationFrames: 30,
      releaseAnchor: {
        schemaVersion: 1,
        kind: 'action-start',
        sourceButtonId: 'A1',
        debounceFrames: 0,
      },
    },
    {
      id: 'C1',
      durationFrames: 20,
      releaseAnchor: {
        schemaVersion: 1,
        kind: 'damage-hit',
        sourceButtonId: 'A1',
        sourceHitId: 'A1:preview-hit:0',
        sourceHitOffsetFrames: 24,
        debounceFrames: 6,
      },
    },
    {
      id: 'A2',
      durationFrames: 30,
      defaultPredecessorId: 'A1',
      releaseAnchor: {
        schemaVersion: 1,
        kind: 'action-end',
        sourceButtonId: 'A1',
        debounceFrames: 0,
      },
    },
  ]);
  assert.deepEqual(Object.fromEntries(solution.offsets), {
    A1: 0,
    B1: 0,
    C1: 30,
    A2: 60,
  });
  assert.deepEqual(solution.issues, []);
}

{
  const legacyNodes = attachLegacyLanePredecessors([
    { id: 'legacy-root', staffIndex: 0, lineIndex: 0, nodeIndex: 0 },
    { id: 'legacy-tail', staffIndex: 0, lineIndex: 0, nodeIndex: 1 },
  ]);
  assert.deepEqual(
    getReleaseDeletionBlockers(legacyNodes, 'legacy-root').map(node => node.id),
    ['legacy-tail'],
    'old saves also obey leaf-only deletion before they are re-anchored',
  );
}

{
  const legacy = solveReleaseStartOffsets([
    { id: 'legacy-1', durationFrames: 20 },
    { id: 'legacy-2', durationFrames: 35, defaultPredecessorId: 'legacy-1' },
  ]);
  assert.equal(legacy.offsets.get('legacy-2'), 20);
}

{
  const nodes = [
    { id: 'root', releaseAnchor: groupStart },
    {
      id: 'child',
      releaseAnchor: {
        schemaVersion: 1 as const,
        kind: 'action-end' as const,
        sourceButtonId: 'root',
        debounceFrames: 0,
      },
    },
  ];
  assert.deepEqual(getReleaseDeletionBlockers(nodes, 'root').map(node => node.id), ['child']);
  assert.equal(wouldCreateReleaseCycle(nodes, 'root', 'child'), true);
  assert.equal(wouldCreateReleaseCycle(nodes, 'child', 'root'), false);
}

{
  const points = buildReleaseSnapPoints({
    actions: [{
      id: 'skill',
      groupId: 'g1',
      groupIndex: 0,
      startFrame: 30,
      endFrame: 90,
      startX: 0,
      endX: 80,
      label: '战技',
    }],
    hits: [{
      id: 'skill:preview-hit:0',
      commandId: 'skill',
      frame: 54,
      offsetFrames: 24,
    }],
    timedInputWindows: [{
      id: 'combo-window:1',
      sourceCommandId: 'skill',
      startFrame: 75,
      endFrameExclusive: 87,
      label: '精准输入',
    }],
    debounceFrames: 6,
    projectFrame: frame => frame,
  });
  const hit = points.find(point => point.kind === 'damage-hit');
  assert(hit);
  assert.equal(hit.frame, 60);
  assert.equal(hit.anchor.sourceHitOffsetFrames, 24);
  assert.equal(hit.anchor.debounceFrames, 6);
  assert.equal(points.filter(point => point.kind === 'group-start').length, 1);
  const timedInput = points.find(point => point.kind === 'timed-input');
  assert(timedInput);
  assert.equal(timedInput.frame, 80);
  assert.equal(timedInput.anchor.sourceTimedInputId, 'combo-window:1');
  assert.equal(timedInput.anchor.sourceTimedInputOffsetFrames, 50);
}

{
  const points = buildReleaseSnapPoints({
    actions: [{
      id: 'stage-1',
      groupId: 'g1',
      groupIndex: 0,
      startFrame: 30,
      endFrame: 90,
      startX: 0,
      endX: 80,
      label: '连携·1段',
    }],
    hits: [],
    timedInputWindows: [{
      id: 'combo-window:1:broad',
      sourceTimedInputId: 'combo-window:1',
      sourceCommandId: 'stage-1',
      startFrame: 30,
      endFrameExclusive: 90,
      preferredFrame: 30,
      label: '非精准连携',
    }, {
      id: 'combo-window:1:precision',
      sourceTimedInputId: 'combo-window:1',
      sourceCommandId: 'stage-1',
      startFrame: 75,
      endFrameExclusive: 87,
      label: '精准连携',
    }],
    debounceFrames: 0,
    projectFrame: frame => frame,
  });
  const timedPoints = points.filter(point => point.kind === 'timed-input');
  assert.equal(timedPoints.length, 2, 'one combo must expose broad and precision anchors');
  assert.deepEqual(timedPoints.map(point => point.label), [
    '连携·1段 · 非精准连携',
    '连携·1段 · 精准连携',
  ]);
  assert.ok(timedPoints.every(point => point.anchor.sourceTimedInputId === 'combo-window:1'));
  assert.equal(timedPoints[0].frame, 30, 'broad anchor defaults to the trigger frame');
  assert.equal(timedPoints[1].frame, 80, 'precision anchor remains centered in its active interval');
}

{
  const solution = solveReleaseStartOffsets([
    { id: 'stage-1', durationFrames: 84, releaseAnchor: groupStart },
    {
      id: 'stage-2',
      durationFrames: 30,
      releaseAnchor: {
        schemaVersion: 1,
        kind: 'timed-input',
        sourceButtonId: 'stage-1',
        sourceTimedInputId: 'combo-window:stage-2',
        sourceTimedInputOffsetFrames: 77,
        debounceFrames: 0,
      },
    },
  ]);
  assert.equal(solution.offsets.get('stage-2'), 77);
  assert.deepEqual(solution.issues, []);
}

{
  const points = buildReleaseSnapPoints({
    actions: ['first', 'second'].map((id, i) => ({ id, groupId:'g',groupIndex:0,
      startFrame:i*100,endFrame:i*100+80,startX:0,endX:80,label:id })),
    hits: [{id:'a',commandId:'first',frame:20,offsetFrames:20},
      {id:'b',commandId:'second',frame:120,offsetFrames:20},
      {id:'c',commandId:'second',frame:140,offsetFrames:40}],
    debounceFrames:3,projectFrame:frame=>frame,
  }).filter(point=>point.kind==='damage-hit');
  assert.deepEqual(points.map(point=>point.sourceHitOrdinal),[1,1,2], 'hit labels are local to each cast');
  assert(points.every(point=>point.label.includes('3帧')), 'labels reflect the configured delay');
}
