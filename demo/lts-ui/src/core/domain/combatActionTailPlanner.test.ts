import assert from 'node:assert/strict';
import {
  CombatActionTailPlannerError,
  applyComboContinuity,
  buildBasicAttackCutOptions,
  createDodgeModuleSpec,
  debounceFramesForTickRate,
  lockTailTransitionBundle,
  resolveActionTailTransition,
  type ActionTailTimingContract,
  type TailSuccessorIntent,
} from './combatActionTailPlanner';

const debounceFrames = debounceFramesForTickRate(30);
assert.equal(debounceFrames, 6, '0.2 seconds is six frames at the AKE 30 Hz clock');

const sameNormalSkill: TailSuccessorIntent = {
  actionId: 'next-normal-skill',
  skillId: 'chr_0004_pelica_normal_skill',
  kind: 'normal-skill',
  priority: 2,
};

// Pelica's public data has a 155-frame animation body, a frame-13 hit and a
// verified same-skill successor window at frame 28. The scheduler must use the
// window, not display the remaining ~4.2 seconds as blocking recovery.
{
  const pelica: ActionTailTimingContract = {
    actionId: 'pelica-skill-1',
    skillId: 'chr_0004_pelica_normal_skill',
    kind: 'normal-skill',
    naturalEndOffsetFrames: 154,
    effectEndOffsetFrames: 13,
    exclusiveEndOffsetFrames: 30,
    priority: 2,
    interruptibleAtOffsetFrames: [],
    successorWindows: [{
      startOffsetFrames: 28,
      endOffsetFrames: 54,
      allowedActionIds: ['chr_0004_pelica_normal_skill'],
    }],
    commitEvents: [{
      id: 'pelica-hit',
      kind: 'hit',
      commitOffsetFrames: 13,
      effectOffsetFrames: 13,
    }],
    tailCancelable: true,
    commitEvidence: 'verified',
  };

  const chained = resolveActionTailTransition({
    predecessor: pelica,
    successor: sameNormalSkill,
    boundary: 'append',
    debounceFrames,
  });
  assert.equal(chained.status, 'compressed');
  assert.equal(chained.reason, 'ALLOWED_SUCCESSOR_WINDOW');
  assert.equal(chained.commitFloorOffsetFrames, 19);
  assert.equal(chained.blockingEndOffsetFrames, 28);
  assert.equal(chained.effectEndOffsetFrames, 13);
  assert.equal(chained.compressedFrames, 126);

  const sealed = resolveActionTailTransition({
    predecessor: pelica,
    successor: null,
    boundary: 'group-seal',
    debounceFrames,
  });
  assert.equal(sealed.reason, 'GROUP_SEAL_WINDOW');
  assert.equal(sealed.blockingEndOffsetFrames, 28);

  const ultimate = resolveActionTailTransition({
    predecessor: pelica,
    successor: {
      actionId: 'pelica-ultimate',
      kind: 'ultimate-skill',
      priority: 7,
    },
    boundary: 'append',
    debounceFrames,
  });
  assert.equal(ultimate.reason, 'HIGHER_PRIORITY');
  assert.equal(ultimate.blockingEndOffsetFrames, 19);
}

// Zhuang Fangyi's base normal skill commits its sword-control state near the
// beginning but its damage is emitted later by spawned sword Buffs. Even when
// the direct-hit list is empty, the verified frame-45 successor window prevents
// the 190-frame probe body from becoming mandatory blocking time.
{
  const zhuang: ActionTailTimingContract = {
    actionId: 'zhuang-skill-1',
    skillId: 'chr_0030_zhuangfy_normal_skill',
    kind: 'normal-skill',
    naturalEndOffsetFrames: 190,
    effectEndOffsetFrames: 6,
    exclusiveEndOffsetFrames: 135,
    priority: 2,
    interruptibleAtOffsetFrames: [],
    successorWindows: [
      {
        startOffsetFrames: 45,
        endOffsetFrames: 116,
        allowedActionIds: ['chr_0030_zhuangfy_normal_skill'],
      },
      {
        startOffsetFrames: 120,
        endOffsetFrames: 147,
        allowedActionIds: ['chr_0030_zhuangfy_normal_skill'],
      },
    ],
    commitEvents: [{
      id: 'zhuang-sword-control-committed',
      kind: 'state-change',
      commitOffsetFrames: 6,
      effectOffsetFrames: 6,
    }],
    tailCancelable: true,
    commitEvidence: 'verified',
  };
  const transition = resolveActionTailTransition({
    predecessor: zhuang,
    successor: {
      actionId: 'zhuang-skill-2',
      skillId: 'chr_0030_zhuangfy_normal_skill',
      kind: 'normal-skill',
      priority: 2,
    },
    boundary: 'append',
    debounceFrames,
  });
  assert.equal(transition.commitFloorOffsetFrames, 12);
  assert.equal(transition.blockingEndOffsetFrames, 45);
  assert.equal(transition.compressedFrames, 145);
}

