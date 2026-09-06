import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { createAkeDamageResolver } from '../src/core/ake-damage-resolver.mjs';
import {
    AkeLoadoutCompiler,
    LoadoutEffectManager
} from '../src/core/ake-loadout-compiler.mjs';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

function readJson(relativePath) {
    return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

function readBuff(buffId) {
    return readJson(`reference/public-data/akedata/Json/BuffData/${buffId}.json`);
}

test('real Pelica attack1 timeline drives its sourced super-armor window', () => {
    const compiler = new AkeActionCompiler();
    const program = compiler.compileSkill(readJson(
        'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack1.json'
    ));
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                {
                    id: 'pelica',
                    kind: 'Character',
                    team: 'ally',
                    clockDomainId: 'pelica-clock',
                    resilience: {
                        maxResilience: 100,
                        currentResilience: 100,
                        superArmorLevel: 0
                    }
                },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ]
        }
    });

    const scheduled = runtime.scheduleProgram(program, {
        frame: 0,
        sourceId: 'pelica',
        ownerId: 'pelica',
        targetId: 'enemy',
        clockDomainId: 'pelica-clock'
    });

    assert.equal(scheduled.scheduled.length, 3);
    runtime.runUntil(0);
    assert.equal(runtime.resilience.snapshot('pelica').superArmorLevel, 15);
    runtime.runUntil(14);
    assert.equal(runtime.resilience.snapshot('pelica').superArmorLevel, 15);
    runtime.runUntil(15);
    assert.equal(runtime.resilience.snapshot('pelica').superArmorLevel, 0);
});

test('real Pelica potential listens for Pulse Buff output, stacks Atk and rolls back by source', () => {
    const compiler = new AkeActionCompiler();
    const buffIds = [
        'buff_chr_0004_pelica_potential_3',
        'buff_chr_0004_pelica_potential_3_atkup',
        'buff_common_pulse_fire_triggered'
    ];
    const buffs = Object.fromEntries(buffIds.map(buffId => [
        buffId,
        compiler.compileBuff(readBuff(buffId))
    ]));
    const table = readJson('reference/public-data/akedata/TableCfg/PotentialTalentEffectTable.json');
    const effect = new AkeLoadoutCompiler().compile(
        'chr_0004_pelica_potential_3',
        table.chr_0004_pelica_potential_3
    );
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                {
                    id: 'pelica',
                    kind: 'Character',
                    team: 'ally',
                    attributes: { Atk: 100, PulseAbnormalDamageIncrease: 0 }
                },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs
        }
    });
    const manager = new LoadoutEffectManager({ runtime });
    const installation = manager.install(effect, { ownerId: 'pelica' });
    const pulseContext = {
        eventType: 'TestPulseOutput',
        sourceId: 'pelica',
        ownerId: 'pelica',
        targetId: 'enemy'
    };

    runtime.execute(
        { type: 'ApplyBuff', buffId: 'buff_common_pulse_fire_triggered' },
        { ...pulseContext, frame: 1 }
    );
    assert.equal(runtime.context.getAttribute('pelica', 'Atk'), 120);
    runtime.execute(
        { type: 'ApplyBuff', buffId: 'buff_common_pulse_fire_triggered' },
        { ...pulseContext, frame: 2 }
    );
    assert.equal(runtime.context.getAttribute('pelica', 'Atk'), 140);

    const removed = manager.uninstall(installation.key, 3);
    assert.deepEqual(
        removed.buffInstances.map(instance => instance.buffId).sort(),
        [
            'buff_chr_0004_pelica_potential_3',
            'buff_chr_0004_pelica_potential_3_atkup'
        ]
    );
    assert.equal(runtime.context.getAttribute('pelica', 'Atk'), 100);
});

test('real public BuffData executes periodic healing and fans exact USP gain across allies', () => {
    const mappings = readJson('spec/engine-semantic-mappings.json');
    const compiler = new AkeActionCompiler({ semanticMappings: mappings });
    const heal = compiler.compileBuff(readBuff('buff_common_heal_moss_1'));
    const usp = compiler.compileBuff(readBuff('buff_common_obtain_ultimate_sp'));
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                {
                    id: 'pelica',
                    kind: 'Character',
                    team: 'ally',
                    vital: { maxHp: 100, currentHp: 10 }
                },
                { id: 'chen', kind: 'Character', team: 'ally' }
            ],
            resources: [
                {
                    id: 'pelica:UltimateSp',
                    resourceType: 'UltimateSp',
                    scope: 'Entity',
                    ownerId: 'pelica',
                    initial: 0,
                    max: 80
                },
                {
                    id: 'chen:UltimateSp',
                    resourceType: 'UltimateSp',
                    scope: 'Entity',
                    ownerId: 'chen',
                    initial: 0,
                    max: 70
                }
            ],
            buffs: {
                [heal.buffId]: heal,
                [usp.buffId]: usp
            }
        }
    });
    const context = {
        frame: 0,
        eventType: 'FixtureSetup',
        sourceId: 'pelica',
        ownerId: 'pelica',
        targetId: 'pelica'
    };

    runtime.execute({
        type: 'ApplyBuff',
        buffId: heal.buffId,
        blackboard: { duration: 3, maxcount: 2, value: 10, triggerheal: 4 }
    }, context);
    assert.equal(runtime.vitals.get('pelica').currentHp, 24);
    runtime.runUntil(60);
    assert.equal(runtime.vitals.get('pelica').currentHp, 32);

    runtime.execute({ type: 'ApplyBuff', buffId: usp.buffId }, context);
    assert.equal(
        runtime.resources.get({
            resourceType: 'UltimateSp',
            scope: 'Entity',
            ownerId: 'pelica'
        }),
        6.499999761581421
    );
    assert.equal(
        runtime.resources.get({
            resourceType: 'UltimateSp',
            scope: 'Entity',
            ownerId: 'chen'
        }),
        6.499999761581421
    );
});

