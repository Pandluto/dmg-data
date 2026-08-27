import type { Character, SkillButtonData, TimelineData } from '../../types';
import type {
  AkeCatalog,
  AkeTimingComboTrigger,
  AkeTimingSkillProfile,
} from './akeCatalogAdapter';
import { buildAkeRealtimeTimeline } from './akeRealtimeTimeline';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertClose(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-5) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function profile(overrides: Partial<AkeTimingSkillProfile> = {}): AkeTimingSkillProfile {
  return {
    commandType: 'NormalSkill',
    skillId: 'normal-skill',
    variantIndex: 0,
    durationFrames: 60,
    bodyEndOffset: 59,
    tailEndOffset: 59,
    exclusiveFrames: 30,
    cooldownFrames: 0,
    cooldownGroupId: 'actor-a:NormalSkill',
    cooldownSkillType: 'NormalSkill',
    costType: 'Atb',
    costValue: 100,
    priority: 2,
    allowNext: [{
      startOffsetFrames: 28,
      endOffsetFrames: 54,
      allowedSkillIds: ['normal-skill'],
    }],
    interruptibleAt: [],
    hits: [{
      offsetFrames: 13,
      launchOffsetFrames: null,
      sourceSkillId: 'normal-skill',
      rootSkillId: 'normal-skill',
      kind: 'direct',
      hitCount: 1,
      damageTypes: ['Pulse'],
    }],
    resourceEvents: [],
    recoveryPauses: [],
    derivation: 'isolated-runtime-probe',
    ...overrides,
  };
}

function character(id: string): Character {
  return { id, name: id } as Character;
}

function button(
  id: string,
  characterId: string,
  nodeIndex: number,
  skillType: 'A' | 'B' | 'E' | 'Q' = 'B',
): SkillButtonData {
  return {
    id,
    characterId,
    characterName: characterId,
    skillType,
    staffIndex: 0,
    nodeIndex,
    nodeNumber: nodeIndex + 1,
    position: { x: 0, y: 0 },
  };
}

function timeline(buttonsByCharacter: Array<{ characterId: string; buttons: SkillButtonData[] }>): TimelineData {
  return {
    version: 'test',
    createdAt: 0,
    updatedAt: 0,
    staffLines: buttonsByCharacter.map((entry, staffIndex) => ({
      staffIndex,
      characterName: entry.characterId,
      occupiedNodes: entry.buttons.map(item => item.nodeIndex),
      buttons: entry.buttons.map(item => ({ ...item, staffIndex })),
    })),
  };
}

function catalog(
  profilesByCharacter: Record<string, AkeTimingSkillProfile[]>,
  characterOptions: Record<string, {
    maxUltimateSp?: number;
    initialUltimateSp?: number;
    comboTriggers?: AkeTimingComboTrigger[];
  }> = {},
): AkeCatalog {
  return {
    schemaVersion: 2,
    source: { provider: 'test' },
    characters: [],
    weapons: [],
    equipment: [],
    suits: [],
    timing: {
      schemaVersion: 1,
      tickRate: 30,
      nodeFrameScale: 15,
      source: {
        provider: 'test',
        generator: 'test',
        semantics: 'test',
      },
      sharedAtb: {
        initial: 300,
        max: 300,
        ratePerSecond: 8,
        firstTickFrame: 1,
        resumeDelayFramesAfterSpend: 16,
        quantization: 'float32',
      },
      characters: Object.fromEntries(Object.entries(profilesByCharacter).map(([characterId, profiles]) => [
        characterId,
        {
          characterId,
          maxUltimateSp: characterOptions[characterId]?.maxUltimateSp ?? 100,
          initialUltimateSp: characterOptions[characterId]?.initialUltimateSp,
          comboTriggers: characterOptions[characterId]?.comboTriggers,
          profiles,
        },
      ])),
    },
  };
}

function fourStageAttackProfiles(): AkeTimingSkillProfile[] {
  const makeStage = (
    skillId: string,
    variantIndex: number,
    nextSkillId: string,
    transition: number,
    hitOffset: number,
  ) => profile({
    commandType: 'Attack',
    skillId,
    variantIndex,
    durationFrames: 100,
    bodyEndOffset: 99,
    tailEndOffset: 99,
    exclusiveFrames: transition,
    cooldownFrames: 0,
    costType: null,
    costValue: 0,
    priority: 0,
    allowNext: [{
      startOffsetFrames: transition,
      endOffsetFrames: transition + 5,
      allowedSkillIds: [nextSkillId],
    }],
    commandMappings: [{ commandType: 'Attack', skillId: nextSkillId }],
    hits: [{
      offsetFrames: hitOffset,
      launchOffsetFrames: hitOffset,
      sourceSkillId: `${skillId}-hit`,
      rootSkillId: skillId,
      kind: 'direct',
      hitCount: 1,
      damageTypes: ['Physical'],
    }],
  });
  return [
    makeStage('attack-1', 0, 'attack-2', 10, 3),
    makeStage('attack-2', 1, 'attack-3', 12, 4),
    makeStage('attack-3', 2, 'attack-4', 14, 5),
    makeStage('attack-4', 3, 'attack-1', 20, 6),
  ];
}

{
  const sourceActor = character('anchor-source');
  const followerActor = character('anchor-follower');
  const source = button('anchor-source-skill', sourceActor.id, 0);
  const follower = button('anchor-follower-skill', followerActor.id, 1);
  follower.releaseAnchor = {
    schemaVersion: 1,
    kind: 'damage-hit',
    sourceButtonId: source.id,
    sourceHitId: `${source.id}:preview-hit:0`,
    sourceHitOffsetFrames: 13,
    debounceFrames: 6,
  };
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([
      { characterId: sourceActor.id, buttons: [source] },
      { characterId: followerActor.id, buttons: [follower] },
    ]),
    selectedCharacters: [sourceActor, followerActor],
    catalog: catalog({
      [sourceActor.id]: [profile({ skillId: 'anchor-source-profile' })],
      [followerActor.id]: [profile({ skillId: 'anchor-follower-profile' })],
    }),
    staffCount: 1,
  });
  const followerCommand = result.commands.find(command => command.commandId === follower.id)!;
  assertEqual(followerCommand.requestedFrame, 19, 'damage anchor starts after hit plus the 0.2-second buffer');
  assertEqual(followerCommand.actualFrame, 19, 'a free teammate releases directly at the anchored frame');
  assertEqual(
    result.sharedVariableRateTimeline?.actions.find(action => action.id === follower.id)?.startFrame,
    19,
    'the shared variable-rate planner uses the persisted release dependency',
  );
}

{
  const actor = character('anchor-invalid');
  const dangling = button('dangling-anchor', actor.id, 0);
  dangling.releaseAnchor = {
    schemaVersion: 1,
    kind: 'action-end',
    sourceButtonId: 'missing-source',
    debounceFrames: 0,
  };
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [dangling] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [profile()] }),
    staffCount: 1,
  });
  assertEqual(
    result.sharedVariableRateTimeline?.admissionStatus,
    'invalid',
    'a dangling release dependency cannot silently become an executable fallback',
  );
  assertEqual(
    result.diagnostics.some(message => message.includes('DANGLING_SOURCE')),
    true,
    'release graph diagnostics explain the rejected relationship',
  );
}

{
  const actor = character('fixed-wait-actor');
  const first = button('fixed-wait-first', actor.id, 0);
  first.releaseAnchor = { schemaVersion: 1, kind: 'group-start', debounceFrames: 0 };
  const wait = button('fixed-wait-column', actor.id, 14, 'A');
  wait.skillType = 'Dot';
  wait.timelineModuleKind = 'forced-wait';
  wait.releaseAnchor = { schemaVersion: 1, kind: 'group-start', debounceFrames: 0 };
  wait.forcedWaitConfig = {
    schemaVersion: 1,
    mode: 'fixed-duration',
    durationSeconds: 2,
  };
  const second = button('fixed-wait-second', actor.id, 15);
  second.releaseAnchor = { schemaVersion: 1, kind: 'group-start', debounceFrames: 0 };
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [first, wait, second] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [profile()] }),
    staffCount: 2,
  });
  const model = result.sharedVariableRateTimeline!;
  const waitColumn = model.waits.find(column => column.waitId === `forced-wait:${wait.id}`)!;
  const firstAction = model.actions.find(action => action.id === first.id)!;
  const secondAction = model.actions.find(action => action.id === second.id)!;
  const firstCommand = result.commands.find(command => command.commandId === first.id)!;
  const secondCommand = result.commands.find(command => command.commandId === second.id)!;
  assertEqual(result.commands.some(command => command.commandId === wait.id), false, 'forced wait never compiles as a combat command');
  assertEqual(waitColumn.durationFrames, 60, 'two seconds become sixty authoritative runtime frames');
  assertEqual(secondAction.startFrame - firstAction.endFrame, 60, 'fixed wait delays only the following release group');
  assertEqual(secondCommand.requestedFrame, secondAction.startFrame, 'runtime request uses the delayed shared plan');
  assertEqual(
    Number(secondCommand.atbBefore) > Number(firstCommand.atbAfter),
    true,
    'shared ATB recovers naturally while the fixed wait advances runtime frames',
  );
  assertEqual(
    result.diagnostics.some(message => message.includes('TIMELINE_MODULE_RUNTIME_REQUIRED: forced-wait')),
    false,
    'verified fixed waits do not poison the plan as an unresolved fake skill',
  );
}

