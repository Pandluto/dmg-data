import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

function runtimeFixture() {
    return new CombatRuntime({
        definitions: {
            entities: [{
                id: 'attacker',
                kind: 'Character',
                team: 'ally'
            }, {
                id: 'enemy',
                kind: 'Enemy',
                team: 'enemy',
                attributes: { HpZeroEvents: 0 },
                vital: { maxHp: 100, currentHp: 100, allowRevive: true }
            }],
            buffs: {
                'fixture:hp-zero-listener': {
                    lifeType: 'Infinity',
                    abilityEventActions: [{
                        eventType: 'OnOwnerHpZero',
                        actions: [{
                            type: 'ModifyAttribute',
                            entity: 'Owner',
                            attribute: 'HpZeroEvents',
                            amount: 1
                        }]
                    }]
                }
            }
        },
        damageResolver: () => ({
            status: 'Resolved',
            hits: [{ damageAttributeType: 'Hp', amount: 50 }]
        })
    });
}

function eventContext(frame) {
    return {
        frame,
        eventType: 'Hit',
        sourceId: 'attacker',
        ownerId: 'attacker',
        targetId: 'enemy',
        skillId: 'fixture:skill',
        rootSkillId: 'fixture:skill',
        castId: `cast:${frame}`
    };
}

test('owner HP-zero is a target-scoped edge across direct and resolved damage', () => {
    const runtime = runtimeFixture();
    runtime.execute({
        type: 'ApplyBuff',
        target: 'Target',
        buffId: 'fixture:hp-zero-listener'
    }, eventContext(0));
    runtime.execute({ type: 'AddShield', target: 'Target', amount: 40 }, eventContext(0));

    runtime.execute({ type: 'Damage', target: 'Target', amount: 30 }, eventContext(1));
    assert.equal(runtime.context.getAttribute('enemy', 'HpZeroEvents'), 0,
        'shield-only damage is not an HP-zero edge');

    runtime.execute({ type: 'Damage', target: 'Target', amount: 110 }, eventContext(2));
    assert.equal(runtime.context.getAttribute('enemy', 'HpZeroEvents'), 1);
    assert.equal(runtime.vitals.get('enemy').currentHp, 0);
    runtime.execute({ type: 'Damage', target: 'Target', amount: 20 }, eventContext(3));
    assert.equal(runtime.context.getAttribute('enemy', 'HpZeroEvents'), 1,
        'additional corpse damage cannot repeat the edge');

    runtime.execute({
        type: 'Heal',
        target: 'Target',
        baseAmount: 50,
        revive: true
    }, eventContext(4));
    runtime.execute({
        type: 'ResolveDamagePacket',
        damageUnits: [{}]
    }, eventContext(5));
    assert.equal(runtime.context.getAttribute('enemy', 'HpZeroEvents'), 2,
        'a revived entity can cross the edge again through packet damage');

    const eventsAtFive = runtime.trace.filter(entry =>
        entry.stage === 'AbilityEventNotified' && entry.frame === 5
    ).map(entry => entry.eventType);
    assert.deepEqual(eventsAtFive, [
        'OnBeforeCalculateDamage',
        'OnBeforeOutputDamage',
        'OnBeforeTakeDamage',
        'OnOutputDamage',
        'OnTakeDamage',
        'OnOwnerHpZero',
        'OnAfterKillEntity'
    ]);
});

test('real HP-zero listeners compile while true-death listeners remain blocked', () => {
    const readBuff = buffId => JSON.parse(readFileSync(new URL(
        `../reference/public-data/akedata/Json/BuffData/${buffId}.json`,
        import.meta.url
    ), 'utf8'));
    const compiler = new AkeActionCompiler();
    const hpZero = compiler.compileBuff(readBuff(
        'buff_chr_0033_camille_normal_skill_listen_target_dead'
    ));
    const ownerDead = compiler.compileBuff(readBuff(
        'buff_chr_0032_lizhiyan_combo_skill_precheck'
    ));

    assert.equal(hpZero.abilityEventActions[0].unresolved.some(gap =>
        gap.code === 'AKE_ABILITY_EVENT_EMITTER_REQUIRED'
        && gap.abilityEvent === 'OnOwnerHpZero'
    ), false);
    assert.equal(ownerDead.abilityEventActions[0].unresolved.some(gap =>
        gap.code === 'AKE_ABILITY_EVENT_EMITTER_REQUIRED'
        && gap.abilityEvent === 'OnOwnerDead'
    ), true, 'HP zero must not masquerade as the later true-death commit');
});