test('real Wulfgard GainCostAction grants its literal one point of USP', () => {
    const compiler = new AkeActionCompiler();
    const buffId = 'buff_chr_0006_wolfgd_normal_skill_usp';
    const definition = compiler.compileBuff(readBuff(buffId));
    assert.equal(definition.compiler.status, 'executable');
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{ id: 'wulfgard', kind: 'Character', team: 'ally' }],
            resources: [{
                id: 'wulfgard:UltimateSp',
                resourceType: 'UltimateSp',
                scope: 'Entity',
                ownerId: 'wulfgard',
                initial: 0,
                max: 100
            }],
            buffs: { [buffId]: definition }
        }
    });
    runtime.execute({ type: 'ApplyBuff', buffId }, {
        frame: 0,
        sourceId: 'wulfgard',
        ownerId: 'wulfgard',
        targetId: 'wulfgard'
    });
    assert.equal(runtime.resources.describePool('wulfgard:UltimateSp').current, 1);
});

test('real Mifu second skill reads abnormal layers and exposes the third skill at three stacks', () => {
    const bundle = new AkeSquadScenarioAssembler().assemble({
        enemyId: 'eny_0007_mimicw',
        members: [{ memberId: 'mifu', characterId: 'chr_0031_mifu' }]
    });
    const compiler = new AkeActionCompiler({ semanticMappings: bundle.semanticMappings });
    const noGuard = compiler.compileBuff(readBuff('buff_physical_no_guard'));
    const skill = bundle.programs.get('chr_0031_mifu_normalskill_2');
    assert.ok(skill);

    const resolvedForm = (layers) => {
        const definitions = structuredClone(bundle.definitions);
        definitions.buffs = {
            ...definitions.buffs,
            [noGuard.buffId]: noGuard
        };
        const runtime = new CombatRuntime({
            definitions,
            damageResolver: createAkeDamageResolver()
        });
        const context = {
            frame: 0,
            sourceId: 'chr_0031_mifu',
            ownerId: 'chr_0031_mifu',
            targetId: 'eny_0007_mimicw',
            skillId: skill.skillId,
            rootSkillId: skill.skillId,
            castId: `mifu-form-${layers}`
        };
        for (let index = 0; index < layers; index += 1) {
            runtime.execute({ type: 'ApplyBuff', buffId: noGuard.buffId }, context);
        }
        runtime.scheduleProgram(skill, context);
        runtime.runUntil(30);
        return runtime.skillForms.resolveOverride({
            targetId: 'chr_0031_mifu',
            skillSlot: 'NormalSkill'
        })?.targetSkillId ?? null;
    };

    assert.equal(resolvedForm(2), null);
    assert.equal(resolvedForm(3), 'chr_0031_mifu_normalskill_3');
});

test('generic deck-attribute comparison drives both Jue forms without character code', () => {
    const compiler = new AkeActionCompiler();
    const definition = compiler.compileBuff(readBuff(
        'buff_chr_0032_lizhiyan_passive'
    ));
    const formGate = definition.startActions.find(action => action.type === 'IfElseAction');
    assert.equal(formGate.conditions[0].type, 'Compare');
    assert.equal(formGate.conditions[0].left.values[0].attribute, 'Wisd');
    assert.equal(formGate.conditions[0].right.values[0].attribute, 'Will');

    const resolveForm = attributes => {
        const runtime = new CombatRuntime({
            definitions: {
                entities: [{ id: 'jue', kind: 'Character', team: 'ally', attributes }],
                buffs: { [definition.buffId]: definition }
            }
        });
        runtime.execute({ type: 'ApplyBuff', buffId: definition.buffId }, {
            frame: 0,
            sourceId: 'jue',
            ownerId: 'jue',
            targetId: 'jue'
        });
        return runtime.snapshot().entityBlackboards.jue.EntityBB_wisd_greater_will;
    };

    assert.equal(resolveForm({ Wisd: 120, Will: 100 }), 1);
    assert.equal(resolveForm({ Wisd: 80, Will: 100 }), 0);
});