{
  const actorA = character('lane-wait-actor-a');
  const actorB = character('lane-wait-actor-b');
  const running = button('lane-wait-running', actorA.id, 0);
  running.releaseAnchor = { schemaVersion: 1, kind: 'group-start', debounceFrames: 0 };
  const wait = button('lane-wait-node', actorB.id, 0, 'A');
  wait.skillType = 'Dot';
  wait.timelineModuleKind = 'lane-wait';
  wait.releaseAnchor = { schemaVersion: 1, kind: 'group-start', debounceFrames: 0 };
  wait.laneWaitConfig = {
    schemaVersion: 1,
    mode: 'fixed-duration',
    durationSeconds: 2,
  };
  const follower = button('lane-wait-follower', actorB.id, 1);
  follower.releaseAnchor = {
    schemaVersion: 1,
    kind: 'action-end',
    sourceButtonId: wait.id,
    debounceFrames: 0,
  };
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([
      { characterId: actorA.id, buttons: [running] },
      { characterId: actorB.id, buttons: [wait, follower] },
    ]),
    selectedCharacters: [actorA, actorB],
    catalog: catalog({
      [actorA.id]: [profile()],
      [actorB.id]: [profile()],
    }),
    staffCount: 1,
  });
  const model = result.sharedVariableRateTimeline!;
  assertEqual(model.groups.length, 1, 'ordinary wait keeps both lanes in the same release group');
  assertEqual(model.waits.length, 0, 'ordinary wait does not create a full-column separator');
  assertEqual(model.laneWaits.length, 1, 'ordinary wait is represented as a lane-local node');
  assertEqual(model.laneWaits[0].durationFrames, 60, 'ordinary wait uses authoritative runtime frames');
  assertEqual(
    model.actions.find(action => action.id === running.id)?.startFrame,
    0,
    'another lane remains aligned to the group start',
  );
  assertEqual(
    model.actions.find(action => action.id === follower.id)?.startFrame,
    60,
    'only the ordinary wait successor is delayed',
  );
  assertEqual(
    result.diagnostics.some(message => message.includes('DANGLING_SOURCE')),
    false,
    'ordinary wait is a valid release-graph source',
  );
}

{
  const actor = character('actor-a');
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{
      characterId: actor.id,
      buttons: [button('first', actor.id, 0), button('second', actor.id, 1)],
    }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [profile()] }),
    staffCount: 1,
  });
  const first = result.commands.find(command => command.commandId === 'first')!;
  const second = result.commands.find(command => command.commandId === 'second')!;
  assertEqual(second.requestedFrame, 28, 'second input starts at the verified successor window');
  assertEqual(second.actualFrame, 28, 'tail compression is represented as a real interrupt, not queueing');
  assertEqual(second.queued, false, 'tail-chain adjacency is not represented as queueing');
  assertEqual(first.endFrame, 28, 'the first action drops its cancellable animation recovery');
  assertEqual(first.tailEndFrame, 28, 'the interrupted body closes after its already-settled hit');
  assertEqual(first.completion, 'interrupted', 'ordinary adjacency compresses verified recovery');
  assertEqual(
    result.sharedVariableRateTimeline?.actions.find(action => action.id === 'second')?.startFrame,
    28,
    'shared variable-rate plan is exposed to the canvas',
  );
}

{
  const actorA = character('switch-source');
  const actorB = character('switch-target');
  const source = button('switch-source-skill', actorA.id, 0, 'B');
  source.releaseAnchor = { schemaVersion: 1, kind: 'group-start', debounceFrames: 0 };
  const operatorSwitch = button('switch-control-node', actorA.id, 1, 'A');
  operatorSwitch.skillType = 'Dot';
  operatorSwitch.timelineModuleKind = 'operator-switch';
  operatorSwitch.operatorSwitchConfig = { schemaVersion: 1, targetCharacterId: actorB.id };
  operatorSwitch.releaseAnchor = {
    schemaVersion: 1,
    kind: 'damage-hit',
    sourceButtonId: source.id,
    sourceHitOffsetFrames: 13,
    debounceFrames: 6,
  };
  const targetAttack = button('attack-after-switch', actorB.id, 2, 'A');
  targetAttack.releaseAnchor = {
    schemaVersion: 1,
    kind: 'action-end',
    sourceButtonId: operatorSwitch.id,
    debounceFrames: 0,
  };
  const attackProfile = profile({
    commandType: 'Attack',
    skillId: 'switch-target-attack',
    costType: null,
    costValue: 0,
    allowNext: [],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([
      { characterId: actorA.id, buttons: [source, operatorSwitch] },
      { characterId: actorB.id, buttons: [targetAttack] },
    ]),
    selectedCharacters: [actorA, actorB],
    catalog: catalog({
      [actorA.id]: [profile()],
      [actorB.id]: [attackProfile],
    }),
    staffCount: 1,
  });
  const model = result.sharedVariableRateTimeline!;
  const scheduledSwitch = model.operatorSwitches.find(entry => entry.id === operatorSwitch.id)!;
  const scheduledAttack = model.actions.find(entry => entry.id === targetAttack.id)!;
  assertEqual(scheduledSwitch.startFrame, 19, 'switch starts at hit plus the 0.2-second buffer');
  assertEqual(scheduledAttack.startFrame, 19, 'the new controller may act in the same real frame');
  assertEqual(scheduledAttack.startX, scheduledSwitch.endX, 'the new action is visually after the zero-time switch cell');
  assertEqual(
    result.commands.find(command => command.commandId === source.id)?.endFrame,
    19,
    'switching forcibly closes a non-ultimate predecessor',
  );
  assertEqual(model.admissionStatus, 'valid', 'a correctly owned handoff remains executable');
}

{
  const actorA = character('initial-controller-a');
  const actorB = character('initial-controller-b');
  const initialAttack = button('initial-controller-b-attack', actorB.id, 0, 'A');
  const timelineData = timeline([
    { characterId: actorA.id, buttons: [] },
    { characterId: actorB.id, buttons: [initialAttack] },
  ]);
  timelineData.initialControllerCharacterId = actorB.id;
  const result = buildAkeRealtimeTimeline({
    timelineData,
    selectedCharacters: [actorA, actorB],
    catalog: catalog({
      [actorA.id]: [],
      [actorB.id]: [profile({
        commandType: 'Attack',
        skillId: 'initial-controller-b-attack-profile',
        costType: null,
        costValue: 0,
      })],
    }),
    staffCount: 1,
  });
  assertEqual(
    result.sharedVariableRateTimeline?.admissionStatus,
    'valid',
    'the persisted initial controller, not squad order, owns the frame-zero basic attack',
  );
}

{
  const actor = character('ultimate-lock-actor');
  const ultimateButton = button('locked-ultimate', actor.id, 0, 'Q');
  const follower = button('skill-after-ultimate', actor.id, 1, 'B');
  const ultimateProfile = profile({
    commandType: 'UltimateSkill',
    skillId: 'locked-ultimate-profile',
    durationFrames: 91,
    bodyEndOffset: 90,
    tailEndOffset: 90,
    exclusiveFrames: 10,
    priority: 10,
    costType: null,
    costValue: 0,
    allowNext: [{
      startOffsetFrames: 15,
      endOffsetFrames: 40,
      allowedSkillIds: ['normal-skill'],
    }],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [ultimateButton, follower] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [ultimateProfile, profile()] }),
    staffCount: 1,
  });
  const ultimateCommand = result.commands.find(command => command.commandId === ultimateButton.id)!;
  const followerCommand = result.commands.find(command => command.commandId === follower.id)!;
  assertEqual(followerCommand.requestedFrame, 90, 'ultimate successor waits for the full natural animation');
  assertEqual(followerCommand.actualFrame, 90, 'runtime also admits the successor only at natural end');
  assertEqual(ultimateCommand.endFrame, 90, 'ultimate body is never tail-compressed');
  assertEqual(ultimateCommand.completion, 'completed', 'ultimate is not marked interrupted');
}

