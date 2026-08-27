import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { hasRuntimeAbilityEventProducer } from '../src/core/ability-event-producers.mjs';
import {
    CombatRuntime,
    SPELL_INFLICTION_TYPE_VALUES
} from '../src/core/combat-runtime.mjs';

const readJson = relativePath => JSON.parse(fs.readFileSync(
    new URL(`../${relativePath}`, import.meta.url),
    'utf8'
));

function actionTree(actions) {
    return (actions ?? []).flatMap(action => [
        action,
        ...actionTree(action.actions),
        ...actionTree(action.success),
        ...actionTree(action.failure)
    ]);
}

test('real weapon infliction listener compiles its skill and element gates', () => {
    const passive = new AkeActionCompiler().compilePassiveEventActions(readJson(
        'reference/public-data/akedata/Json/SkillData/sk_wpn_lance_0015.json'
    ), {
        blackboard: {
            atk_up: 0.06,
            fire_dmg_up: 0.06,
            duration: 20,
            duration2: 20,
            ultimate_gain_up: 0.18
        }
    });
    const inflictionGroup = passive.groups.find(group => (
        group.eventType === 'OnCharBeforeOutputSpellInfliction'
    ));
    const gate = actionTree(inflictionGroup.actions)
        .find(action => action.type === 'IfElseAction');

    assert.equal(hasRuntimeAbilityEventProducer(
        'OnCharBeforeOutputSpellInfliction'
    ), true);
    assert.equal(passive.compiler.status, 'executable');
    assert.deepEqual(inflictionGroup.unresolved, []);
    assert.deepEqual(gate.conditions, [{
        type: 'SkillTypeIs',
        skillType: ['NormalSkill', 'ComboSkill', 'UltimateSkill']
    }, {
        type: 'SpellInflictionTypeIs',
        spellInflictionTypes: ['Fire']
    }]);
});

test('the generic infliction condition preserves AKE enum values for saved-key users', () => {
    const runtime = new CombatRuntime({
        definitions: {
            entities: [{ id: 'source', kind: 'Character', team: 'ally' }]
        }
    });
    const transaction = runtime.effects.executeTransaction({
        type: 'IfElseAction',
        conditions: [{
            type: 'SpellInflictionTypeIs',
            spellInflictionTypes: ['All'],
            storeKey: 'capturedInflictionType'
        }],
        success: [{
            type: 'ModifyBlackboard',
            key: 'observedInflictionType',
            operation: 'Assign',
            value: { type: 'Blackboard', key: 'capturedInflictionType' }
        }],
        failure: []
    }, {
        frame: 0,
        sourceId: 'source',
        ownerId: 'source',
        targetId: 'source',
        blackboard: {},
        payload: {
            spellInflictionType: 'Cryst',
            spellInflictionTypeValue: SPELL_INFLICTION_TYPE_VALUES.Cryst
        }
    });

    assert.equal(transaction.eventContext.blackboard.capturedInflictionType, 2);
    assert.equal(transaction.eventContext.blackboard.observedInflictionType, 2);
});

function assembleCamilleWithWeapon() {
    return new AkeSquadScenarioAssembler().assemble({
        enemyId: 'eny_0007_mimicw',
        initialAtb: 300,
        members: [{
            memberId: 'camille',
            characterId: 'chr_0033_camille',
            weaponId: 'wpn_lance_0015',
            weaponLevel: 90,
            weaponPotential: 1,
            weaponSkillLevels: { skill1: 9, skill2: 4 }
        }, {
            memberId: 'pelica',
            characterId: 'chr_0004_pelica'
        }]
    });
}

function runCamilleNormalSkill(bundle) {
    return new AkeSquadScenarioRunner(bundle).run({
        commands: [{
            frame: 0,
            memberId: 'camille',
            commandType: 'NormalSkill'
        }],
        endFrame: 30
    });
}

test('Camille weapon passive is installed, fans to the team, and changes real damage', () => {
    const enabledBundle = assembleCamilleWithWeapon();
    const disabledBundle = assembleCamilleWithWeapon();
    disabledBundle.membersById.camille.loadoutEffects = disabledBundle
        .membersById.camille
        .loadoutEffects
        .filter(effect => effect.effectId !== 'sk_wpn_lance_0015');

    const enabled = runCamilleNormalSkill(enabledBundle);
    const disabled = runCamilleNormalSkill(disabledBundle);
    const applications = enabled.statusTrace.filter(entry => (
        entry.stage === 'StatusEffectApplied'
        && entry.buffId === 'buff_wpn_lance_0015_dmgup'
    ));
    const enabledFireHit = enabled.damageLog.find(hit => (
        hit.rootSkillId === 'chr_0033_camille_normal_skill'
        && hit.damageType === 'Fire'
    ));
    const disabledFireHit = disabled.damageLog.find(hit => (
        hit.rootSkillId === 'chr_0033_camille_normal_skill'
        && hit.damageType === 'Fire'
    ));
    const attachmentIndex = enabled.statusTrace.findIndex(entry => (
        entry.stage === 'StatusEffectApplied'
        && entry.buffId === 'buff_common_energy_shard_attached_fire'
    ));
    const lastWeaponBuffIndex = Math.max(...applications.map(application => (
        enabled.statusTrace.indexOf(application)
    )));

    assert.deepEqual(applications.map(entry => entry.targetId).sort(), [
        'chr_0004_pelica',
        'chr_0033_camille'
    ]);
    assert.ok(lastWeaponBuffIndex < attachmentIndex,
        'the before-output event must apply the weapon Buff before the attachment commits');
    assert.ok(enabledFireHit.finalDamage > disabledFireHit.finalDamage,
        'the visible weapon Buff must also participate in damage resolution');
    const weaponDamageContribution = enabledFireHit.modifierSnapshot
        .attackerZone
        .contributions
        .find(contribution => (
            contribution.buffId === 'buff_wpn_lance_0015_dmgup'
            && contribution.sourceType === 'StatusEffect'
        ));
    assert.ok(weaponDamageContribution,
        'the damage zone must retain the exact weapon Buff source for the UI');
    assert.equal(weaponDamageContribution.attribute, 'FireDamageIncrease');
    assert.equal(weaponDamageContribution.resolvedValue, 0.06);
    assert.equal(enabledFireHit.modifierSnapshot.attackerZone.scale, 1.24888889,
        'source provenance must not apply the aggregate attribute twice');
    assert.equal(disabled.statusTrace.some(entry => (
        entry.buffId === 'buff_wpn_lance_0015_dmgup'
    )), false);
});