test('real OnObtainAtb listener stores the event value and applies its extra gain once', () => {
    const compiler = new AkeActionCompiler();
    const buffId = 'buff_dung_atb_add_useskill';
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{ id: 'caster', kind: 'Character', team: 'ally' }],
            resources: [{
                id: 'squad:Atb',
                resourceType: 'Atb',
                scope: 'Shared',
                initial: 0,
                max: 300
            }],
            buffs: { [buffId]: compiler.compileBuff(readBuff(buffId)) }
        }
    });
    runtime.execute({ type: 'ApplyBuff', buffId }, {
        frame: 0,
        sourceId: 'caster',
        ownerId: 'caster',
        targetId: 'caster'
    });

    runtime.execute({
        type: 'ResourceChange',
        resourceType: 'Atb',
        scope: 'Shared',
        operation: 'Gain',
        amount: 10,
        resourceSourceType: 'Skill',
        resourceGainMethod: 'Gain'
    }, {
        frame: 1,
        sourceId: 'caster',
        ownerId: 'caster',
        targetId: 'caster',
        skillId: 'skill:test',
        castId: 'cast:test',
        skillType: 'NormalSkill'
    });

    assert.equal(runtime.resources.describePool('squad:Atb').current, 20);
    assert.deepEqual(runtime.resources.trace
        .filter(entry => entry.stage === 'ResourceGained')
        .map(entry => [
            entry.requested,
            entry.resourceSourceType,
            entry.resourceGainMethod
        ]), [
        [10, 'Skill', 'Gain'],
        [10, 'Default', 'Gain']
    ]);
    assert.equal(runtime.statusEffects.list({ buffId })[0].blackboard.atb_value, 10);
    assert.equal(runtime.trace.filter(entry =>
        entry.stage === 'AbilityEventNotified' && entry.eventType === 'OnObtainAtb'
    ).length, 2);
});

test('real Liino Refrain Buff blocks USP gain only while the Buff is active', () => {
    const compiler = new AkeActionCompiler();
    const buffId = 'buff_chr_0035_liino_ultskill_refrainobtainusp';
    const definition = compiler.compileBuff(readBuff(buffId));
    assert.equal(definition.compiler.status, 'executable');
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{ id: 'liino', kind: 'Character', team: 'ally' }],
            resources: [{
                id: 'liino:UltimateSp',
                resourceType: 'UltimateSp',
                scope: 'Entity',
                ownerId: 'liino',
                initial: 0,
                max: 100
            }],
            buffs: { [buffId]: definition }
        }
    });
    const context = {
        frame: 0,
        sourceId: 'liino',
        ownerId: 'liino',
        targetId: 'liino'
    };
    runtime.execute({ type: 'ApplyBuff', buffId }, context);
    const blocked = runtime.execute({
        type: 'ResourceChange',
        resourceType: 'UltimateSp',
        scope: 'Entity',
        operation: 'Gain',
        amount: 10
    }, { ...context, frame: 1 });
    assert.equal(blocked.stage, 'ResourceGainSuppressed');
    const tagged = runtime.execute({
        type: 'ResourceChange',
        resourceType: 'UltimateSp',
        scope: 'Entity',
        operation: 'Gain',
        amount: 16,
        resourceGainTags: [264623624]
    }, { ...context, frame: 1 });
    assert.equal(tagged.stage, 'ResourceGainSuppressed',
        'an empty allowed-tag list blocks tagged recovery as well as generic recovery');
    assert.equal(runtime.resources.describePool('liino:UltimateSp').current, 0);

    runtime.execute({ type: 'FinishBuff', target: 'Target', buffId }, {
        ...context,
        frame: 2
    });
    runtime.execute({
        type: 'ResourceChange',
        resourceType: 'UltimateSp',
        scope: 'Entity',
        operation: 'Gain',
        amount: 10
    }, { ...context, frame: 3 });
    assert.equal(runtime.resources.describePool('liino:UltimateSp').current, 10);
    assert.equal(runtime.resources.describePool('liino:UltimateSp').gainSuppressions.length, 0);
});