const basicAttack: ActionTailTimingContract = {
  actionId: 'A-basic-chain',
  skillId: 'A-basic-chain',
  kind: 'basic-attack',
  naturalEndOffsetFrames: 120,
  effectEndOffsetFrames: 95,
  exclusiveEndOffsetFrames: 110,
  priority: 0,
  interruptibleAtOffsetFrames: [],
  successorWindows: [],
  commitEvents: [
    { id: 'basic-hit-1', kind: 'hit', commitOffsetFrames: 10, basicStageOrdinal: 1 },
    { id: 'basic-hit-2', kind: 'hit', commitOffsetFrames: 35, basicStageOrdinal: 2 },
    { id: 'basic-hit-3', kind: 'hit', commitOffsetFrames: 65, basicStageOrdinal: 3 },
    { id: 'basic-hit-4', kind: 'hit', commitOffsetFrames: 95, basicStageOrdinal: 4 },
  ],
  tailCancelable: true,
  commitEvidence: 'verified',
  basicCombo: {
    comboId: 'A-basic',
    stageCount: 4,
    startingStageIndex: 0,
    renderedStageCount: 4,
  },
};

const normalSkillAfterBasic: TailSuccessorIntent = {
  actionId: 'A-normal-skill',
  kind: 'normal-skill',
  priority: 2,
};

// Dropping anything behind a multi-stage basic attack is not finalized until
// the user selects a stage on the slider.
{
  const unresolved = resolveActionTailTransition({
    predecessor: basicAttack,
    successor: normalSkillAfterBasic,
    boundary: 'append',
    debounceFrames,
  });
  assert.equal(unresolved.status, 'selection-required');
  assert.equal(unresolved.reason, 'BASIC_STAGE_SELECTION_REQUIRED');
  assert.throws(() => lockTailTransitionBundle({
    id: 'invalid-bundle',
    predecessorActionId: basicAttack.actionId,
    successorActionId: normalSkillAfterBasic.actionId,
    transition: unresolved,
  }), (error: unknown) => (
    error instanceof CombatActionTailPlannerError
    && error.code === 'UNRESOLVED_TRANSITION'
  ));
}

// Selecting two stages keeps hit 1/2, prunes hit 3/4, then starts the higher
// priority skill six frames after hit 2. The combo cursor remains at stage 3.
{
  const selected = resolveActionTailTransition({
    predecessor: basicAttack,
    successor: normalSkillAfterBasic,
    boundary: 'append',
    debounceFrames,
    selectedBasicStageCount: 2,
  });
  assert.equal(selected.status, 'compressed');
  assert.equal(selected.reason, 'BASIC_STAGE_BOUNDARY');
  assert.equal(selected.blockingEndOffsetFrames, 41);
  assert.deepEqual(selected.settledEventIds, ['basic-hit-1', 'basic-hit-2']);
  assert.deepEqual(selected.prunedEventIds, ['basic-hit-3', 'basic-hit-4']);
  assert.equal(selected.effectEndOffsetFrames, 35);
  assert.deepEqual(selected.comboCursorAfter, {
    comboId: 'A-basic',
    stageCount: 4,
    nextStageIndex: 2,
  });

  assert.deepEqual(lockTailTransitionBundle({
    id: 'basic-plus-skill',
    predecessorActionId: basicAttack.actionId,
    successorActionId: normalSkillAfterBasic.actionId,
    transition: selected,
  }), {
    id: 'basic-plus-skill',
    predecessorActionId: 'A-basic-chain',
    successorActionId: 'A-normal-skill',
    selectedBasicStageCount: 2,
    blockingEndOffsetFrames: 41,
    immutable: true,
    editPolicy: 'delete-successor-to-recompute',
  });
}

