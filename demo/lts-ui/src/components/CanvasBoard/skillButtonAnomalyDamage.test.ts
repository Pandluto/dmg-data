import type { DamageBonusSnapshot, SkillButtonBuff } from '../../types/storage';
import type { SelectedAnomalyCard } from './skillButton.shared';
import { buildAnomalyDamageSegments } from './skillButtonAnomalyDamage';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertClose(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function modifierBuff(
  id: string,
  value?: number,
  multiplierCoefficient?: number
): SkillButtonBuff {
  return {
    id,
    name: id,
    displayName: id,
    sourceName: 'integration golden',
    source: 'test',
    type: 'multiplierBonus',
    value,
    multiplier: multiplierCoefficient === undefined
      ? undefined
      : { coefficient: multiplierCoefficient },
    refCount: 1,
  };
}

const zeroDamageBonus: DamageBonusSnapshot = {
  physicalDmgBonus: 0,
  fireDmgBonus: 0,
  electricDmgBonus: 0,
  iceDmgBonus: 0,
  natureDmgBonus: 0,
  magicDmgBonus: 0,
  normalAttackDmgBonus: 0,
  dotDmgBonus: 0,
  skillDmgBonus: 0,
  chainSkillDmgBonus: 0,
  ultimateDmgBonus: 0,
  allSkillDmgBonus: 0,
  imbalanceDmgBonus: 0,
  allDmgBonus: 0,
};

const anomalyCards: SelectedAnomalyCard[] = [
  {
    id: 'magic-burst-card',
    key: 'magic-burst',
    label: '法术爆发',
    kind: 'damage',
    category: 'magic',
    level: 0,
    primaryText: '',
    secondaryText: '',
    selectedBuffIds: [],
  },
  {
    id: 'burn-card',
    key: 'burn',
    label: '燃烧',
    kind: 'damage',
    category: 'magic',
    level: 1,
    burnDamageMode: 'dotOnly',
    durationSeconds: 10,
    primaryText: '',
    secondaryText: '',
    selectedBuffIds: [],
  },
];

const extraHitBuff: SkillButtonBuff & {
  effectKind: 'extraHit';
  extraHitConfig: NonNullable<SkillButtonBuff['extraHitConfig']>;
} = {
  id: 'extra-hit',
  name: 'extra-hit',
  displayName: '额外伤害',
  sourceName: 'integration golden',
  source: 'test',
  refCount: 1,
  effectKind: 'extraHit',
  extraHitConfig: {
    baseMultiplier: 2,
    damageType: 'fire',
    skillType: 'B',
    imbalanceValue: 0,
    cooldownSeconds: 0,
  },
};

const segments = buildAnomalyDamageSegments({
  panelBase: null,
  panelData: { atk: 1000, critRate: 0, critDmg: 0 },
  hitCards: [],
  selectedAnomalyDamages: anomalyCards,
  buttonCharacterId: 'operator',
  element: 'fire',
  damageBonus: zeroDamageBonus,
  targetResistance: { fireResistance: 0 },
  fullCombinedModifierBuffList: [
    modifierBuff('additive', 0.4),
    modifierBuff('multiplier', undefined, 1.2),
  ],
  extraHitBuffList: [extraHitBuff],
  manuallyDisabledBuffIdsBySegmentKey: {
    'buff-extra-hit-extra-hit': ['additive'],
  },
  singleHitBuffTargetByBuffId: {
    additive: 'buff-extra-hit-extra-hit',
  },
  getEffectiveCharacterSourceSkillBoost: () => 0,
});

assertEqual(segments.length, 3, 'golden should include anomaly, burn DoT, and extra-hit segments');

const [anomaly, burnDot, extraHit] = segments;

assertEqual(anomaly.multiplierText, '279.2%', 'anomaly should not inherit a single-hit additive Buff targeted elsewhere');
assertEqual(anomaly.multiplierFormulaText, '(232.7% + 0.0%) × 1.200', 'anomaly formula should retain the ordinary multiplier Buff');
assertEqual(anomaly.nonCritText, '1396', 'anomaly non-crit text should exclude the single-hit additive Buff');
assertClose(anomaly.nonCritValue, 1395.9183673469388, 'anomaly damage should exclude a single-hit additive Buff targeted elsewhere');

assertEqual(burnDot.multiplierText, '418.8%', 'burn DoT should not inherit a single-hit additive Buff targeted elsewhere');
assertEqual(burnDot.multiplierFormulaText, '(349.0% + 0.0%) × 1.200', 'burn DoT formula should retain the ordinary multiplier Buff');
assertEqual(burnDot.nonCritText, '2094', 'burn DoT non-crit text should exclude the single-hit additive Buff');
assertClose(burnDot.nonCritValue, 2093.877551020408, 'burn DoT damage should exclude a single-hit additive Buff targeted elsewhere');

assertEqual(extraHit.multiplierText, '288.0%', 'extra-hit multiplier text should include additive and multiplier buffs');
assertEqual(extraHit.multiplierFormulaText, '(200.0% + 40.0%) × 1.200', 'extra-hit formula should expose operation order');
assertEqual(extraHit.nonCritText, '1440', 'extra-hit non-crit text should use the final multiplier');
assertClose(extraHit.nonCritValue, 1440, 'extra-hit damage should apply (base + additive) times multiplier');

function buildSourceSkillExtraHit(levelCurve: 'physicalAnomaly' | 'artsBurst') {
  return buildAnomalyDamageSegments({
    panelBase: null,
    panelData: { atk: 1000, critRate: 0, critDmg: 0 },
    hitCards: [],
    selectedAnomalyDamages: [],
    buttonCharacterId: 'operator',
    element: 'physical',
    damageBonus: zeroDamageBonus,
    targetResistance: { physicalResistance: 0 },
    fullCombinedModifierBuffList: [],
    extraHitBuffList: [{
      ...extraHitBuff,
      id: `source-skill-${levelCurve}`,
      extraHitConfig: {
        ...extraHitBuff.extraHitConfig,
        baseMultiplier: 1,
        damageType: 'physical',
        skillType: '',
        formulaMode: 'sourceSkill',
        levelCurve,
      },
    }],
    manuallyDisabledBuffIdsBySegmentKey: {},
    getEffectiveCharacterSourceSkillBoost: () => 100,
  })[0];
}

const physicalSourceSkillHit = buildSourceSkillExtraHit('physicalAnomaly');
assertEqual(physicalSourceSkillHit.levelCoefficientText, '1.227', 'physical anomaly curve should use the 392 denominator');
assertEqual(physicalSourceSkillHit.sourceSkillZoneText, '2.000', 'source-skill extra hit should expose its source-skill zone');
assertEqual(physicalSourceSkillHit.multiplierFormulaText, '(245.4% + 0.0%) × 1.000', 'physical source-skill formula should scale the base multiplier');
assertClose(physicalSourceSkillHit.nonCritValue, 1227.0408163265306, 'physical source-skill extra hit should apply level and source-skill coefficients');

const artsSourceSkillHit = buildSourceSkillExtraHit('artsBurst');
assertEqual(artsSourceSkillHit.levelCoefficientText, '1.454', 'arts burst curve should use the 196 denominator');
assertEqual(artsSourceSkillHit.multiplierFormulaText, '(290.8% + 0.0%) × 1.000', 'arts-burst source-skill formula should scale the base multiplier');
assertClose(artsSourceSkillHit.nonCritValue, 1454.0816326530612, 'arts-burst source-skill extra hit should apply level and source-skill coefficients');

const mandatoryMechanicCard: SelectedAnomalyCard = {
  id: 'ake-mechanic:button:armor-break:1',
  key: 'armor-break',
  label: '碎甲',
  kind: 'damage',
  category: 'physical',
  level: 3,
  primaryText: 'AKE 真实机制 · 碎甲 Lv3',
  secondaryText: '200% 物理异常 hit',
  selectedBuffIds: [],
};
const mandatoryMechanicSegment = buildAnomalyDamageSegments({
  panelBase: null,
  panelData: { atk: 1000, critRate: 0, critDmg: 0 },
  hitCards: [],
  selectedAnomalyDamages: [mandatoryMechanicCard],
  mandatoryAnomalyDamageIds: new Set([mandatoryMechanicCard.id]),
  intrinsicModifierBuffsBySegmentKey: {
    [mandatoryMechanicCard.id]: [{
      id: 'intrinsic-fracture',
      name: 'intrinsic-fracture',
      displayName: '碎甲内建物伤易伤',
      sourceName: 'AKE 真实状态机',
      source: 'ake_mechanic',
      type: 'physicalFragile',
      value: 0.2,
      category: 'passive',
      refCount: 1,
    }],
  },
  buttonCharacterId: 'operator',
  element: 'physical',
  damageBonus: zeroDamageBonus,
  targetResistance: { physicalResistance: 0 },
  fullCombinedModifierBuffList: [],
  extraHitBuffList: [],
  manuallyDisabledBuffIdsBySegmentKey: {},
  disabledHitKeys: [mandatoryMechanicCard.id],
  getEffectiveCharacterSourceSkillBoost: () => 0,
})[0];
assertEqual(mandatoryMechanicSegment.isMandatoryMechanic, true, 'AKE mechanic segment should be marked mandatory');
assertEqual(mandatoryMechanicSegment.isDisabled, undefined, 'demo hit toggles must not suppress a real mechanic hit');
assertEqual(mandatoryMechanicSegment.appliedBuffTags[0]?.id, 'intrinsic-fracture', 'fracture should apply its built-in physical damage state to its own hit');
assertClose(mandatoryMechanicSegment.nonCritValue, 1472.4489795918369, 'mandatory fracture hit should retain its intrinsic modifier and real damage');

const originiumShatterCard: SelectedAnomalyCard = {
  id: 'ake-mechanic:administrator:originium-shatter:1',
  key: 'originium-shatter',
  label: '源石结晶击碎',
  kind: 'damage',
  category: 'physical',
  level: 0,
  primaryText: 'AKE 真实机制 · 源石结晶击碎',
  secondaryText: '400% 物理额外 hit',
  selectedBuffIds: [],
  baseMultiplierPercent: 400,
  usesRawAtkScale: true,
};
const originiumShatterSegment = buildAnomalyDamageSegments({
  panelBase: null,
  panelData: { atk: 1000, critRate: 0, critDmg: 0 },
  hitCards: [{ displayName: '强化战技本体', nonCritText: '0' }, { displayName: '猛击', nonCritText: '0' }],
  selectedAnomalyDamages: [originiumShatterCard],
  mandatoryAnomalyDamageIds: new Set([originiumShatterCard.id]),
  buttonCharacterId: 'chr_0003_endminf',
  element: 'physical',
  damageBonus: zeroDamageBonus,
  targetResistance: { physicalResistance: 0 },
  fullCombinedModifierBuffList: [],
  extraHitBuffList: [],
  manuallyDisabledBuffIdsBySegmentKey: {},
  getEffectiveCharacterSourceSkillBoost: () => 100,
})[0];
assertEqual(originiumShatterSegment.title, '3段 · 源石结晶击碎', 'crystal shatter should render as the third independent hit');
assertEqual(originiumShatterSegment.sequenceTitle, '额外伤害 · 源石结晶击碎', 'crystal shatter should use the extra-hit lane instead of masquerading as an anomaly');
assertEqual(originiumShatterSegment.sourceKind, 'buff-extra-hit', 'crystal shatter should expose its extra-hit source kind');
assertEqual(originiumShatterSegment.baseMultiplierText, '400.0%', 'crystal shatter should read the level-scaled AKE M3 atkScale');
assertEqual(originiumShatterSegment.levelCoefficientText, '1.000', 'crystal shatter must not use the physical-anomaly level curve');
assertEqual(originiumShatterSegment.sourceSkillZoneText, '1.000', 'crystal shatter must not multiply the raw atkScale by source skill');
assertClose(originiumShatterSegment.nonCritValue, 2000, '400% raw physical hit should settle independently through defense');