test('real tag-based dispel and layer-based FinishBuff use definition metadata', () => {
    const compiler = new AkeActionCompiler();
    const dispel = compiler.compileBuff(readBuff('buff_gambling_dispel_spellabnormal'));
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{ id: 'pelica', kind: 'Character', team: 'ally' }],
            buffs: {
                [dispel.buffId]: dispel,
                'buff.test.spell-abnormal': {
                    tagIds: [1474064594],
                    stackingPolicy: 'Refresh'
                },
                'buff.test.layers': {
                    stackingPolicy: 'AddStack',
                    maxStacks: 3
                }
            }
        }
    });
    const context = {
        frame: 0,
        eventType: 'FixtureSetup',
        sourceId: 'pelica',
        ownerId: 'pelica',
        targetId: 'pelica'
    };

    runtime.execute({ type: 'ApplyBuff', buffId: 'buff.test.spell-abnormal' }, context);
    runtime.execute({ type: 'ApplyBuff', buffId: dispel.buffId }, context);
    runtime.statusEffects.trigger({
        frame: 1,
        buffId: dispel.buffId,
        eventType: 'OnBuffTrigger'
    });
    assert.equal(runtime.statusEffects.has({
        targetId: 'pelica', buffId: 'buff.test.spell-abnormal'
    }), false);

    for (let index = 0; index < 3; index += 1) {
        runtime.execute(
            { type: 'ApplyBuff', buffId: 'buff.test.layers' },
            { ...context, frame: 2 + index }
        );
    }
    runtime.execute({
        type: 'FinishBuff',
        target: 'Target',
        buffId: 'buff.test.layers',
        finishAll: false,
        stackCount: 1
    }, { ...context, frame: 5 });
    assert.equal(
        runtime.statusEffects.list({ active: true, buffId: 'buff.test.layers' })[0].stackCount,
        2
    );
});

test('real global AuraAction applies assigned Buffs by faction and cleans them up', () => {
    const compiler = new AkeActionCompiler();
    const aura = compiler.compileBuff(readBuff('buff_chr_0003_endminf_talent_0_aura'));
    const targetBuff = compiler.compileBuff(readBuff('buff_chr_0003_endminf_talent_0'));
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'caster', kind: 'Character', team: 'ally' },
                { id: 'teammate', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                [aura.buffId]: aura,
                [targetBuff.buffId]: targetBuff
            }
        }
    });
    const context = {
        frame: 0,
        eventType: 'FixtureSetup',
        sourceId: 'caster',
        ownerId: 'caster',
        targetId: 'caster'
    };

    runtime.execute({
        type: 'ApplyBuff',
        buffId: aura.buffId,
        blackboard: { dmg: 0.25 }
    }, context);
    const auraTargets = runtime.statusEffects.list({
        active: true,
        buffId: targetBuff.buffId
    });
    assert.deepEqual(auraTargets.map(instance => instance.targetId).sort(), [
        'caster', 'teammate'
    ]);
    assert.equal(auraTargets[0].blackboard.dmg, 0.25);

    runtime.execute({
        type: 'FinishBuff',
        target: 'Target',
        buffId: aura.buffId
    }, { ...context, frame: 1 });
    assert.equal(runtime.statusEffects.has({
        targetId: 'caster', buffId: targetBuff.buffId
    }), false);
    assert.equal(runtime.statusEffects.has({
        targetId: 'teammate', buffId: targetBuff.buffId
    }), false);
});

test('single-target scenario compiles Chen ranged AuraAction to its context enemy', () => {
    const compiler = new AkeActionCompiler({
        capabilities: {
            damageResolver: true,
            timeDilationResolver: true,
            singleTargetSpatialBinding: true
        }
    });
    const program = compiler.compileSkill(readJson(
        'reference/public-data/akedata/Json/SkillData/chr_0005_chen_combo_skill.json'
    ));
    const aura = program.timeline.flatMap(group => group.actions)
        .find(action => action.type === 'CreateAura');

    assert.equal(aura.targetSelector.mode, 'ContextTarget');
    assert.equal(aura.targetSelector.faction, 'Anti');
    assert.ok(aura.definition.onApplyTargetActions.some(action =>
        action.type === 'ResolveDamagePacket'));
    assert.equal(program.compiler.unresolved.some(entry =>
        entry.code === 'AKE_AURA_TARGET_PROVIDER_REQUIRED'), false);
});

test('real damage decorate masks notify independent Chen talent hit branches', () => {
    const compiler = new AkeActionCompiler({ capabilities: { damageResolver: true } });
    const talent = compiler.compileBuff(readBuff('buff_chr_0005_chen_talent_0'));
    const trigger = compiler.compileBuff(readBuff('buff_chr_0005_chen_talent_0_1'));
    const branches = talent.abilityEventActions.find(group =>
        group.eventType === 'OnOutputDamage'
    ).actions;
    assert.deepEqual(branches.map(action => action.conditions[0].mask), [256, 512, 8192]);

    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'chen', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                {
                    id: 'enemy', kind: 'Enemy', team: 'enemy',
                    attributes: { Def: 0 },
                    vital: { maxHp: 10000, currentHp: 10000 }
                }
            ],
            buffs: { [talent.buffId]: talent, [trigger.buffId]: trigger }
        },
        damageResolver: createAkeDamageResolver()
    });
    const context = { frame: 0, sourceId: 'chen', ownerId: 'chen', targetId: 'enemy' };
    runtime.execute({
        type: 'ApplyBuff',
        buffId: talent.buffId,
        target: 'Source',
        blackboard: { atk: 0.1, duration: 5 },
        inheritEventBlackboard: false
    }, context);
    for (const [index, damageDecorateMask] of [512, 8192].entries()) {
        runtime.execute({
            type: 'ResolveDamagePacket',
            damageUnits: [{
                damageType: 'Physical',
                damageAttributeType: 'Hp',
                damageDecorateMask,
                scale: 1,
                calculationType: 'SimpleAtkScaleCalculation'
            }]
        }, { ...context, frame: index + 1 });
    }

    assert.equal(runtime.statusEffects.list({
        active: true, targetId: 'chen'
    }).find(instance => instance.buffId === trigger.buffId).stackCount, 2);
    assert.equal(runtime.context.getAttribute('chen', 'Atk'), 120);
    assert.ok(runtime.trace.some(entry => entry.eventType === 'OnOutputDamage'
        && entry.damageDecorateMask === 8192));
});