{
  const actor = character('actor-greedy');
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{
      characterId: actor.id,
      buttons: [
        button('greedy-1', actor.id, 0),
        button('greedy-2', actor.id, 1),
        button('greedy-3', actor.id, 2),
      ],
    }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [profile()] }),
    staffCount: 1,
  });
  assertEqual(result.commands[0].actualFrame, 0, 'first shared-resource skill executes immediately');
  assertEqual(result.commands[1].actualFrame, 28, 'second shared-resource skill follows the compressed lane tail');
  assertEqual(result.commands[2].actualFrame, 56, 'third skill follows the second verified successor window');
  assertEqual(result.commands[2].success, true, 'one operator may consume the remaining shared pool');
}

{
  const actor = character('actor-sealed-tail');
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{
      characterId: actor.id,
      buttons: [button('sealed-skill', actor.id, 0)],
    }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [profile({
      durationFrames: 155,
      bodyEndOffset: 154,
      tailEndOffset: 154,
    })] }),
    staffCount: 1,
  });
  const command = result.commands[0];
  assertEqual(command.naturalEndFrame, 154, 'seal keeps the natural animation end as evidence');
  assertEqual(command.endFrame, 28, 'a group seal closes verified cancellable recovery');
  assertEqual(command.completion, 'interrupted', 'group-seal compression is applied to runtime state');
}

{
  const actor = character('actor-projectile-tail');
  const projectileSkill = profile({
    skillId: 'projectile-skill',
    durationFrames: 101,
    bodyEndOffset: 100,
    tailEndOffset: 100,
    exclusiveFrames: 60,
    costType: null,
    costValue: 0,
    allowNext: [],
    hits: [{
      offsetFrames: 80,
      launchOffsetFrames: 20,
      sourceSkillId: 'projectile-impact',
      rootSkillId: 'projectile-skill',
      kind: 'projectile',
      hitCount: 1,
      damageTypes: ['Fire'],
    }],
  });
  const ultimate = profile({
    commandType: 'UltimateSkill',
    skillId: 'ultimate-skill',
    durationFrames: 31,
    bodyEndOffset: 30,
    tailEndOffset: 30,
    exclusiveFrames: 30,
    costType: null,
    costValue: 0,
    priority: 7,
    allowNext: [],
    hits: [],
    resourceEvents: [{
      offsetFrames: 1,
      resourceType: 'UltimateSp',
      scope: 'Entity',
      target: 'self',
      gainMethod: 'Gain',
      amount: 1,
    }],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{
      characterId: actor.id,
      buttons: [
        button('projectile', actor.id, 0, 'B'),
        button('ultimate', actor.id, 1, 'Q'),
      ],
    }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [projectileSkill, ultimate] }),
    staffCount: 1,
  });
  const projectile = result.commands.find(command => command.commandId === 'projectile')!;
  assertEqual(projectile.endFrame, 26, 'successor starts six frames after projectile launch');
  assertEqual(projectile.tailEndFrame, 80, 'a launched projectile outlives cancelled animation recovery');
  assertEqual(
    result.hits.some(hit => hit.commandId === 'projectile' && hit.frame === 80),
    true,
    'later projectile impact remains on the shared timeline',
  );
}

{
  const actor = character('actor-sword-controller');
  const zhuangLikeProfile = profile({
    skillId: 'sword-control-skill',
    durationFrames: 290,
    bodyEndOffset: 190,
    tailEndOffset: 190,
    exclusiveFrames: 135,
    allowNext: [{
      startOffsetFrames: 45,
      endOffsetFrames: 116,
      allowedSkillIds: ['sword-control-skill'],
    }],
    hits: [{
      offsetFrames: 28,
      launchOffsetFrames: null,
      sourceSkillId: 'sword-control-skill-gene-sword',
      rootSkillId: 'sword-control-skill',
      kind: 'direct',
      hitCount: 1,
      damageTypes: ['Pulse'],
    }],
    resourceEvents: [{
      offsetFrames: 6,
      resourceType: 'UltimateSp',
      scope: 'Entity',
      target: 'team',
      gainMethod: 'Gain',
      amount: 6.5,
    }],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{
      characterId: actor.id,
      buttons: [button('sword-1', actor.id, 0), button('sword-2', actor.id, 1)],
    }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [zhuangLikeProfile] }),
    staffCount: 1,
  });
  assertEqual(
    result.commands.find(command => command.commandId === 'sword-2')?.actualFrame,
    45,
    'a sword-chain skill uses its verified successor window after its settlement point',
  );
  assertEqual(
    result.sharedVariableRateTimeline?.actions.find(action => action.id === 'sword-1')?.durationFrames,
    45,
    'the 190-frame animation probe is not treated as mandatory blocking time',
  );
  assertEqual(
    result.hits.some(hit => hit.commandId === 'sword-1' && hit.frame === 28),
    true,
    'the sword Buff-chain settlement remains visible before the compressed recovery boundary',
  );
}

{
  const actor = character('actor-grouped');
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{
      characterId: actor.id,
      buttons: [button('group-1', actor.id, 0), button('group-2', actor.id, 14)],
    }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [profile({
      bodyEndOffset: 30,
      tailEndOffset: 30,
      costType: null,
      costValue: 0,
      allowNext: [],
    })] }),
    staffCount: 2,
  });
  const plan = result.sharedVariableRateTimeline!;
  assertEqual(plan.groups.length, 2, 'legacy visual groups migrate to explicit release groups');
  assertEqual(plan.waits.length, 1, 'a full zero-time seal separates adjacent groups');
  assertEqual(plan.waits[0].durationFrames, 0, 'legacy group separator does not invent combat time');
  assertEqual(
    result.commands.find(command => command.commandId === 'group-2')?.requestedFrame,
    30,
    'the second release group begins after the first group waterline',
  );
}

{
  const actor = character('actor-combo');
  const attackStage = (
    skillId: string,
    variantIndex: number,
    nextSkillId: string,
    transition: number,
    hitOffset: number,
    gain = 0,
  ) => profile({
    commandType: 'Attack',
    skillId,
    variantIndex,
    durationFrames: 100,
    bodyEndOffset: 99,
    tailEndOffset: 99,
    exclusiveFrames: transition,
    cooldownFrames: 0,
    costType: null,
    costValue: 0,
    priority: 0,
    allowNext: [{
      startOffsetFrames: transition,
      endOffsetFrames: transition + 5,
      allowedSkillIds: [nextSkillId],
    }],
    commandMappings: [{ commandType: 'Attack', skillId: nextSkillId }],
    hits: [{
      offsetFrames: hitOffset,
      launchOffsetFrames: hitOffset,
      sourceSkillId: `${skillId}-hit`,
      rootSkillId: skillId,
      kind: 'direct',
      hitCount: 1,
      damageTypes: ['Physical'],
    }],
    resourceEvents: gain > 0 ? [{
      offsetFrames: hitOffset,
      resourceType: 'Atb',
      scope: 'Shared',
      target: 'shared',
      gainMethod: 'Gain',
      amount: gain,
      reason: 'ObtainCostAction',
    }] : [],
  });
  const attackProfiles = [
    attackStage('attack-1', 0, 'attack-2', 10, 3),
    attackStage('attack-2', 1, 'attack-3', 12, 4),
    attackStage('attack-3', 2, 'attack-4', 14, 5),
    attackStage('attack-4', 3, 'attack-1', 20, 6, 15),
  ];
  const attackCatalog = catalog({ [actor.id]: attackProfiles });
  attackCatalog.timing!.sharedAtb.initial = 0;
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{
      characterId: actor.id,
      buttons: [button('full-attack', actor.id, 0, 'A')],
    }]),
    selectedCharacters: [actor],
    catalog: attackCatalog,
    staffCount: 1,
  });
  const command = result.commands[0];
  assertEqual(command.profile.comboStageSkillIds?.length, 4, 'A intent expands to all attack stages');
  assertEqual(command.hits.length, 4, 'the combo exposes one settlement marker per attack stage');
  assertEqual(command.naturalEndFrame, 56, 'combo body ends at the final heavy reset window');
  assertEqual(
    result.sharedAtb.points.some(point => point.commandId === 'full-attack' && point.frame === 42),
    true,
    'final heavy hit restores shared skill points at its actual settlement frame',
  );
}

