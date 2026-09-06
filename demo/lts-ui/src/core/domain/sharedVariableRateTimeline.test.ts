import assert from 'node:assert/strict';
import {
  SharedVariableRateTimelineError,
  buildSharedVariableRateTimeline,
  findEarliestSatisfyingFrame,
  projectSharedTimelineFrame,
  type SharedVariableRateTimelineSpec,
} from './sharedVariableRateTimeline';

function action(model: ReturnType<typeof buildSharedVariableRateTimeline>, id: string) {
  const found = model.actions.find((entry) => entry.id === id);
  assert(found, `missing action ${id}`);
  return found;
}

function assertErrorCode(run: () => unknown, expectedCode: string): void {
  assert.throws(run, (error: unknown) => (
    error instanceof SharedVariableRateTimelineError && error.code === expectedCode
  ));
}

// An explicit cross-lane release anchor may begin at an existing action's hit
// boundary. It creates a shared column boundary without changing either real
// duration and without forcing every lane into one linked list.
{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    columnWidth: 80,
    groups: [{
      id: 'anchor-dag',
      lanes: [
        {
          laneId: 'A',
          actions: [{ id: 'A-long', durationFrames: 90, startOffsetFrames: 0 }],
        },
        {
          laneId: 'B',
          actions: [{ id: 'B-after-hit', durationFrames: 30, startOffsetFrames: 36 }],
        },
        {
          laneId: 'C',
          actions: [{ id: 'C-align-B', durationFrames: 45, startOffsetFrames: 36 }],
        },
      ],
    }],
  });
  assert.equal(action(model, 'B-after-hit').startFrame, 36);
  assert.equal(action(model, 'C-align-B').startFrame, 36);
  assert.deepEqual(model.columns.map(column => column.durationFrames), [36, 30, 15, 9]);
}

// Regression contract for the original bug: the adjacent action is chained to
// the ultimate's real blocking end (3.1s), not to a fixed visual-cell clock.
{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    initialFrame: 30,
    columnWidth: 80,
    groups: [{
      id: 'ultimate-chain',
      lanes: [{
        laneId: 'A',
        actions: [
          { id: 'A-ultimate', durationFrames: 63 },
          { id: 'A-skill-after-ultimate', durationFrames: 30 },
        ],
      }],
    }],
  });

  assert.deepEqual(
    [
      action(model, 'A-ultimate').startFrame,
      action(model, 'A-ultimate').endFrame,
      action(model, 'A-skill-after-ultimate').startFrame,
    ],
    [30, 93, 93],
  );
}

// One long action and one short action start together. The long action crosses
// the shared boundary created by the short action instead of owning one fixed
// time scale for its whole visual body.
{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    columnWidth: 80,
    groups: [{
      id: 'opening',
      lanes: [
        { laneId: 'A', actions: [{ id: 'A-basic', durationFrames: 120 }] },
        { laneId: 'B', actions: [{ id: 'B-skill', durationFrames: 30 }] },
      ],
    }],
  });

  assert.deepEqual(model.columns.map((column) => column.durationFrames), [30, 90]);
  assert.deepEqual(action(model, 'A-basic').coveredColumnIds, [
    'group:opening:column:0',
    'group:opening:column:1',
  ]);
  assert.equal(action(model, 'B-skill').coveredColumnIds.length, 1);
  assert.equal(model.groups[0].endFrame, 120);
  assert.equal(projectSharedTimelineFrame(model, 15), 40);
  assert.equal(projectSharedTimelineFrame(model, 60), 80 + (30 / 90) * 80);
}

// A release group with two later boundaries should use full-width columns for
// action starts and compact columns for the continuing tail between them.
// This is the concrete compression regression: 0–50, 50–82, 82–123, 123–153
// becomes 80 + 16 + 80 + 16 visual pixels while every real frame is unchanged.
{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    columnWidth: 80,
    continuationWidthRatio: 0.2,
    groups: [{
      id: 'compressed-tail-regression',
      lanes: [
        { laneId: 'attack', actions: [{ id: 'attack', durationFrames: 153, startOffsetFrames: 0 }] },
        {
          laneId: 'skills',
          actions: [
            { id: 'skill-b', durationFrames: 50, startOffsetFrames: 0 },
            { id: 'skill-e', durationFrames: 41, startOffsetFrames: 82 },
          ],
        },
      ],
    }],
  });

  assert.deepEqual(model.columns.map(column => [column.startFrame, column.endFrame]), [
    [0, 50], [50, 82], [82, 123], [123, 153],
  ]);
  assert.deepEqual(model.columns.map(column => column.xEnd - column.xStart), [80, 16, 80, 16]);
  assert.equal(model.width, 192);
  assert.deepEqual(
    [0, 50, 82, 123, 153].map(frame => projectSharedTimelineFrame(model, frame)),
    [0, 80, 96, 176, 192],
  );
  assert.deepEqual(
    [action(model, 'attack').startFrame, action(model, 'attack').endFrame,
      action(model, 'skill-b').startFrame, action(model, 'skill-b').endFrame,
      action(model, 'skill-e').startFrame, action(model, 'skill-e').endFrame],
    [0, 153, 0, 50, 82, 123],
  );
  assert(action(model, 'skill-e').startX - action(model, 'skill-b').startX >= 80);
}