test('real Pograni weapon fans both ATB and added-combo Buff triggers across the team', () => {
    const compiler = new AkeActionCompiler();
    const passive = compiler.compilePassiveEventActions(readJson(
        'reference/public-data/akedata/Json/SkillData/sk_wpn_sword_0012.json'
    ), {
        blackboard: { atk_up2: 0.08, duration: 20, lv: 4, max_stack: 2 }
    });
    const attackBuff = compiler.compileBuff(readBuff('buff_wpn_sword_0012_atk_up'));
    const comboTrigger = compiler.compileBuff(readBuff('buff_common_affixes_combo_trigger'));
    const listener = {
        buffId: 'test:wpn_sword_0012:listener',
        lifeType: 'Infinity',
        blackboard: passive.blackboard,
        abilityEventActions: passive.groups
    };
    assert.equal(passive.compiler.status, 'executable');

    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'pograni', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                { id: 'teammate', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                [listener.buffId]: listener,
                [attackBuff.buffId]: attackBuff,
                [comboTrigger.buffId]: comboTrigger
            }
        }
    });
    const context = {
        frame: 0, sourceId: 'pograni', ownerId: 'pograni', targetId: 'enemy'
    };
    runtime.execute({
        type: 'ApplyBuff', buffId: listener.buffId, target: 'Source'
    }, context);
    runtime.execute({
        type: 'TriggerStatusEvent', eventType: 'OnObtainAtb', target: 'Source'
    }, {
        ...context,
        frame: 1,
        payload: { resourceSourceType: 'Skill', resourceGainMethod: 'Gain' }
    });
    runtime.execute({
        type: 'ApplyBuff', buffId: comboTrigger.buffId, target: 'Source'
    }, { ...context, frame: 2 });

    assert.ok(Math.abs(runtime.context.getAttribute('pograni', 'Atk') - 116) < 1e-12);
    assert.ok(Math.abs(runtime.context.getAttribute('teammate', 'Atk') - 116) < 1e-12);
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy', buffId: attackBuff.buffId
    }), false);
    assert.deepEqual(runtime.statusEffects.list({ active: true })
        .filter(instance => instance.buffId === attackBuff.buffId)
        .map(instance => [instance.targetId, instance.stackCount, instance.maxStacks])
        .sort(), [
        ['pograni', 2, 2],
        ['teammate', 2, 2]
    ]);
});

test('real Originum Frozen ignite damages first, then fans the Admin talent to teammates', () => {
    const compiler = new AkeActionCompiler({
        capabilities: {
            damageResolver: true,
            singleTargetSpatialBinding: true,
            timeDilationResolver: true
        }
    });
    const buffIds = [
        'buff_common_originum_frozen',
        'buff_chr_0003_endminf_talent_1',
        'buff_chr_0003_endminf_talent_1_tirgger',
        'buff_chr_0003_endminf_potential2'
    ];
    const buffs = Object.fromEntries(buffIds.map(buffId => {
        const definition = compiler.compileBuff(readBuff(buffId));
        return [definition.buffId, definition];
    }));
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'admin', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                { id: 'teammate', kind: 'Character', team: 'ally', attributes: { Atk: 100 } },
                {
                    id: 'enemy', kind: 'Enemy', team: 'enemy',
                    attributes: { Def: 0 },
                    vital: { maxHp: 10000, currentHp: 10000 }
                }
            ],
            buffs
        },
        damageResolver: createAkeDamageResolver()
    });
    const context = { frame: 0, sourceId: 'admin', ownerId: 'admin', targetId: 'enemy' };
    for (const buffId of [
        'buff_chr_0003_endminf_talent_1',
        'buff_chr_0003_endminf_potential2'
    ]) {
        runtime.execute({ type: 'ApplyBuff', buffId, target: 'Source' }, context);
    }
    runtime.execute({
        type: 'ApplyBuff',
        buffId: 'buff_common_originum_frozen',
        target: 'Target',
        blackboard: { atk_scale_trigger: 1 }
    }, context);
    runtime.execute({
        type: 'TriggerStatusEvent',
        eventType: 'EndminUlt',
        target: 'Target',
        sourceRef: 'Source'
    }, { ...context, frame: 1 });

    assert.equal(runtime.vitals.get('enemy').currentHp, 9900);
    assert.ok(Math.abs(runtime.context.getAttribute('admin', 'Atk') - 115) < 1e-12);
    assert.equal(runtime.context.getAttribute('teammate', 'Atk'), 107.5);
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy', buffId: 'buff_common_originum_frozen'
    }), false);
});