{
  const actor = character('actor-consecutive-full-attacks');
  const first = button('full-attack-1', actor.id, 0, 'A');
  first.basicAttackStageCount = 4;
  const second = button('full-attack-2', actor.id, 1, 'A');
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [first, second] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: fourStageAttackProfiles() }),
    staffCount: 1,
  });
  const firstCommand = result.commands.find(command => command.commandId === first.id)!;
  const secondCommand = result.commands.find(command => command.commandId === second.id)!;
  assertEqual(firstCommand.naturalEndFrame, 56, 'first full A keeps its native restart boundary');
  assertEqual(secondCommand.requestedFrame, 56, 'planner places the second full A at that boundary');
  assertEqual(secondCommand.actualFrame, 56, 'preview admits the second full A without a red invalid gap');
  assertEqual(secondCommand.releaseVerdict, 'valid', 'consecutive complete normal attacks are legal');
}

{
  const actor = character('actor-combo-resume');
  const cutAttack = button('cut-attack', actor.id, 0, 'A');
  cutAttack.basicAttackStageCount = 2;
  const normal = profile({
    skillId: 'bridge-skill',
    durationFrames: 31,
    bodyEndOffset: 30,
    tailEndOffset: 30,
    exclusiveFrames: 10,
    costType: null,
    costValue: 0,
    allowNext: [],
    hits: [{
      offsetFrames: 3,
      launchOffsetFrames: null,
      sourceSkillId: 'bridge-skill',
      rootSkillId: 'bridge-skill',
      kind: 'direct',
      hitCount: 1,
      damageTypes: ['Pulse'],
    }],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{
      characterId: actor.id,
      buttons: [
        cutAttack,
        button('bridge', actor.id, 1, 'B'),
        button('resume-attack', actor.id, 2, 'A'),
      ],
    }]),
    selectedCharacters: [actor],
    catalog: catalog({
      [actor.id]: [...fourStageAttackProfiles(), normal],
    }),
    staffCount: 1,
  });
  const first = result.commands.find(command => command.commandId === 'cut-attack')!;
  const bridge = result.commands.find(command => command.commandId === 'bridge')!;
  const resumed = result.commands.find(command => command.commandId === 'resume-attack')!;
  assertEqual(bridge.actualFrame, 20, 'skill starts after the selected second basic stage plus debounce');
  assertEqual(first.hits.length, 2, 'future basic stages are pruned from the interrupted segment');
  assertEqual(resumed.profile.comboStageSkillIds?.join(','), 'attack-3,attack-4', 'skill preserves the unfinished combo cursor');
  assertEqual(resumed.hits.length, 2, 'the next A button renders only the unfinished stages');
}

{
  const actor = character('actor-combo-ultimate-reset');
  const cutAttack = button('cut-before-ultimate', actor.id, 0, 'A');
  cutAttack.basicAttackStageCount = 2;
  const ultimate = profile({
    commandType: 'UltimateSkill',
    skillId: 'combo-reset-ultimate',
    durationFrames: 11,
    bodyEndOffset: 10,
    tailEndOffset: 10,
    exclusiveFrames: 10,
    costType: null,
    costValue: 0,
    priority: 7,
    allowNext: [],
    hits: [],
    resourceEvents: [{
      offsetFrames: 1,
      resourceType: 'UltimateSp',
      scope: 'Entity',
      target: 'self',
      gainMethod: 'Gain',
      amount: 1,
    }],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{
      characterId: actor.id,
      buttons: [
        cutAttack,
        button('reset-ultimate', actor.id, 1, 'Q'),
        button('attack-after-ultimate', actor.id, 2, 'A'),
      ],
    }]),
    selectedCharacters: [actor],
    catalog: catalog({
      [actor.id]: [...fourStageAttackProfiles(), ultimate],
    }),
    staffCount: 1,
  });
  const afterUltimate = result.commands.find(command => (
    command.commandId === 'attack-after-ultimate'
  ))!;
  assertEqual(
    afterUltimate.profile.comboStageSkillIds?.join(','),
    'attack-1,attack-2,attack-3,attack-4',
    'ultimate resets the unfinished basic combo cursor',
  );
}

{
  const actorA = character('actor-a');
  const actorB = character('actor-b');
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([
      { characterId: actorA.id, buttons: [button('a', actorA.id, 0)] },
      { characterId: actorB.id, buttons: [button('b', actorB.id, 0)] },
    ]),
    selectedCharacters: [actorA, actorB],
    catalog: catalog({
      [actorA.id]: [profile({ skillId: 'a-skill', allowNext: [] })],
      [actorB.id]: [profile({ skillId: 'b-skill', allowNext: [] })],
    }),
    staffCount: 1,
  });
  assertEqual(result.commands.find(command => command.commandId === 'a')?.atbAfter, 200, 'first same-frame spend');
  assertEqual(result.commands.find(command => command.commandId === 'b')?.atbAfter, 100, 'second same-frame spend');
}

{
  const actorA = character('cohort-a');
  const actorB = character('cohort-b');
  const limitedCatalog = catalog({
    [actorA.id]: [profile({ skillId: 'cohort-a-skill', allowNext: [] })],
    [actorB.id]: [profile({ skillId: 'cohort-b-skill', allowNext: [] })],
  });
  limitedCatalog.timing!.sharedAtb.initial = 150;
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([
      { characterId: actorA.id, buttons: [button('cohort-a', actorA.id, 0)] },
      { characterId: actorB.id, buttons: [button('cohort-b', actorB.id, 0)] },
    ]),
    selectedCharacters: [actorA, actorB],
    catalog: limitedCatalog,
    staffCount: 1,
  });
  assertEqual(result.sharedVariableRateTimeline?.cohorts[0].requiredSharedAtb, 200, 'same-frame costs are aggregated');
  assertEqual(result.sharedVariableRateTimeline?.cohorts[0].status, 'invalid', 'one failed member invalidates the cohort');
  assertEqual(result.sharedVariableRateTimeline?.isExecutable, false, 'an invalid cohort rejects the whole axis');
}

{
  const actor = character('actor-a');
  const attack = profile({
    commandType: 'Attack',
    skillId: 'attack',
    costType: null,
    costValue: 0,
    priority: 0,
    bodyEndOffset: 30,
    tailEndOffset: 40,
    allowNext: [],
    hits: [
      {
        offsetFrames: 20,
        launchOffsetFrames: 5,
        sourceSkillId: 'projectile-hit',
        rootSkillId: 'attack',
        kind: 'projectile',
        hitCount: 1,
        damageTypes: ['Fire'],
      },
      {
        offsetFrames: 40,
        launchOffsetFrames: null,
        sourceSkillId: 'burn',
        rootSkillId: 'attack',
        kind: 'lingering',
        hitCount: 1,
        damageTypes: ['Fire'],
      },
    ],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [button('attack', actor.id, 2, 'A')] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [attack] }),
    staffCount: 1,
  });
  assertEqual(result.hits[0].launchFrame, 5, 'a first lane action starts at its group origin');
  assertEqual(result.hits[0].frame, 20, 'node gaps no longer invent combat time');
  assertEqual(result.hits[1].frame, 40, 'lingering hit extends past the body');
  assertEqual(result.commands[0].tailEndFrame, 40, 'clip exposes its lingering tail end');
}