// The slider exposes one deterministic cut option per rendered combo stage.
{
  const options = buildBasicAttackCutOptions({
    predecessor: basicAttack,
    successor: normalSkillAfterBasic,
    boundary: 'append',
    debounceFrames,
  });
  assert.deepEqual(options.map(option => [
    option.stageCount,
    option.transition.blockingEndOffsetFrames,
  ]), [
    [1, 16],
    [2, 41],
    [3, 71],
    [4, 101],
  ]);
}

// Skill, combo and both dodge variants preserve an unfinished basic cursor;
// ultimate, the explicit reset block and a group seal reset it.
{
  const cursor = { comboId: 'A-basic', stageCount: 4, nextStageIndex: 2 };
  for (const kind of ['normal-skill', 'combo-skill', 'dodge', 'perfect-dodge'] as const) {
    assert.equal(applyComboContinuity(cursor, { kind })?.nextStageIndex, 2);
  }
  assert.equal(applyComboContinuity(cursor, {
    kind: 'basic-attack',
    completedBasicStageCount: 2,
  })?.nextStageIndex, 0);
  assert.equal(applyComboContinuity(cursor, { kind: 'ultimate-skill' })?.nextStageIndex, 0);
  assert.equal(applyComboContinuity(cursor, { kind: 'basic-combo-reset' })?.nextStageIndex, 0);
  assert.equal(applyComboContinuity(cursor, { kind: 'group-seal' })?.nextStageIndex, 0);
}

// Dodge can interrupt the active basic body while preserving the combo cursor.
// Perfect-dodge ATB is explicitly runtime-gated rather than granted on drag.
{
  const dodge = resolveActionTailTransition({
    predecessor: basicAttack,
    successor: {
      actionId: 'perfect-dodge',
      kind: 'perfect-dodge',
      priority: null,
      forceInterruptsKinds: ['basic-attack'],
    },
    boundary: 'append',
    debounceFrames,
    selectedBasicStageCount: 1,
  });
  assert.equal(dodge.reason, 'BASIC_STAGE_BOUNDARY');
  assert.equal(dodge.blockingEndOffsetFrames, 16);
  assert.equal(dodge.comboCursorAfter?.nextStageIndex, 1);
  assert.deepEqual(createDodgeModuleSpec({
    id: 'perfect-dodge',
    kind: 'perfect-dodge',
    durationFrames: 18,
    sharedAtbGain: 25,
  }), {
    id: 'perfect-dodge',
    kind: 'perfect-dodge',
    durationFrames: 18,
    sharedAtbGain: 25,
    resourceVerdict: 'runtime-required',
  });
}

// Cancelling after projectile launch keeps its later hit tail. Unknown commit
// semantics and explicitly non-cancellable bodies remain natural.
{
  const projectile: ActionTailTimingContract = {
    actionId: 'projectile-skill',
    kind: 'normal-skill',
    naturalEndOffsetFrames: 100,
    effectEndOffsetFrames: 80,
    exclusiveEndOffsetFrames: 60,
    priority: 2,
    interruptibleAtOffsetFrames: [],
    successorWindows: [],
    commitEvents: [{
      id: 'projectile-launch',
      kind: 'projectile-launch',
      commitOffsetFrames: 20,
      effectOffsetFrames: 80,
    }],
    tailCancelable: true,
    commitEvidence: 'verified',
  };
  const transition = resolveActionTailTransition({
    predecessor: projectile,
    successor: { actionId: 'ultimate', kind: 'ultimate-skill', priority: 7 },
    boundary: 'append',
    debounceFrames,
  });
  assert.equal(transition.blockingEndOffsetFrames, 26);
  assert.equal(transition.effectEndOffsetFrames, 80);

  const unverified = resolveActionTailTransition({
    predecessor: { ...projectile, commitEvidence: 'unverified' },
    successor: normalSkillAfterBasic,
    boundary: 'append',
    debounceFrames,
  });
  assert.equal(unverified.status, 'unverified');
  assert.equal(unverified.blockingEndOffsetFrames, 100);

  const locked = resolveActionTailTransition({
    predecessor: { ...projectile, tailCancelable: false },
    successor: normalSkillAfterBasic,
    boundary: 'append',
    debounceFrames,
  });
  assert.equal(locked.status, 'natural');
  assert.equal(locked.reason, 'TAIL_NOT_CANCELABLE');
  assert.equal(locked.blockingEndOffsetFrames, 100);
}

console.log('Combat action tail compression and basic combo cursor: PASS');