// Full operation starts keep their width even when a compact continuation is
// inserted before them. The display page pass moves a full start to the next
// page when the remaining slot is too small, and updates every x owner at the
// same boundary.
{
  for (const visualPageWidth of [160, 240]) {
    const model = buildSharedVariableRateTimeline({
      tickRate: 30,
      columnWidth: 80,
      continuationWidthRatio: 0.2,
      visualPageWidth,
      groups: [{
        id: `page-break-${visualPageWidth}`,
        lanes: [
          { laneId: 'attack', actions: [{ id: `page-attack-${visualPageWidth}`, durationFrames: 153 }] },
          {
            laneId: 'skills',
            actions: [
              { id: `page-b-${visualPageWidth}`, durationFrames: 50 },
              { id: `page-e-${visualPageWidth}`, durationFrames: 41, startOffsetFrames: 82 },
            ],
          },
        ],
      }],
    });
    const pageColumns = model.columns.filter(column => column.kind === 'activity');
    pageColumns.filter(column => column.xEnd - column.xStart >= model.columnWidth).forEach(column => {
      const pageOffset = column.xStart % visualPageWidth;
      assert(
        pageOffset + model.columnWidth <= visualPageWidth,
        `full column starts inside visual page ${visualPageWidth}`,
      );
    });
    assert.deepEqual(
      model.actions.map(entry => [entry.id.includes('-attack') ? 'attack' : entry.id.includes('-b-') ? 'b' : 'e', entry.startFrame, entry.endFrame]),
      [['attack', 0, 153], ['b', 0, 50], ['e', 82, 123]],
    );
    const eAction = model.actions.find(entry => entry.id === `page-e-${visualPageWidth}`)!;
    const eColumn = model.columns.find(column => column.id === eAction.primaryColumnId)!;
    assert.equal(eAction.startX, eColumn.xStart, 'action start follows its mapped primary column');
    assert.equal(eAction.startFrame, 82, 'page adjustment does not change release frame');
    assert.equal(
      projectSharedTimelineFrame(model, 82),
      eAction.startX,
      'frame projection follows the same mapped boundary as the action',
    );
    assert.equal(projectSharedTimelineFrame(model, 123), eAction.endX, 'mapped end boundary remains aligned');
    if (visualPageWidth === 160) {
      assert.equal(eAction.startX, 160, 'full operation starts at the next page boundary');
      assert.equal(model.groups[0].xEnd, 256, 'the absorbed page gap remains part of total visual width');
    } else {
      assert.equal(eAction.startX, 96, 'a page with enough room remains unchanged');
      assert.equal(model.groups[0].xEnd, 192, 'no unnecessary page gap is inserted');
    }
  }
}

// An ordinary wait is a lane-local dependency, not a full-column group seal.
// It delays only B's successor while A keeps running inside the same group.
{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    columnWidth: 80,
    groups: [{
      id: 'ordinary-wait-group',
      laneWaits: [{
        id: 'B-wait',
        laneId: 'B',
        startOffsetFrames: 0,
        durationFrames: 60,
      }],
      lanes: [
        { laneId: 'A', actions: [{ id: 'A-long', durationFrames: 120, startOffsetFrames: 0 }] },
        { laneId: 'B', actions: [{ id: 'B-after-wait', durationFrames: 30, startOffsetFrames: 60 }] },
      ],
    }],
  });

  assert.equal(model.groups.length, 1);
  assert.equal(model.waits.length, 0);
  assert.equal(model.laneWaits.length, 1);
  assert.deepEqual(
    [model.laneWaits[0].startFrame, model.laneWaits[0].endFrame],
    [0, 60],
  );
  assert.equal(action(model, 'A-long').startFrame, 0);
  assert.equal(action(model, 'B-after-wait').startFrame, 60);
  assert.equal(model.groups[0].endFrame, 120);
}