{
  const actor = character('lingering-anchor-actor');
  const source = button('long-dot-source', actor.id, 0, 'B');
  source.runtimeSkillId = 'long-dot-source-skill';
  const follower = button('long-dot-follower', actor.id, 1, 'B');
  follower.runtimeSkillId = 'long-dot-follower-skill';
  follower.releaseAnchor = {
    schemaVersion: 1,
    kind: 'damage-hit',
    sourceButtonId: source.id,
    sourceHitId: `${source.id}:preview-hit:1`,
    sourceHitOffsetFrames: 810,
    debounceFrames: 6,
  };
  const sourceProfile = profile({
    commandType: 'NormalSkill',
    skillId: source.runtimeSkillId,
    bodyEndOffset: 90,
    tailEndOffset: 810,
    exclusiveFrames: 90,
    costType: null,
    costValue: 0,
    allowNext: [],
    hits: [{
      offsetFrames: 80,
      launchOffsetFrames: null,
      sourceSkillId: 'long-dot-source-skill',
      rootSkillId: 'long-dot-source-skill',
      kind: 'direct',
      hitCount: 1,
      damageTypes: ['Physical'],
    }, {
      offsetFrames: 810,
      launchOffsetFrames: null,
      sourceSkillId: 'long-dot-status-tick',
      rootSkillId: 'long-dot-source-skill',
      kind: 'lingering',
      hitCount: 1,
      damageTypes: ['Physical'],
    }],
  });
  const followerProfile = profile({
    commandType: 'NormalSkill',
    skillId: follower.runtimeSkillId,
    bodyEndOffset: 30,
    tailEndOffset: 30,
    exclusiveFrames: 30,
    costType: null,
    costValue: 0,
    allowNext: [],
    hits: [],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [source, follower] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [sourceProfile, followerProfile] }),
    staffCount: 1,
  });
  const followerCommand = result.commands.find(command => command.commandId === follower.id)!;
  assertEqual(
    followerCommand.actualFrame,
    90,
    'a persisted lingering-hit anchor is repaired to the source action end',
  );
  assertEqual(
    result.diagnostics.some(diagnostic => diagnostic.startsWith('RELEASE_ANCHOR_REPAIRED:')),
    true,
    'the transient legacy-anchor repair remains auditable',
  );
}

{
  const actorA = character('actor-a');
  const actorB = character('actor-b');
  const normal = profile({
    resourceEvents: [{
      offsetFrames: 13,
      resourceType: 'UltimateSp',
      scope: 'Entity',
      target: 'team',
      gainMethod: 'Gain',
      amount: Math.fround(6.5),
      reason: 'ObtainUspInNormalSkill',
    }],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([
      { characterId: actorA.id, buttons: [button('normal', actorA.id, 0)] },
      { characterId: actorB.id, buttons: [] },
    ]),
    selectedCharacters: [actorA, actorB],
    catalog: catalog({
      [actorA.id]: [normal],
      [actorB.id]: [],
    }, {
      [actorA.id]: { initialUltimateSp: 0 },
      [actorB.id]: { initialUltimateSp: 0 },
    }),
    staffCount: 1,
  });
  assertClose(result.ultimateSpPools[0].final, Math.fround(6.5), 'normal skill charges its owner');
  assertClose(result.ultimateSpPools[1].final, Math.fround(6.5), 'normal skill charges every squad member');
  assertEqual(result.ultimateSpPools[0].points.at(-1)?.frame, 13, 'team energy gain uses compiled hit frame');
}

{
  const actorA = character('actor-a');
  const actorB = character('actor-b');
  const returnSkill = profile({
    skillId: 'return-skill',
    bodyEndOffset: 1,
    tailEndOffset: 1,
    resourceEvents: [{
      offsetFrames: 0,
      resourceType: 'Atb',
      scope: 'Shared',
      target: 'shared',
      gainMethod: 'Return',
      amount: 30,
      reason: 'ObtainCostAction',
    }],
  });
  const chargeSkill = profile({
    skillId: 'charge-skill',
    bodyEndOffset: 1,
    tailEndOffset: 1,
    resourceEvents: [{
      offsetFrames: 0,
      resourceType: 'UltimateSp',
      scope: 'Entity',
      target: 'team',
      gainMethod: 'Gain',
      amount: Math.fround(6.5),
      reason: 'ObtainUspInNormalSkill',
    }],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([
      { characterId: actorA.id, buttons: [button('return', actorA.id, 0)] },
      { characterId: actorB.id, buttons: [button('charge', actorB.id, 0)] },
    ]),
    selectedCharacters: [actorA, actorB],
    catalog: catalog({
      [actorA.id]: [returnSkill],
      [actorB.id]: [chargeSkill],
    }, {
      [actorA.id]: { initialUltimateSp: 0 },
      [actorB.id]: { initialUltimateSp: 0 },
    }),
    staffCount: 1,
  });
  const charge = result.commands.find(command => command.commandId === 'charge')!;
  assertClose(charge.atbEligibilityRatio, 0.7, 'returned ATB is spent before ordinary ATB');
  assertClose(
    result.ultimateSpPools[0].final,
    Math.fround(Math.fround(6.5) * 0.7),
    'returned ATB does not contribute to normal-skill team energy',
  );
}

{
  const actorA = character('actor-a');
  const actorB = character('actor-b');
  const ultimate = profile({
    commandType: 'UltimateSkill',
    skillId: 'ultimate',
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    cooldownFrames: 0,
    costType: 'UltimateSp',
    costValue: 80,
    allowNext: [],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([
      { characterId: actorA.id, buttons: [
        button('ultimate-1', actorA.id, 0, 'Q'),
        button('ultimate-2', actorA.id, 1, 'Q'),
      ] },
      { characterId: actorB.id, buttons: [] },
    ]),
    selectedCharacters: [actorA, actorB],
    catalog: catalog({
      [actorA.id]: [ultimate],
      [actorB.id]: [],
    }, {
      [actorA.id]: { maxUltimateSp: 80, initialUltimateSp: 80 },
      [actorB.id]: { maxUltimateSp: 80, initialUltimateSp: 80 },
    }),
    staffCount: 1,
  });
  const first = result.commands.find(command => command.commandId === 'ultimate-1')!;
  const second = result.commands.find(command => command.commandId === 'ultimate-2')!;
  assertEqual(first.ultimateSpAfter, 0, 'ultimate spends only the caster energy');
  assertEqual(result.ultimateSpPools[1].final, 80, 'other operator energy remains isolated');
  assertEqual(second.success, false, 'second ultimate is rejected without energy');
  assertEqual(second.releaseReason, 'INSUFFICIENT_ULTIMATE_SP', 'energy failure is explicit');
}

{
  const actor = character('actor-a');
  const cooldownSkill = profile({
    skillId: 'cooldown-skill',
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    cooldownFrames: 60,
    costType: null,
    costValue: 0,
    allowNext: [],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [
      button('cooldown-1', actor.id, 0),
      button('cooldown-2', actor.id, 1),
    ] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [cooldownSkill] }),
    staffCount: 1,
  });
  const second = result.commands.find(command => command.commandId === 'cooldown-2')!;
  assertEqual(second.success, false, 'skill cannot be recast during cooldown');
  assertEqual(second.releaseReason, 'COOLDOWN_ACTIVE', 'cooldown rejection is explicit');
  assertEqual(second.cooldownEndFrame, 60, 'cooldown end frame is exposed');
}

{
  const actor = character('actor-a');
  const sharedGroup = 'actor-a:NormalSkill';
  const baseSkill = profile({
    skillId: 'normal-skill-base',
    variantIndex: 0,
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    cooldownFrames: 60,
    cooldownGroupId: sharedGroup,
    formEvents: [{
      offsetFrames: 0,
      operation: 'apply',
      kind: 'override',
      stateKey: 'enhanced-form',
      skillSlot: 'NormalSkill',
      targetSkillId: 'normal-skill-enhanced',
    }],
    costType: null,
    costValue: 0,
    allowNext: [],
  });
  const enhancedSkill = profile({
    skillId: 'normal-skill-enhanced',
    variantIndex: 1,
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    cooldownFrames: 60,
    cooldownGroupId: sharedGroup,
    costType: null,
    costValue: 0,
    allowNext: [],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [
      button('base-cast', actor.id, 0),
      button('enhanced-cast', actor.id, 1),
    ] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [baseSkill, enhancedSkill] }),
    staffCount: 1,
  });
  const second = result.commands.find(command => command.commandId === 'enhanced-cast')!;
  assertEqual(second.profile.skillId, 'normal-skill-enhanced', 'form resolver selects the alternate SkillData');
  assertEqual(second.success, false, 'alternate form cannot bypass the base form cooldown');
  assertEqual(second.releaseReason, 'COOLDOWN_ACTIVE', 'shared group rejection is explicit');
  assertEqual(second.cooldownEndFrame, 60, 'alternate form exposes the shared cooldown end');
}

