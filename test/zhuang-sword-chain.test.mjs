import assert from 'node:assert/strict';
import test from 'node:test';

import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';

const CHARACTER_ID = 'chr_0030_zhuangfy';
const ENEMY_ID = 'eny_0007_mimicw';
const PASSIVE_SKILL_ID = 'chr_0030_zhuangfy_check_sword_passive';
const PASSIVE_BUFF_ID = 'buff_chr_0030_zhuangfy_passive_check_sword';
const ORDINARY_SKILL_ID = 'chr_0030_zhuangfy_normal_skill';
const ENHANCED_SKILL_ID = 'chr_0030_zhuangfy_normal_skill_ult';

function assemble() {
    return new AkeSquadScenarioAssembler().assemble({
        enemyId: ENEMY_ID,
        members: [{ memberId: 'zhuang', characterId: CHARACTER_ID }]
    });
}

function passiveStatus(result) {
    return result.finalState.statuses.find(status => status.buffId === PASSIVE_BUFF_ID);
}

function hpHits(result, rootSkillId) {
    return result.damageLog.filter(hit =>
        hit.rootSkillId === rootSkillId && hit.damageAttributeType === 'Hp'
    );
}

test('Zhuang Fangyi sword damage is resolved through the generic intrinsic-passive chain', () => {
    const bundle = assemble();
    const passive = bundle.members[0].intrinsicPassives.find(entry =>
        entry.skillId === PASSIVE_SKILL_ID
    );
    assert.ok(passive);
    assert.deepEqual(passive.buffs.map(entry => entry.buffId), [PASSIVE_BUFF_ID]);

    const swordTagRule = bundle.semanticMappings.find(mapping =>
        mapping.id === 'akedata.zhuangfy.sword-ability-entity-tags'
    );
    assert.deepEqual(swordTagRule?.effect?.tagIds, [-13979809]);

    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [{ memberId: 'zhuang', frame: 0, commandType: 'NormalSkill' }],
        endFrame: 40
    });
    const hits = hpHits(result, ORDINARY_SKILL_ID);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].frame, 28);
    assert.equal(hits[0].targetId, ENEMY_ID);
    assert.ok(hits[0].finalDamage > 0);

    const status = passiveStatus(result);
    assert.equal(status?.blackboard?.EntityBB_SwordNum, 1);
    assert.equal(status?.blackboard?.__akeTargetGroups?.swordsInRange?.length, 1);
});

test('Zhuang Fangyi enhanced skill keeps its delayed settlement separate from sword counting', () => {
    const result = new AkeSquadScenarioRunner(assemble()).run({
        commands: [
            { memberId: 'zhuang', frame: 0, commandType: 'UltimateSkill' },
            { memberId: 'zhuang', frame: 210, commandType: 'NormalSkill' }
        ],
        endFrame: 260
    });
    const transformed = result.commandTrace.filter(entry =>
        entry.type === 'CommandExecuted' && entry.frame === 210
    ).at(-1);
    assert.equal(transformed?.skillId, ENHANCED_SKILL_ID);
    assert.equal(transformed?.skillSource, 'skill-form-override');

    const hits = hpHits(result, ENHANCED_SKILL_ID);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].frame, 242);
    assert.equal(hits[0].targetId, ENEMY_ID);
    assert.ok(hits[0].finalDamage > 0);

    const status = passiveStatus(result);
    assert.equal(status?.blackboard?.EntityBB_SwordNum, 1);
    assert.equal(status?.blackboard?.__akeTargetGroups?.swordsInRange?.length, 1);
});
