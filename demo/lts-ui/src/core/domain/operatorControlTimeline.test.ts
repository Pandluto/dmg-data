import assert from 'node:assert/strict';
import { buildSharedVariableRateTimeline } from './sharedVariableRateTimeline';
import {
  controlledOperatorAt,
  resolveInitialControllerLaneId,
  validateOperatorControlTimeline,
} from './operatorControlTimeline';

assert.equal(resolveInitialControllerLaneId('B', ['A', 'B', 'C']), 'B');
assert.equal(resolveInitialControllerLaneId('removed', ['A', 'B']), 'A');
assert.equal(resolveInitialControllerLaneId(undefined, ['A', 'B']), 'A');
assert.equal(resolveInitialControllerLaneId(undefined, []), null);

{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    columnWidth: 80,
    groups: [{
      id: 'control',
      operatorSwitches: [{
        id: 'switch-A-to-B',
        operationOrder: 7,
        laneId: 'A',
        targetLaneId: 'B',
        startOffsetFrames: 30,
      }],
      lanes: [
        {
          laneId: 'A',
          actions: [{
            id: 'A-ultimate',
            operationOrder: 0,
            durationFrames: 30,
            startOffsetFrames: 0,
            payload: { commandType: 'UltimateSkill', skillType: 'Q' },
          }],
        },
        {
          laneId: 'B',
          actions: [{
            id: 'B-attack',
            operationOrder: 8,
            durationFrames: 30,
            startOffsetFrames: 30,
            payload: {
              commandType: 'Attack',
              skillType: 'A',
              releaseAnchor: { sourceButtonId: 'switch-A-to-B' },
            },
          }],
        },
      ],
    }],
  });
  assert.equal(controlledOperatorAt('A', model.operatorSwitches, { frame: 30, operationOrder: 6, phase: 'before' }), 'A');
  assert.equal(controlledOperatorAt('A', model.operatorSwitches, { frame: 30, operationOrder: 7, phase: 'before' }), 'A');
  assert.equal(controlledOperatorAt('A', model.operatorSwitches, { frame: 30, operationOrder: 7, phase: 'after' }), 'B');
  assert.equal(controlledOperatorAt('A', model.operatorSwitches, { frame: 30, operationOrder: 8, phase: 'before' }), 'B');
  model.operatorSwitches[0].endX = -99999;
  assert.equal(controlledOperatorAt('A', model.operatorSwitches, { frame: 30, operationOrder: 6, phase: 'before' }), 'A');
  assert.deepEqual(validateOperatorControlTimeline(model, 'A'), []);
}

{
  const model = buildSharedVariableRateTimeline({
    tickRate: 30,
    groups: [{
      id: 'invalid-control',
      operatorSwitches: [{
        id: 'switch-during-q',
        operationOrder: 2,
        laneId: 'A',
        targetLaneId: 'B',
        startOffsetFrames: 15,
      }],
      lanes: [
        {
          laneId: 'A',
          actions: [{
            id: 'A-ultimate',
            operationOrder: 0,
            durationFrames: 60,
            payload: { commandType: 'UltimateSkill', skillType: 'Q' },
          }],
        },
        {
          laneId: 'C',
          actions: [{
            id: 'C-attack',
            operationOrder: 1,
            durationFrames: 30,
            payload: { commandType: 'Attack', skillType: 'A' },
          }],
        },
      ],
    }],
  });
  const codes = validateOperatorControlTimeline(model, 'A').map(issue => issue.code);
  assert(codes.includes('SWITCH_DURING_ULTIMATE'));
  assert(codes.includes('BASIC_ATTACK_SOURCE_NOT_CONTROLLED'));
}