{
  const actor = character('actor-action-combo');
  const sharedGroup = `${actor.id}:ComboSkill`;
  const combo2 = profile({
    commandType: 'ComboSkill',
    skillId: 'combo-2',
    variantIndex: 0,
    durationFrames: 2,
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    cooldownFrames: 60,
    cooldownGroupId: sharedGroup,
    cooldownSkillType: 'ComboSkill',
    costType: null,
    costValue: 0,
    allowNext: [],
    formEvents: [{
      offsetFrames: 0,
      operation: 'apply',
      kind: 'override',
      stateKey: 'combo-stage-3',
      skillSlot: 'ComboSkill',
      targetSkillId: 'combo-3',
    }],
    comboPendingEvents: [{
      offsetFrames: 0,
      operation: 'trigger',
      ruleId: 'fixture:trigger-combo-stage',
      ownerCharacterId: actor.id,
      triggerTargetId: 'fixed-dummy',
      skillSlot: 'ComboSkill',
      targetSkillId: 'combo-3',
      pendingDurationFrames: 180,
      requireComboOffCooldown: false,
      bypassSkillCooldown: true,
      pendingPolicy: 'replace-all',
      selectionPolicy: 'newest',
      consumePolicy: 'selected',
      sourceActionType: 'TriggerComboSkillAction',
      sourceActionPath: 'fixture.combo2.trigger',
      precisionWindow: {
        startAfterTriggerFrames: 1,
        endAfterTriggerFramesExclusive: 3,
        activeDurationFrames: 2,
        boundary: 'start-inclusive-end-exclusive',
        sourceActionType: 'ShowComboRingQte',
        sourceBuffId: 'fixture-qte-listener',
      },
    }],
    hits: [],
  });
  const combo3 = profile({
    commandType: 'ComboSkill',
    skillId: 'combo-3',
    variantIndex: 1,
    durationFrames: 2,
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    cooldownFrames: 0,
    cooldownGroupId: sharedGroup,
    cooldownSkillType: 'ComboSkill',
    costType: null,
    costValue: 0,
    allowNext: [],
    hits: [],
  });
  const firstButton = button('combo-stage-2', actor.id, 0, 'E');
  firstButton.releaseAnchor = { schemaVersion: 1, kind: 'group-start', debounceFrames: 0 };
  const secondButton = button('combo-stage-3', actor.id, 1, 'E');
  secondButton.releaseAnchor = {
    schemaVersion: 1,
    kind: 'action-end',
    sourceButtonId: firstButton.id,
    debounceFrames: 0,
  };
  const repeatedButton = button('combo-stage-3-repeat', actor.id, 2, 'E');
  repeatedButton.releaseAnchor = {
    schemaVersion: 1,
    kind: 'action-end',
    sourceButtonId: secondButton.id,
    debounceFrames: 0,
  };
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [
      firstButton,
      secondButton,
      repeatedButton,
    ] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [combo2, combo3] }),
    staffCount: 1,
  });
  const first = result.commands.find(command => command.commandId === firstButton.id)!;
  const second = result.commands.find(command => command.commandId === secondButton.id)!;
  const repeated = result.commands.find(command => command.commandId === repeatedButton.id)!;
  const chainedWindow = result.comboWindows.find(window => (
    window.ruleId === 'fixture:trigger-combo-stage'
  ));

  assertEqual(first.cooldownEndFrame, 60, 'first combo stage starts the shared cooldown');
  assertEqual(first.profile.comboStage?.index, 1, 'first chained combo resolves as stage 1 of one E intent');
  assertEqual(first.profile.comboStage?.count, 2, 'linear combo chain exposes its complete stage count');
  assertEqual(second.skillId, 'combo-3', 'same-frame form change resolves the chained stage');
  assertEqual(second.profile.comboStage?.index, 2, 'changed ComboSkill form resolves as stage 2');
  assertEqual(second.actualFrame, 1, 'chained stage starts at the requested action boundary');
  assertEqual(second.success, true, 'action-created pending admits the chained stage');
  assertEqual(second.releaseVerdict, 'valid', 'settled action pending is verified');
  assertEqual(chainedWindow?.bypassSkillCooldown, true, 'pending owns the cooldown bypass');
  assertEqual(chainedWindow?.consumedFrame, 1, 'pending is consumed exactly once');
  assertEqual(chainedWindow?.precisionWindow?.startFrame, 1, 'precision uses the pending trigger as its clock origin');
  assertEqual(chainedWindow?.precisionWindow?.endFrameExclusive, 3, 'precision preserves the exclusive right boundary');
  assertEqual(chainedWindow?.precisionWindow?.state, 'resolved', 'stage 2 resolves inside the precise subwindow');
  assertEqual(second.precisionVerdict, 'resolved', 'the consumed command carries its precision verdict to the button');
  assertEqual(repeated.success, false, 'consumed chained pending cannot be reused');
  assertEqual(repeated.releaseReason, 'COMBO_TRIGGER_MISSING', 'repeat failure is a combo gate');
}

{
  const actor = character('actor-a');
  const attack = profile({
    commandType: 'Attack',
    skillId: 'attack-4',
    bodyEndOffset: 30,
    tailEndOffset: 30,
    exclusiveFrames: 30,
    costType: null,
    costValue: 0,
    allowNext: [],
    hits: [{
      offsetFrames: 27,
      launchOffsetFrames: 10,
      sourceSkillId: 'attack-4-projectile-hit',
      rootSkillId: 'attack-4',
      kind: 'projectile',
      hitCount: 1,
      damageTypes: ['Pulse'],
    }],
  });
  const combo = profile({
    commandType: 'ComboSkill',
    skillId: 'combo-skill',
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    cooldownFrames: 60,
    costType: null,
    costValue: 0,
    allowNext: [],
    hits: [],
  });
  const trigger: AkeTimingComboTrigger = {
    id: 'attack-4-first-hit',
    eventType: 'BeforeHpDamage',
    rootSkillIds: ['attack-4'],
    sourceSkillIds: ['attack-4-projectile-hit'],
    damageAttributeType: 'Hp',
    occurrence: 'first-per-cast',
    comboSkillId: 'combo-skill',
    pendingDurationFrames: 180,
    requireComboOffCooldown: true,
    pendingPolicy: 'append',
    selectionPolicy: 'newest',
    consumePolicy: 'all-for-owner-and-skill',
    confidence: 'confirmed-for-test',
  };
  const readyResult = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [
      button('attack', actor.id, 0, 'A'),
      button('combo', actor.id, 2, 'E'),
    ] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [attack, combo] }, {
      [actor.id]: { comboTriggers: [trigger] },
    }),
    staffCount: 1,
  });
  const comboCommand = readyResult.commands.find(command => command.commandId === 'combo')!;
  assertEqual(comboCommand.success, true, 'matching hit opens the combo gate');
  assertEqual(readyResult.comboWindows[0].createdFrame, 27, 'combo trigger is created on hit frame');
  assertEqual(readyResult.comboWindows[0].consumedFrame, 30, 'successful combo consumes pending trigger');

  const missingResult = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [button('combo-only', actor.id, 0, 'E')] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [attack, combo] }, {
      [actor.id]: { comboTriggers: [trigger] },
    }),
    staffCount: 1,
  });
  assertEqual(missingResult.commands[0].success, false, 'combo cannot cast before its trigger');
  assertEqual(missingResult.commands[0].releaseReason, 'COMBO_TRIGGER_MISSING', 'missing combo trigger is explicit');
}

