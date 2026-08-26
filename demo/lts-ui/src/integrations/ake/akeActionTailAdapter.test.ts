import assert from 'node:assert/strict';
import { resolveActionTailTransition } from '../../core/domain/combatActionTailPlanner';
import type { AkeTimingSkillProfile } from './akeCatalogAdapter';
import {
  akeProfileToActionTailContract,
  akeProfileToTailSuccessor,
} from './akeActionTailAdapter';

function baseProfile(overrides: Partial<AkeTimingSkillProfile>): AkeTimingSkillProfile {
  return {
    commandType: 'NormalSkill',
    skillId: 'skill',
    variantIndex: 0,
    durationFrames: 100,
    bodyEndOffset: 99,
    tailEndOffset: 99,
    exclusiveFrames: 30,
    cooldownFrames: 0,
    costType: 'Atb',
    costValue: 100,
    priority: 2,
    allowNext: [],
    commandMappings: [],
    formEvents: [],
    interruptibleAt: [],
    hits: [],
    resourceEvents: [],
    recoveryPauses: [],
    derivation: 'isolated-runtime-probe',
    ...overrides,
  };
}

{
  const profile = baseProfile({
    skillId: 'chr_0004_pelica_normal_skill',
    durationFrames: 155,
    bodyEndOffset: 154,
    tailEndOffset: 154,
    exclusiveFrames: 30,
    allowNext: [{
      startOffsetFrames: 28,
      endOffsetFrames: 54,
      allowedSkillIds: ['chr_0004_pelica_normal_skill'],
    }],
    hits: [{
      offsetFrames: 13,
      launchOffsetFrames: null,
      sourceSkillId: 'chr_0004_pelica_normal_skill',
      rootSkillId: 'chr_0004_pelica_normal_skill',
      kind: 'direct',
      hitCount: 1,
      damageTypes: ['Pulse'],
    }],
    resourceEvents: [{
      offsetFrames: 13,
      resourceType: 'UltimateSp',
      scope: 'Entity',
      target: 'team',
      gainMethod: 'Gain',
      amount: 6.5,
    }],
  });
  const contract = akeProfileToActionTailContract({ actionId: 'pelica-1', profile });
  assert.equal(contract.naturalEndOffsetFrames, 154);
  assert.equal(contract.effectEndOffsetFrames, 13);
  assert.equal(contract.tailCancelable, true);
  assert.equal(contract.commitEvidence, 'verified');
  const transition = resolveActionTailTransition({
    predecessor: contract,
    successor: akeProfileToTailSuccessor('pelica-2', profile),
    boundary: 'append',
    debounceFrames: 6,
  });
  assert.equal(transition.blockingEndOffsetFrames, 28);
}

{
  const profile = baseProfile({
    skillId: 'chr_0030_zhuangfy_normal_skill',
    durationFrames: 290,
    bodyEndOffset: 190,
    tailEndOffset: 190,
    exclusiveFrames: 135,
    allowNext: [{
      startOffsetFrames: 45,
      endOffsetFrames: 116,
      allowedSkillIds: ['chr_0030_zhuangfy_normal_skill'],
    }],
    // Damage is resolved through the spawned-sword Buff chain. It is still a
    // real frame-28 settlement point, independent from the cancelable recovery.
    hits: [{
      offsetFrames: 28,
      launchOffsetFrames: null,
      sourceSkillId: 'chr_0030_zhuangfy_normal_skill_gene_sword',
      rootSkillId: 'chr_0030_zhuangfy_normal_skill',
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
  const contract = akeProfileToActionTailContract({ actionId: 'zhuang-1', profile });
  assert.equal(contract.effectEndOffsetFrames, 28);
  assert.equal(contract.commitEvidence, 'verified');
  const transition = resolveActionTailTransition({
    predecessor: contract,
    successor: akeProfileToTailSuccessor('zhuang-2', profile),
    boundary: 'append',
    debounceFrames: 6,
  });
  assert.equal(transition.blockingEndOffsetFrames, 45);
}

{
  const fallback = baseProfile({
    derivation: 'compiled-fallback',
    diagnostic: 'target-dependent child effect unresolved',
  });
  const contract = akeProfileToActionTailContract({ actionId: 'unknown', profile: fallback });
  assert.equal(contract.commitEvidence, 'unverified');
  assert.equal(contract.tailCancelable, false);
}

console.log('AKE action-tail adapter: PASS');