// A lane wait keeps its covered segment at the full operation width; a later
// interval where only A continues can still use the compact continuation rate.
{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    columnWidth: 80,
    continuationWidthRatio: 0.2,
    groups: [{
      id: 'ordinary-wait-widths',
      laneWaits: [{ id: 'B-wait-width', laneId: 'B', startOffsetFrames: 0, durationFrames: 30 }],
      lanes: [
        { laneId: 'A', actions: [{ id: 'A-long-width', durationFrames: 120 }] },
        { laneId: 'B', actions: [{ id: 'B-after-width', durationFrames: 30, startOffsetFrames: 60 }] },
      ],
    }],
  });
  assert.deepEqual(model.columns.map(column => column.xEnd - column.xStart), [80, 16, 80, 16]);
  assert.equal(model.laneWaits[0].endX - model.laneWaits[0].startX, 80);
  assert.equal(action(model, 'B-after-width').startX, 96);
}

// A zero-time ordinary wait consumes one visible cell for its lane without
// advancing real time or inserting a separator. Its successor begins after
// that visual cell while simultaneous actions retain their real frame.
{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    columnWidth: 80,
    continuationWidthRatio: 0.2,
    groups: [{
      id: 'ordinary-placeholder-group',
      laneWaits: [{
        id: 'B-placeholder',
        laneId: 'B',
        startOffsetFrames: 0,
        durationFrames: 0,
      }],
      lanes: [
        { laneId: 'A', actions: [{ id: 'A-running', durationFrames: 120, startOffsetFrames: 0 }] },
        {
          laneId: 'B',
          actions: [{
            id: 'B-after-placeholder',
            durationFrames: 30,
            startOffsetFrames: 0,
            payload: {
              releaseAnchor: { sourceButtonId: 'B-placeholder' },
            },
          }],
        },
      ],
    }],
  });

  assert.equal(model.groups.length, 1);
  assert.equal(model.waits.length, 0);
  assert.equal(model.laneWaits[0].durationFrames, 0);
  assert.equal(model.laneWaits[0].endX - model.laneWaits[0].startX, 80);
  assert.equal(action(model, 'A-running').startFrame, 0);
  assert.equal(action(model, 'B-after-placeholder').startFrame, 0);
  assert.equal(action(model, 'B-after-placeholder').startX, 80);
}

// Switching operators is a zero-time control handoff with one visible cell.
// A successor attached to it starts at the same real frame on the new lane,
// but is projected after the handoff cell.
{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    columnWidth: 80,
    continuationWidthRatio: 0.2,
    groups: [{
      id: 'operator-handoff-group',
      operatorSwitches: [{
        id: 'switch-A-to-B',
        laneId: 'A',
        targetLaneId: 'B',
        startOffsetFrames: 30,
      }],
      lanes: [
        { laneId: 'A', actions: [{ id: 'A-opening', durationFrames: 90, startOffsetFrames: 0 }] },
        {
          laneId: 'B',
          actions: [{
            id: 'B-after-switch',
            durationFrames: 30,
            startOffsetFrames: 30,
            payload: { releaseAnchor: { sourceButtonId: 'switch-A-to-B' } },
          }],
        },
      ],
    }],
  });

  const operatorSwitch = model.operatorSwitches[0];
  assert.equal(operatorSwitch.durationFrames, 0);
  assert.equal(operatorSwitch.startFrame, 30);
  assert.equal(operatorSwitch.endX - operatorSwitch.startX, 80);
  assert.equal(action(model, 'B-after-switch').startFrame, 30);
  assert.equal(action(model, 'B-after-switch').startX, operatorSwitch.endX);
}

// A's tail-chain creates two boundaries. C's longer action is automatically
// stretched over all resulting columns, including its short final tail.
{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    columnWidth: 100,
    groups: [{
      id: 'tail-chain',
      lanes: [
        {
          laneId: 'A',
          actions: [
            { id: 'A-1', durationFrames: 60 },
            { id: 'A-2', durationFrames: 60 },
          ],
        },
        { laneId: 'C', actions: [{ id: 'C-1', durationFrames: 150 }] },
      ],
    }],
  });

  assert.deepEqual(model.columns.map((column) => column.durationFrames), [60, 60, 30]);
  assert.deepEqual(
    [action(model, 'A-1').startFrame, action(model, 'A-2').startFrame],
    [0, 60],
  );
  assert.equal(action(model, 'C-1').coveredColumnIds.length, 3);
  assert.equal(model.groups[0].endFrame, 150);
}