{
  const sourceActor = character('compound-source');
  const wulfa = character('chr_0028_wulfa');
  const compoundHit = button('compound-hit', sourceActor.id, 0, 'B');
  compoundHit.runtimeSkillId = 'compound-status-skill';
  const comboButton = button('wulfa-compound-combo', wulfa.id, 1, 'E');
  comboButton.runtimeSkillId = 'chr_0028_wulfa_combo_2_skill';
  comboButton.releaseAnchor = {
    schemaVersion: 1,
    kind: 'damage-hit',
    sourceButtonId: compoundHit.id,
    sourceHitId: `${compoundHit.id}:preview-hit:0`,
    sourceHitOffsetFrames: 5,
    debounceFrames: 6,
  };
  const compoundSourceProfile = profile({
    skillId: 'compound-status-skill',
    bodyEndOffset: 6,
    tailEndOffset: 6,
    exclusiveFrames: 6,
    costType: null,
    costValue: 0,
    allowNext: [],
    hits: [{
      offsetFrames: 5,
      sourceSkillId: 'compound-status-hit',
      rootSkillId: 'compound-status-skill',
      kind: 'direct',
      hitCount: 1,
      damageTypes: ['Physical'],
      hitBuffs: [{
        id: 'buff_common_energy_shard_attached_fire',
        displayName: '灼热附着',
        target: 'Target',
        kind: 'attachment',
        statusKey: 'fire-attachment',
        statusValue: 1,
      }, {
        id: 'buff_physical_no_guard',
        displayName: '破防',
        target: 'Target',
        kind: 'status',
        statusKey: 'no-guard',
        statusValue: 1,
      }],
    }],
  });
  const comboProfile = profile({
    commandType: 'ComboSkill',
    skillId: 'chr_0028_wulfa_combo_2_skill',
    bodyEndOffset: 10,
    tailEndOffset: 10,
    exclusiveFrames: 10,
    costType: null,
    costValue: 0,
    allowNext: [],
    hits: [],
  });
  const attachmentIds = [
    'buff_common_energy_shard_attached_fire',
    'buff_common_energy_shard_attached_pulse',
    'buff_common_energy_shard_attached_cryst',
    'buff_common_energy_shard_attached_natural',
  ];
  const triggers: AkeTimingComboTrigger[] = [{
    id: 'wulfa.no-guard-with-spell-infliction',
    eventType: 'StatusEffectApplied',
    eventTypes: ['StatusEffectApplied', 'StatusEffectRefreshed'],
    rootSkillIds: [],
    sourceSkillIds: [],
    statusBuffIds: ['buff_physical_no_guard'],
    conditions: [{
      type: 'BuffStackCompare',
      target: 'Target',
      buffIds: attachmentIds,
      operator: 'GE',
      value: 1,
    }],
    damageAttributeType: null,
    occurrence: 'every-event',
    comboSkillId: comboProfile.skillId,
    pendingDurationFrames: 180,
    ownerBinding: 'fixed',
    ownerId: wulfa.id,
    requireComboOffCooldown: true,
    pendingPolicy: 'replace-all',
    selectionPolicy: 'newest',
    consumePolicy: 'all-for-owner-and-skill',
    confidence: 'confirmed-for-test',
  }, {
    id: 'wulfa.spell-infliction-with-no-guard',
    eventType: 'StatusEffectApplied',
    eventTypes: ['StatusEffectApplied', 'StatusEffectRefreshed'],
    rootSkillIds: [],
    sourceSkillIds: [],
    statusBuffIds: attachmentIds,
    conditions: [{
      type: 'BuffStackCompare',
      target: 'Target',
      buffIds: ['buff_physical_no_guard'],
      operator: 'GE',
      value: 1,
    }],
    damageAttributeType: null,
    occurrence: 'every-event',
    comboSkillId: comboProfile.skillId,
    pendingDurationFrames: 180,
    ownerBinding: 'fixed',
    ownerId: wulfa.id,
    requireComboOffCooldown: true,
    pendingPolicy: 'replace-all',
    selectionPolicy: 'newest',
    consumePolicy: 'all-for-owner-and-skill',
    confidence: 'confirmed-for-test',
  }];
  const readyResult = buildAkeRealtimeTimeline({
    timelineData: timeline([
      { characterId: sourceActor.id, buttons: [compoundHit] },
      { characterId: wulfa.id, buttons: [comboButton] },
    ]),
    selectedCharacters: [sourceActor, wulfa],
    catalog: catalog({
      [sourceActor.id]: [compoundSourceProfile],
      [wulfa.id]: [comboProfile],
    }, {
      [wulfa.id]: { comboTriggers: triggers },
    }),
    staffCount: 1,
  });
  const comboCommand = readyResult.commands.find(command => command.commandId === comboButton.id)!;
  assertEqual(comboCommand.success, true, 'compound target state opens Wulfa combo in UI admission');
  assertEqual(readyResult.comboWindows.length, 1, 'only the transition that completes the compound state opens a window');
  assertEqual(readyResult.comboWindows[0].ruleId, 'wulfa.no-guard-with-spell-infliction', 'same-hit status order is deterministic');
  assertEqual(readyResult.comboWindows[0].createdFrame, 5, 'compound window is projected at the committed hit frame');
  assertEqual(readyResult.comboWindows[0].consumedCommandId, comboButton.id, 'combo consumes the projected window');

  const noGuardOnly = profile({
    ...compoundSourceProfile,
    skillId: 'no-guard-only-skill',
    hits: compoundSourceProfile.hits.map(hit => ({
      ...hit,
      rootSkillId: 'no-guard-only-skill',
      hitBuffs: hit.hitBuffs?.filter(buff => buff.id === 'buff_physical_no_guard'),
    })),
  });
  const noGuardButton = button('no-guard-only', sourceActor.id, 0, 'B');
  noGuardButton.runtimeSkillId = noGuardOnly.skillId;
  const rejectedCombo = button('wulfa-rejected-combo', wulfa.id, 1, 'E');
  rejectedCombo.runtimeSkillId = comboProfile.skillId;
  rejectedCombo.releaseAnchor = {
    schemaVersion: 1,
    kind: 'damage-hit',
    sourceButtonId: noGuardButton.id,
    sourceHitId: `${noGuardButton.id}:preview-hit:0`,
    sourceHitOffsetFrames: 5,
    debounceFrames: 6,
  };
  const rejectedResult = buildAkeRealtimeTimeline({
    timelineData: timeline([
      { characterId: sourceActor.id, buttons: [noGuardButton] },
      { characterId: wulfa.id, buttons: [rejectedCombo] },
    ]),
    selectedCharacters: [sourceActor, wulfa],
    catalog: catalog({
      [sourceActor.id]: [noGuardOnly],
      [wulfa.id]: [comboProfile],
    }, {
      [wulfa.id]: { comboTriggers: triggers },
    }),
    staffCount: 1,
  });
  const rejectedCommand = rejectedResult.commands.find(command => command.commandId === rejectedCombo.id)!;
  assertEqual(rejectedCommand.success, false, 'a partial target state cannot open the compound combo');
  assertEqual(rejectedCommand.releaseReason, 'COMBO_TRIGGER_MISSING', 'compound condition failure is fail-closed');
}

{
  const zhuang = character('zhuang');
  const pelica = character('pelica');
  const source = button('zhuang-full-attack', zhuang.id, 0, 'A');
  const comboButton = button('pelica-combo', pelica.id, 1, 'E');
  comboButton.runtimeSkillId = 'pelica-combo-skill';
  comboButton.releaseAnchor = {
    schemaVersion: 1,
    kind: 'damage-hit',
    sourceButtonId: source.id,
    sourceHitId: `${source.id}:preview-hit:3`,
    sourceHitOffsetFrames: 42,
    debounceFrames: 6,
  };
  const comboProfile = profile({
    commandType: 'ComboSkill',
    skillId: 'pelica-combo-skill',
    bodyEndOffset: 10,
    tailEndOffset: 10,
    exclusiveFrames: 10,
    costType: null,
    costValue: 0,
    allowNext: [],
    hits: [],
  });
  const trigger: AkeTimingComboTrigger = {
    id: 'pelica-any-heavy',
    eventType: 'BeforeHpDamage',
    rootSkillIds: [],
    sourceSkillIds: [],
    rootSkillRole: 'heavy-attack',
    damageAttributeType: 'Hp',
    occurrence: 'first-per-cast-target',
    comboSkillId: comboProfile.skillId,
    pendingDurationFrames: 180,
    ownerBinding: 'fixed',
    ownerId: pelica.id,
    requireComboOffCooldown: true,
    pendingPolicy: 'replace-all',
    selectionPolicy: 'newest',
    consumePolicy: 'all-for-owner-and-skill',
    confidence: 'confirmed-for-test',
  };
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([
      { characterId: zhuang.id, buttons: [source] },
      { characterId: pelica.id, buttons: [comboButton] },
    ]),
    selectedCharacters: [zhuang, pelica],
    catalog: catalog({
      [zhuang.id]: fourStageAttackProfiles(),
      [pelica.id]: [comboProfile],
    }, {
      [pelica.id]: { comboTriggers: [trigger] },
    }),
    staffCount: 1,
  });
  const comboCommand = result.commands.find(command => command.commandId === comboButton.id)!;
  assertEqual(comboCommand.actualFrame, 48, 'Pelica can use another controlled operator heavy hit');
  assertEqual(comboCommand.releaseVerdict, 'valid', 'cross-operator heavy trigger is verified');
  assertEqual(result.comboWindows[0].characterId, pelica.id, 'pending window belongs to Pelica, not the attacker');
}

