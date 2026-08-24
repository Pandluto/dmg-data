import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { createAkeDamageResolver } from '../src/core/ake-damage-resolver.mjs';
import {
    AkeLoadoutCompiler,
    LoadoutEffectManager
} from '../src/core/ake-loadout-compiler.mjs';
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

test('real public BuffData executes periodic healing and exact USP quantization', () => {
    const mappings = readJson('spec/engine-semantic-mappings.json');
    const compiler = new AkeActionCompiler({ semanticMappings: mappings });
    const heal = compiler.compileBuff(readBuff('buff_common_heal_moss_1'));
    const usp = compiler.compileBuff(readBuff('buff_common_obtain_ultimate_sp'));
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{
                id: 'pelica',
                kind: 'Character',
                team: 'ally',
                vital: { maxHp: 100, currentHp: 10 }
            }],
            resources: [{
                id: 'pelica:UltimateSp',
                resourceType: 'UltimateSp',
                scope: 'Entity',
                ownerId: 'pelica',
                initial: 0,
                max: 100
            }],
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