// A zero-time full wait column still occupies one complete visual column. It
// seals the first release group without inventing combat time.
{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    columnWidth: 80,
    groups: [
      {
        id: 'g1',
        lanes: [{ laneId: 'A', actions: [{ id: 'A-long', durationFrames: 120 }] }],
      },
      {
        id: 'g2',
        separatorBefore: { id: 'seal', mode: 'seal-only' },
        lanes: [{ laneId: 'B', actions: [{ id: 'B-after-seal', durationFrames: 30 }] }],
      },
    ],
  });

  assert.equal(model.waits[0].durationFrames, 0);
  assert.equal(model.groups[1].startFrame, 120);
  assert.equal(model.width, 240);
  assert.equal(projectSharedTimelineFrame(model, 120, 'before'), 80);
  assert.equal(projectSharedTimelineFrame(model, 120, 'center'), 120);
  assert.equal(projectSharedTimelineFrame(model, 120, 'after'), 160);
}

// Fixed and runtime-resolved wait modes delay only the following group.
{
  const initialWaitModel = buildSharedVariableRateTimeline({
    tickRate: 30,
    columnWidth: 80,
    initialWait: { id: 'opening-wait', mode: 'fixed-duration', durationFrames: 45 },
    groups: [{
      id: 'opening-after-wait',
      lanes: [{ laneId: 'A', actions: [{ id: 'opening-action', durationFrames: 30 }] }],
    }],
  });
  assert.equal(initialWaitModel.waits[0].previousGroupId, 'timeline-origin');
  assert.equal(initialWaitModel.waits[0].endFrame, 45);
  assert.equal(initialWaitModel.groups[0].startFrame, 45);
  assert.equal(initialWaitModel.width, 160);

  const fixedModel = buildSharedVariableRateTimeline({
    tickRate: 30,
    groups: [
      {
        id: 'fixed-g1',
        lanes: [{ laneId: 'A', actions: [{ id: 'fixed-a', durationFrames: 30 }] }],
      },
      {
        id: 'fixed-g2',
        separatorBefore: { id: 'fixed-wait', mode: 'fixed-duration', durationFrames: 60 },
        lanes: [{ laneId: 'B', actions: [{ id: 'fixed-b', durationFrames: 30 }] }],
      },
    ],
  });
  assert.equal(fixedModel.waits[0].startFrame, 30);
  assert.equal(fixedModel.waits[0].endFrame, 90);
  assert.equal(fixedModel.groups[1].startFrame, 90);

  let resolverCalls = 0;
  const dynamicModel = buildSharedVariableRateTimeline({
    tickRate: 30,
    groups: [
      {
        id: 'dynamic-g1',
        lanes: [{ laneId: 'A', actions: [{ id: 'dynamic-a', durationFrames: 30 }] }],
      },
      {
        id: 'dynamic-g2',
        separatorBefore: { id: 'atb-wait', mode: 'atb-target', targetAtb: 200 },
        lanes: [
          {
            laneId: 'B',
            actions: [{ id: 'dynamic-b', durationFrames: 30, sharedAtbCost: 100 }],
          },
          {
            laneId: 'C',
            actions: [{ id: 'dynamic-c', durationFrames: 45, sharedAtbCost: 100 }],
          },
        ],
      },
    ],
  }, {
    resolveDynamicWait: (request) => {
      resolverCalls += 1;
      assert.equal(request.boundaryFrame, 30);
      assert.equal(request.nextGroupFirstSharedAtbCost, 200);
      assert.equal(request.wait.mode, 'atb-target');
      assert.equal(request.wait.targetAtb, 200);
      return { durationFrames: 45, reason: 'ATB_200_REACHED' };
    },
  });
  assert.equal(resolverCalls, 1);
  assert.equal(dynamicModel.groups[1].startFrame, 75);
  assert.equal(dynamicModel.waits[0].resolutionReason, 'ATB_200_REACHED');
}

// A cached zero result means the target is already satisfied. The structural
// wait/seal column remains present even though no real frame elapses.
{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    groups: [
      {
        id: 'cached-g1',
        lanes: [{ laneId: 'A', actions: [{ id: 'cached-a', durationFrames: 30 }] }],
      },
      {
        id: 'cached-g2',
        separatorBefore: {
          id: 'cached-atb',
          mode: 'atb-target',
          targetAtb: 100,
          resolvedDurationFrames: 0,
        },
        lanes: [{ laneId: 'B', actions: [{ id: 'cached-b', durationFrames: 30 }] }],
      },
    ],
  });
  assert.equal(model.waits.length, 1);
  assert.equal(model.waits[0].durationFrames, 0);
  assert.equal(model.groups[1].startFrame, 30);
}