test('real EnergyShard ignite listener carries Buff layers into a reaction child Buff', () => {
    const compiler = new AkeActionCompiler();
    const attached = compiler.compileBuff(readBuff('buff_common_energy_shard_attached_pulse'));
    const childBuffId = 'buff_common_try_fire_pulse_triggered';
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'pelica', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            reactions: {
                Fire: {
                    threshold: 10,
                    maxBuildup: 10,
                    consumePolicy: 'threshold',
                    reactionId: 'reaction.fire-on-pulse',
                    igniteType: 'EnergyShardByFire'
                }
            },
            buffs: {
                [attached.buffId]: attached,
                [childBuffId]: { stackingPolicy: 'Refresh' }
            }
        }
    });
    const attachedContext = {
        eventType: 'AttachPulse',
        sourceId: 'pelica',
        ownerId: 'enemy',
        targetId: 'enemy'
    };
    runtime.execute(
        { type: 'ApplyBuff', buffId: attached.buffId },
        { ...attachedContext, frame: 0 }
    );
    runtime.execute(
        { type: 'ApplyBuff', buffId: attached.buffId },
        { ...attachedContext, frame: 1 }
    );

    runtime.execute({
        type: 'ApplyInfliction',
        element: 'Fire',
        amount: 10
    }, {
        frame: 2,
        eventType: 'FireInfliction',
        sourceId: 'pelica',
        ownerId: 'pelica',
        targetId: 'enemy'
    });

    const child = runtime.statusEffects.list({
        active: true,
        targetId: 'enemy',
        buffId: childBuffId
    })[0];
    assert.equal(child.blackboard.count, 2);
    assert.equal(child.blackboard.consumed_layer, 2);
    assert.equal(child.blackboard.consumed_type, 1);
});

test('real Pelica hit uses generic damage resolver and reversible defender zones', () => {
    const compiler = new AkeActionCompiler({ capabilities: { damageResolver: true } });
    const hitProgram = compiler.compileSkill(readJson(
        'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack1_projhit.json'
    ));
    const breakBuff = compiler.compileBuff(readBuff(
        'buff_common_poise_break_damage_taken_scale'
    ));
    const runtime = new CombatRuntime({
        damageResolver: createAkeDamageResolver(),
        definitions: {
            entities: [
                {
                    id: 'pelica',
                    kind: 'Character',
                    team: 'ally',
                    attributes: { Atk: 100 }
                },
                {
                    id: 'enemy',
                    kind: 'Enemy',
                    team: 'enemy',
                    attributes: { Def: 100, PulseResistance: 0 },
                    vital: { maxHp: 100, currentHp: 100 }
                }
            ],
            buffs: { [breakBuff.buffId]: breakBuff }
        }
    });
    const hitContext = {
        eventType: 'ProjectileHit',
        sourceId: 'pelica',
        ownerId: 'pelica',
        targetId: 'enemy',
        blackboard: { atk_scale: 0.25 }
    };
    runtime.execute({ type: 'ApplyBuff', buffId: breakBuff.buffId }, {
        frame: 0,
        eventType: 'PoiseBroken',
        sourceId: 'pelica',
        ownerId: 'enemy',
        targetId: 'enemy'
    });
    runtime.scheduleProgram(hitProgram, { ...hitContext, frame: 1 });
    runtime.runUntil(1);
    assert.equal(runtime.vitals.get('enemy').currentHp, 83.75);

    runtime.execute({
        type: 'FinishBuff',
        target: 'Target',
        buffId: breakBuff.buffId
    }, { ...hitContext, frame: 2 });
    runtime.scheduleProgram(hitProgram, { ...hitContext, frame: 3 });
    runtime.runUntil(3);
    assert.equal(runtime.vitals.get('enemy').currentHp, 71.25);
});

test('real Pelica root skill launches its child hit program with patched Blackboard', () => {
    const patchTable = readJson(
        'reference/public-data/akedata/TableCfg/SkillPatchTable.json'
    );
    const compiler = new AkeActionCompiler({
        capabilities: { damageResolver: true, skillProgramResolver: true }
    });
    const attack = compiler.compileSkill(readJson(
        'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack1.json'
    ), patchTable.chr_0004_pelica_attack1, { level: 1 });
    const hit = compiler.compileSkill(readJson(
        'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack1_projhit.json'
    ));
    const programs = new Map([[attack.skillId, attack], [hit.skillId, hit]]);
    const runtime = new CombatRuntime({
        damageResolver: createAkeDamageResolver(),
        skillProgramResolver: ({ skillId }) => programs.get(skillId),
        definitions: {
            entities: [
                {
                    id: 'pelica',
                    kind: 'Character',
                    team: 'ally',
                    attributes: { Atk: 100 },
                    resilience: {
                        maxResilience: 100,
                        currentResilience: 100,
                        superArmorLevel: 0
                    }
                },
                {
                    id: 'enemy',
                    kind: 'Enemy',
                    team: 'enemy',
                    attributes: { Def: 100, PulseResistance: 0 },
                    vital: { maxHp: 100, currentHp: 100 }
                }
            ]
        }
    });
    runtime.scheduleProgram(attack, {
        frame: 0,
        sourceId: 'pelica',
        ownerId: 'pelica',
        targetId: 'enemy'
    });

    runtime.runUntil(7);
    assert.equal(runtime.vitals.get('enemy').currentHp, 100);
    runtime.runUntil(8);
    assert.equal(runtime.vitals.get('enemy').currentHp, 87.5);
    assert.ok(runtime.trace.some(entry => entry.stage === 'SkillProgramScheduled'
        && entry.skillId === 'chr_0004_pelica_attack1_projhit'
        && entry.frame === 8));
});

