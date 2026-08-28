import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relativePath => JSON.parse(fs.readFileSync(
    path.join(root, relativePath),
    'utf8'
));

test('skill-scoped Buff lifetime belongs to ActionOwner', () => {
    const compiler = new AkeActionCompiler();
    const compiled = compiler.compileSkill(readJson(
        'reference/public-data/akedata/Json/SkillData/'
        + 'chr_0033_camille_normal_skill_abilityrange_first.json'
    ));
    const weakAction = compiled.timeline
        .flatMap(group => group.actions)
        .find(action => action.type === 'ApplyBuff'
            && action.buffs?.some(buff => (
                buff.buffId === 'buff_chr_0033_camille_normal_skill_weak'
            )));

    assert.equal(weakAction?.actionLifetime?.actorRef, 'Owner');
});

test('spawned ability entity keeps its action lifetime independent from the parent cast', () => {
    const childProgram = {
        skillId: 'skill.ability-entity-child',
        blackboard: {},
        timeline: [{
            groupIndex: 0,
            startFrame: 0,
            endFrame: 10,
            actions: [{
                type: 'ApplyBuff',
                target: 'Target',
                buffId: 'buff.ability-entity-child',
                actionLifetime: {
                    leaseKey: 'fixture:ability-entity-action',
                    actorRef: 'Owner',
                    inheritSkillIds: [],
                    finishByAction: true,
                    finishWithNextSkillIfNotInherited: true
                }
            }],
            cleanupActions: [{
                type: 'ReleaseBuffActionLifetime',
                target: 'Target',
                buffId: 'buff.ability-entity-child',
                leaseKey: 'fixture:ability-entity-action',
                finishAll: true
            }]
        }]
    };
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'actor', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                'buff.ability-entity-child': { lifeType: 'Infinity' }
            }
        },
        skillProgramResolver: ({ skillId }) => (
            skillId === childProgram.skillId ? childProgram : null
        )
    });
    const parentContext = {
        frame: 0,
        sourceId: 'actor',
        ownerId: 'actor',
        targetId: 'enemy',
        skillId: 'skill.parent',
        rootSkillId: 'skill.parent',
        castId: 'cast:parent'
    };

    const launched = runtime.execute({
        type: 'LaunchSkillProgram',
        abilityEntityId: 'abilityentity.fixture',
        childSkillId: childProgram.skillId
    }, parentContext);
    runtime.runUntil(0);

    const active = runtime.statusEffects.list({
        active: true,
        buffId: 'buff.ability-entity-child'
    })[0];
    assert.ok(active);
    assert.notEqual(launched.scheduled.castId, parentContext.castId);
    assert.equal(active.actionLifetime.ownerCastId, launched.scheduled.castId);
    assert.equal(active.actionLifetime.actorId, launched.spawnedAbilityEntityId);
    assert.equal(
        runtime.programExecutions.get(launched.scheduled.executionId)?.context.ownerId,
        launched.spawnedAbilityEntityId
    );

    runtime.finishSkillActionLifetimes({
        frame: 1,
        actorId: 'actor',
        skillId: parentContext.skillId,
        castId: parentContext.castId,
        reason: 'SkillCompleted'
    }, { ...parentContext, frame: 1 });
    runtime.beginSkillActionLifetimes({
        frame: 2,
        actorId: 'actor',
        skillId: 'skill.actor-next',
        castId: 'cast:actor-next'
    }, {
        ...parentContext,
        frame: 2,
        skillId: 'skill.actor-next',
        rootSkillId: 'skill.actor-next',
        castId: 'cast:actor-next'
    });
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy',
        buffId: 'buff.ability-entity-child'
    }), true);

    runtime.runUntil(10);
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy',
        buffId: 'buff.ability-entity-child'
    }), false);
});