// Same-frame releases are validated as one shared-resource cohort. Without a
// runtime validator they are explicitly unverified, never silently accepted.
{
  const spec: SharedVariableRateTimelineSpec = {
    tickRate: 30,
    groups: [{
      id: 'cohort-group',
      lanes: [
        {
          laneId: 'A',
          actions: [
            { id: 'cohort-a1', durationFrames: 30, sharedAtbCost: 100 },
            { id: 'cohort-a2', durationFrames: 30, sharedAtbCost: 50 },
          ],
        },
        {
          laneId: 'B',
          actions: [{ id: 'cohort-b1', durationFrames: 60, sharedAtbCost: 100 }],
        },
      ],
    }],
  };

  const unverified = buildSharedVariableRateTimeline(spec);
  assert.equal(unverified.cohorts[0].requiredSharedAtb, 200);
  assert.equal(unverified.cohorts[0].status, 'unverified');
  assert.equal(unverified.admissionStatus, 'unverified');
  assert.equal(unverified.isExecutable, false);

  const validated = buildSharedVariableRateTimeline(spec, {
    validateReleaseCohort: (cohort) => ({
      allowed: cohort.requiredSharedAtb <= 199,
      availableSharedAtb: 199,
      reason: cohort.requiredSharedAtb <= 199 ? 'ENOUGH_ATB' : 'ATB_NOT_ENOUGH',
    }),
  });
  assert.equal(validated.cohorts[0].status, 'invalid');
  assert.equal(validated.cohorts[0].requiredSharedAtb, 200);
  assert.equal(validated.cohorts[1].frame, 30);
  assert.equal(validated.cohorts[1].status, 'valid');
  assert.equal(validated.admissionStatus, 'invalid');
  assert.equal(validated.isExecutable, false);

  const executable = buildSharedVariableRateTimeline(spec, {
    validateReleaseCohort: () => ({ allowed: true, reason: 'ENGINE_CONFIRMED' }),
  });
  assert.equal(executable.admissionStatus, 'valid');
  assert.equal(executable.isExecutable, true);
}

// Dynamic waits cannot pretend to be legal when no authoritative runtime
// resolver is installed, and unrelated groups cannot silently skip the seal.
{
  assertErrorCode(() => buildSharedVariableRateTimeline({
    tickRate: 30,
    groups: [
      {
        id: 'missing-runtime-g1',
        lanes: [{ laneId: 'A', actions: [{ id: 'missing-runtime-a', durationFrames: 30 }] }],
      },
      {
        id: 'missing-runtime-g2',
        separatorBefore: { id: 'missing-runtime-wait', mode: 'next-group-ready' },
        lanes: [{ laneId: 'B', actions: [{ id: 'missing-runtime-b', durationFrames: 30 }] }],
      },
    ],
  }), 'UNRESOLVED_DYNAMIC_WAIT');

  assertErrorCode(() => buildSharedVariableRateTimeline({
    tickRate: 30,
    groups: [
      {
        id: 'missing-seal-g1',
        lanes: [{ laneId: 'A', actions: [{ id: 'missing-seal-a', durationFrames: 30 }] }],
      },
      {
        id: 'missing-seal-g2',
        lanes: [{ laneId: 'B', actions: [{ id: 'missing-seal-b', durationFrames: 30 }] }],
      },
    ],
  }), 'MISSING_WAIT_COLUMN');

  assertErrorCode(() => buildSharedVariableRateTimeline({
    tickRate: 30,
    continuationWidthRatio: 0,
    groups: [{
      id: 'invalid-continuation-ratio',
      lanes: [{ laneId: 'A', actions: [{ id: 'invalid-ratio-action', durationFrames: 30 }] }],
    }],
  }), 'INVALID_CONTINUATION_WIDTH_RATIO');

  assertErrorCode(() => buildSharedVariableRateTimeline({
    tickRate: 30,
    columnWidth: 80,
    visualPageWidth: 79,
    groups: [{
      id: 'invalid-visual-page-width',
      lanes: [{ laneId: 'A', actions: [{ id: 'invalid-page-action', durationFrames: 30 }] }],
    }],
  }), 'INVALID_VISUAL_PAGE_WIDTH');
}

// Runtime adapters can use the frame search helper for exact state-machine
// snapshots rather than approximating recovery with UI-cell arithmetic.
{
  assert.equal(findEarliestSatisfyingFrame({
    fromFrame: 20,
    throughFrame: 100,
    isSatisfied: (frame) => frame >= 73,
  }), 73);
  assert.equal(findEarliestSatisfyingFrame({
    fromFrame: 20,
    throughFrame: 40,
    isSatisfied: () => false,
  }), null);
}

console.log('Shared variable-rate timeline domain model: PASS');