test('real Zhuang Fangyi sword projectile preserves its generic reach child skill', () => {
    const compiler = new AkeActionCompiler({
        targetMappings: { Context: 'Target' },
        capabilities: { skillProgramResolver: true }
    });
    const program = compiler.compileSkill(readJson(
        'reference/public-data/akedata/Json/SkillData/chr_0030_zhuangfy_normal_skill.json'
    ));
    const launches = [];
    const visit = actions => {
        for (const action of actions ?? []) {
            if (action.type === 'LaunchSkillProgram') launches.push(action);
            for (const key of ['actions', 'success', 'failure']) visit(action[key]);
        }
    };
    for (const group of program.timeline) visit(group.actions);

    const swordLaunches = launches.filter(action => (
        action.childSkillId === 'chr_0030_zhuangfy_normal_skill_gene_sword_projhit'
    ));
    assert.ok(swordLaunches.length > 0);
    assert.ok(swordLaunches.every(action => action.projectileTerminalEvent === 'Reach'));
    assert.equal(
        program.compiler.unresolved.some(entry => entry.code === 'AKE_PROJECTILE_TERMINAL_SKILL_MISSING'),
        false
    );
});

test('TickIntervalAction compiles to cancellable immediate-and-periodic program ticks', () => {
    const compiler = new AkeActionCompiler();
    const compiled = compiler.compileActions([{
        $type: 'Beyond.Gameplay.Core.TickIntervalAction+Data, Gameplay.Beyond',
        isEnable: true,
        executeEachFrame: false,
        tickInterval: 0.2,
        useTickIntervalBlackboardKey: false,
        actionOnTick: {
            actionData: [{
                $type: 'Beyond.Gameplay.Core.ModifyDynamicBlackboard+Data, Gameplay.Beyond',
                isEnable: true,
                directValue: true,
                key: 'tick_count',
                operation: 'Add',
                value: { useBlackboardKey: false, value: 1, blackboardKey: '' }
            }]
        }
    }], {
        skillId: 'interval_fixture',
        timelineStartFrame: 10,
        timelineEndFrame: 27
    });
    assert.equal(compiled.unresolved.length, 0);
    assert.deepEqual(compiled.actions.map(action => action.type), ['ScheduleIntervalActions']);
    assert.equal(compiled.actions[0].durationTicks, 17);

    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'source', kind: 'Character', team: 'ally' },
                { id: 'target', kind: 'Enemy', team: 'enemy' }
            ]
        }
    });
    const scheduled = runtime.scheduleProgram({
        skillId: 'interval_fixture',
        blackboard: { tick_count: 0 },
        timeline: [{
            groupIndex: 0,
            startFrame: 10,
            endFrame: 27,
            actions: compiled.actions,
            cleanupActions: []
        }]
    }, {
        frame: 0,
        sourceId: 'source',
        ownerId: 'source',
        targetId: 'target'
    });
    runtime.runUntil(22);
    assert.deepEqual(
        runtime.effects.trace
            .filter(entry => entry.type === 'ModifyBlackboard')
            .map(entry => entry.frame),
        [10, 16, 22]
    );
    runtime.cancelProgramExecution(scheduled.executionId, 23, 'fixture-stop');
    runtime.runUntil(40);
    assert.equal(
        runtime.effects.trace.filter(entry => entry.type === 'ModifyBlackboard').length,
        3
    );
});