{
  const chen = character('chen');
  const admin = character('admin');
  const chenCombo = button('chen-combo-source', chen.id, 0, 'E');
  chenCombo.runtimeSkillId = 'chen-combo-skill';
  const adminBefore = button('admin-before-hit', admin.id, 0, 'E');
  adminBefore.runtimeSkillId = 'admin-combo-skill';
  const adminAfter = button('admin-after-hit', admin.id, 1, 'E');
  adminAfter.runtimeSkillId = 'admin-combo-skill';
  adminAfter.releaseAnchor = {
    schemaVersion: 1,
    kind: 'damage-hit',
    sourceButtonId: chenCombo.id,
    sourceHitId: `${chenCombo.id}:preview-hit:0`,
    sourceHitOffsetFrames: 10,
    debounceFrames: 6,
  };
  const chenComboProfile = profile({
    commandType: 'ComboSkill',
    skillId: 'chen-combo-skill',
    bodyEndOffset: 20,
    tailEndOffset: 20,
    exclusiveFrames: 20,
    costType: null,
    costValue: 0,
    allowNext: [],
    hits: [{
      offsetFrames: 10,
      sourceSkillId: 'chen-combo-hit',
      rootSkillId: 'chen-combo-skill',
      kind: 'direct',
      hitCount: 1,
      damageTypes: ['Physical'],
    }],
  });
  const adminComboProfile = profile({
    commandType: 'ComboSkill',
    skillId: 'admin-combo-skill',
    bodyEndOffset: 10,
    tailEndOffset: 10,
    exclusiveFrames: 10,
    costType: null,
    costValue: 0,
    allowNext: [],
    hits: [],
  });
  const adminTrigger: AkeTimingComboTrigger = {
    id: 'admin-other-combo-hit',
    eventType: 'BeforeHpDamage',
    rootSkillIds: [],
    sourceSkillIds: [],
    sourceCommandTypes: ['ComboSkill'],
    requireSourceOtherThanOwner: true,
    damageAttributeType: 'Hp',
    occurrence: 'first-per-cast-target',
    comboSkillId: adminComboProfile.skillId,
    pendingDurationFrames: 180,
    ownerBinding: 'fixed',
    ownerId: admin.id,
    requireComboOffCooldown: true,
    pendingPolicy: 'replace-all',
    selectionPolicy: 'newest',
    consumePolicy: 'all-for-owner-and-skill',
    confidence: 'confirmed-for-test',
  };
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([
      { characterId: chen.id, buttons: [chenCombo] },
      { characterId: admin.id, buttons: [adminBefore, adminAfter] },
    ]),
    selectedCharacters: [chen, admin],
    catalog: catalog({
      [chen.id]: [chenComboProfile],
      [admin.id]: [adminComboProfile],
    }, {
      [admin.id]: { comboTriggers: [adminTrigger] },
    }),
    staffCount: 1,
  });
  assertEqual(
    result.commands.find(command => command.commandId === adminBefore.id)?.releaseReason,
    'COMBO_TRIGGER_MISSING',
    'Administrator cannot combo before another operator combo deals damage',
  );
  assertEqual(
    result.commands.find(command => command.commandId === adminAfter.id)?.releaseVerdict,
    'valid',
    'Administrator becomes legal after the other combo hit',
  );
}

{
  const actor = character('actor-a');
  const unresolvedCombo = profile({
    commandType: 'ComboSkill',
    skillId: 'unresolved-combo',
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    costType: null,
    costValue: 0,
    allowNext: [],
  });
  const result = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [button('combo', actor.id, 0, 'E')] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: [unresolvedCombo] }),
    staffCount: 1,
  });
  assertEqual(result.commands[0].success, true, 'unmapped combo remains usable in preview');
  assertEqual(result.commands[0].releaseVerdict, 'unverified', 'unmapped combo is not falsely certified');
  assertEqual(result.sharedVariableRateTimeline?.admissionStatus, 'unverified', 'unknown runtime rules stay unverified in the shared plan');
}

{
  const actor = character('actor-form');
  const ultimate = profile({
    commandType: 'UltimateSkill',
    skillId: 'ultimate',
    durationFrames: 1,
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    costType: null,
    costValue: 0,
    priority: 3,
    allowNext: [],
    formEvents: [
      {
        offsetFrames: 0,
        operation: 'apply',
        kind: 'override',
        stateKey: 'ultimate-normal',
        skillSlot: 'NormalSkill',
        targetSkillId: 'normal-ultimate-form',
      },
      {
        offsetFrames: 0,
        operation: 'apply',
        kind: 'mode',
        stateKey: 'ultimate-mode',
        modeId: 'UltMode',
      },
      {
        offsetFrames: 20,
        operation: 'remove',
        kind: 'override',
        stateKey: 'ultimate-normal',
      },
      {
        offsetFrames: 20,
        operation: 'remove',
        kind: 'mode',
        stateKey: 'ultimate-mode',
      },
    ],
  });
  const normal = profile({
    skillId: 'normal',
    durationFrames: 1,
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    costType: null,
    costValue: 0,
    allowNext: [],
  });
  const transformedNormal = profile({
    skillId: 'normal-ultimate-form',
    variantIndex: 1,
    durationFrames: 1,
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    costType: null,
    costValue: 0,
    allowNext: [],
  });
  const attack = profile({
    commandType: 'Attack',
    skillId: 'attack1',
    durationFrames: 1,
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    costType: null,
    costValue: 0,
    priority: 0,
    allowNext: [],
  });
  const transformedAttack = profile({
    commandType: 'Attack',
    skillId: 'attack1_ult',
    variantIndex: 1,
    durationFrames: 1,
    bodyEndOffset: 1,
    tailEndOffset: 1,
    exclusiveFrames: 1,
    costType: null,
    costValue: 0,
    priority: 0,
    allowNext: [],
  });
  const profiles = [ultimate, normal, transformedNormal, attack, transformedAttack];

  const activeResult = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [
      button('ultimate', actor.id, 0, 'Q'),
      button('normal-during-form', actor.id, 1, 'B'),
    ] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: profiles }),
    staffCount: 1,
  });
  assertEqual(
    activeResult.commands.find(command => command.commandId === 'normal-during-form')?.skillId,
    'normal-ultimate-form',
    'active skill-slot override selects the transformed normal skill',
  );

  const delayedFormUltimate = profile({
    ...ultimate,
    durationFrames: 11,
    bodyEndOffset: 10,
    tailEndOffset: 10,
    exclusiveFrames: 10,
    formEvents: (ultimate.formEvents ?? []).map(event => ({
      ...event,
      offsetFrames: event.operation === 'apply' ? 5 : 20,
    })),
  });
  const queuedFormResult = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [
      button('delayed-ultimate', actor.id, 0, 'Q'),
      button('queued-normal-intent', actor.id, 0, 'B'),
    ] }]),
    selectedCharacters: [actor],
    catalog: catalog({
      [actor.id]: [delayedFormUltimate, normal, transformedNormal, attack, transformedAttack],
    }),
    staffCount: 1,
  });
  const queuedNormal = queuedFormResult.commands.find(command => (
    command.commandId === 'queued-normal-intent'
  ));
  assertEqual(queuedNormal?.requestedFrame, 10, 'planner places the intent after the blocking action');
  assertEqual(queuedNormal?.actualFrame, 10, 'runtime accepts the relationship-scheduled frame directly');
  assertEqual(queuedNormal?.queued, false, 'the tail relation is not an input queue');
  assertEqual(
    queuedNormal?.skillId,
    'normal-ultimate-form',
    'queued intent re-resolves the enhanced form at its actual execution frame',
  );
  assertEqual(
    queuedNormal?.profile.resolutionSource,
    'skill-form-override',
    'preview exposes why the enhanced form was selected',
  );

  const modeResult = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [
      button('ultimate', actor.id, 0, 'Q'),
      button('attack-during-mode', actor.id, 1, 'A'),
    ] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: profiles }),
    staffCount: 1,
  });
  assertEqual(
    modeResult.commands.find(command => command.commandId === 'attack-during-mode')?.skillId,
    'attack1_ult',
    'active mode selects the transformed attack form',
  );

  const expiredResult = buildAkeRealtimeTimeline({
    timelineData: timeline([{ characterId: actor.id, buttons: [
      button('ultimate', actor.id, 0, 'Q'),
      button('normal-after-form', actor.id, 2, 'B'),
    ] }]),
    selectedCharacters: [actor],
    catalog: catalog({ [actor.id]: profiles }),
    staffCount: 1,
  });
  assertEqual(
    expiredResult.commands.find(command => command.commandId === 'normal-after-form')?.skillId,
    'normal-ultimate-form',
    'an empty display node does not wait for the form to expire',
  );
}