test('real equipment passive toggles its sourced Buff as HP condition changes', () => {
    const actionCompiler = new AkeActionCompiler();
    const passiveRaw = readJson(
        'reference/public-data/akedata/Json/SkillData/passive_rpg_equip_extra_main_up_at_full_hp.json'
    );
    const effect = new AkeLoadoutCompiler().compilePassiveSkill(passiveRaw, {
        blackboard: { value: 2 }
    });
    const unconditional = actionCompiler.compileBuff(readBuff('buff_equipsuit_atkup_01'));
    const conditional = actionCompiler.compileBuff(readBuff('buff_rpg_equip_main_up'));
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{
                id: 'pelica',
                kind: 'Character',
                team: 'ally',
                attributes: { Level: 10, Atk: 100 },
                vital: { maxHp: 100, currentHp: 100 }
            }],
            buffs: {
                [unconditional.buffId]: unconditional,
                [conditional.buffId]: conditional
            }
        }
    });
    const manager = new LoadoutEffectManager({ runtime });
    const installation = manager.install(effect, { ownerId: 'pelica' });
    assert.equal(runtime.context.getAttribute('pelica', 'Level'), 12);

    runtime.execute({ type: 'Damage', amount: 1 }, {
        frame: 1,
        eventType: 'ChipDamage',
        sourceId: 'pelica',
        ownerId: 'pelica',
        targetId: 'pelica'
    });
    manager.refresh(installation.key, 1);
    assert.equal(runtime.context.getAttribute('pelica', 'Level'), 10);

    runtime.execute({ type: 'Heal', amount: 1 }, {
        frame: 2,
        eventType: 'HealToFull',
        sourceId: 'pelica',
        ownerId: 'pelica',
        targetId: 'pelica'
    });
    manager.refresh(installation.key, 2);
    assert.equal(runtime.context.getAttribute('pelica', 'Level'), 12);
    manager.uninstall(installation.key, 3);
    assert.equal(runtime.context.getAttribute('pelica', 'Level'), 10);
});

test('real Buff timeline starts its child Buff at frame 21 and cancellation is source-safe', () => {
    const compiler = new AkeActionCompiler();
    const parent = compiler.compileBuff(readBuff(
        'buff_chr_0016_laevat_combo_skill_hit_self'
    ));
    const child = compiler.compileBuff(readBuff('buff_chr_0016_laevat_energy'));
    const makeRuntime = () => new CombatRuntime({
        definitions: {
            entities: [{
                id: 'laevat',
                kind: 'Character',
                team: 'ally',
                clockDomainId: 'laevat-clock'
            }],
            buffs: {
                [parent.buffId]: parent,
                [child.buffId]: child
            }
        }
    });
    const context = {
        frame: 0,
        eventType: 'ComboSkillHit',
        sourceId: 'laevat',
        ownerId: 'laevat',
        targetId: 'laevat',
        clockDomainId: 'laevat-clock'
    };

    const runtime = makeRuntime();
    runtime.execute({ type: 'ApplyBuff', buffId: parent.buffId }, context);
    runtime.runUntil(20);
    assert.equal(runtime.statusEffects.has({
        targetId: 'laevat',
        buffId: child.buffId
    }), false);
    runtime.runUntil(21);
    assert.equal(runtime.statusEffects.has({
        targetId: 'laevat',
        buffId: child.buffId
    }), true);

    const cancelled = makeRuntime();
    cancelled.execute({ type: 'ApplyBuff', buffId: parent.buffId }, context);
    cancelled.execute({
        type: 'FinishBuff',
        target: 'Target',
        buffId: parent.buffId
    }, { ...context, frame: 10, eventType: 'Interrupted' });
    cancelled.runUntil(21);
    assert.equal(cancelled.statusEffects.has({
        targetId: 'laevat',
        buffId: child.buffId
    }), false);
});

test('real HitStop timeline delegates curve integration to the injected local-clock adapter', () => {
    const compiler = new AkeActionCompiler({
        capabilities: { timeDilationResolver: true }
    });
    const hitStop = compiler.compileBuff(readBuff(
        'buff_chr_0016_laevat_combo_skill_hitstop'
    ));
    const requests = [];
    const runtime = new CombatRuntime({
        timeDilationResolver: request => {
            requests.push(request);
            return {
                status: 'ResolvedByTestAdapter',
                pauses: [{
                    domainId: request.eventContext.clockDomainId,
                    durationTicks: 2,
                    excludedTicks: 2,
                    reason: request.action.raw.curveKey
                }]
            };
        },
        definitions: {
            entities: [{
                id: 'laevat',
                kind: 'Character',
                team: 'ally',
                clockDomainId: 'laevat-clock'
            }],
            buffs: { [hitStop.buffId]: hitStop }
        }
    });
    runtime.execute({ type: 'ApplyBuff', buffId: hitStop.buffId }, {
        frame: 0,
        eventType: 'ComboSkillHit',
        sourceId: 'laevat',
        ownerId: 'laevat',
        targetId: 'laevat',
        clockDomainId: 'laevat-clock'
    });

    runtime.runUntil(24);
    assert.equal(requests.length, 0);
    runtime.runUntil(25);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].action.sourceType, 'HitStopAction');
    assert.equal(requests[0].action.raw.curveKey, 'char_normal_attack');
    assert.equal(requests[0].action.raw.duration, 0.2);
    const clocks = runtime.clockDomains.snapshot();
    assert.equal(clocks.byDomainId['laevat-clock'].totalPausedTicks, 2);
    assert.ok(clocks.trace.some(entry => entry.stage === 'ClockPaused'
        && entry.frame === 25
        && entry.reason === 'char_normal_attack'));
});
