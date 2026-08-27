import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { AkeScenarioAssembler } from '../src/core/ake-scenario-assembler.mjs';
import { AkeScenarioRunner } from '../src/core/ake-scenario-runner.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';
import { SkillCooldownSystem } from '../src/core/skill-cooldown-system.mjs';

const AKE_JSON_URL = new URL(
    '../reference/public-data/akedata/Json/',
    import.meta.url
);

function findActions(root, expectedType) {
    const result = [];
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) return value.forEach(visit);
        if (String(value.$type ?? '').includes(`${expectedType}+Data`)) result.push(value);
        Object.values(value).forEach(visit);
    };
    visit(root);
    return result;
}

test('all public SetSkillCdAtOnce shapes compile to one generic cooldown transaction', () => {
    const compiler = new AkeActionCompiler();
    const compiled = [];
    for (const directory of ['SkillData', 'BuffData']) {
        const directoryUrl = new URL(`${directory}/`, AKE_JSON_URL);
        for (const fileName of readdirSync(directoryUrl).filter(name => name.endsWith('.json'))) {
            const raw = JSON.parse(readFileSync(new URL(fileName, directoryUrl), 'utf8'));
            for (const action of findActions(raw, 'SetSkillCdAtOnce')) {
                compiled.push(compiler.compileAction(action, {
                    path: `${directory}/${fileName}:SetSkillCdAtOnce`
                }));
            }
        }
    }

    assert.equal(compiled.length, 40);
    assert.equal(compiled.every(result => result.unresolved.length === 0), true);
    assert.equal(compiled.every(result =>
        result.actions.length === 1
        && result.actions[0].type === 'ModifySkillCooldown'
    ), true);
    assert.equal(compiled.some(result =>
        result.actions[0].operation === 'Set'
        && result.actions[0].isPercentage === false
        && result.actions[0].selector.skillId
    ), true);
    assert.equal(compiled.some(result =>
        result.actions[0].operation === 'Reduce'
        && result.actions[0].isPercentage === true
        && result.actions[0].selector.skillTypes?.includes('ComboSkill')
    ), true);
});

test('cooldown state is group-shared, actor-isolated and percentage reduction uses base cooldown', () => {
    const cooldowns = new SkillCooldownSystem({
        tickRate: 30,
        skills: [
            {
                actorId: 'actor-a', skillId: 'combo.base', skillType: 'ComboSkill',
                groupId: 'actor-a:ComboSkill', baseDurationTicks: 600
            },
            {
                actorId: 'actor-a', skillId: 'combo.enhanced', skillType: 'ComboSkill',
                groupId: 'actor-a:ComboSkill', baseDurationTicks: 0
            },
            {
                actorId: 'actor-b', skillId: 'combo.base', skillType: 'ComboSkill',
                groupId: 'actor-b:ComboSkill', baseDurationTicks: 600
            }
        ]
    });
    cooldowns.start({
        frame: 30,
        actorId: 'actor-a',
        skillId: 'combo.base',
        durationTicks: 600
    });

    assert.equal(cooldowns.getEndFrame('actor-a', 'combo.enhanced'), 630,
        'enhanced and base ids must read the same command-group cooldown');
    assert.equal(cooldowns.getEndFrame('actor-b', 'combo.base'), 0,
        'the same skill id on another actor must not share state');

    const reduced = cooldowns.modify({
        frame: 60,
        actorId: 'actor-a',
        selector: { skillTypes: ['ComboSkill'] },
        operation: 'Reduce',
        isPercentage: true,
        value: 0.5
    });
    assert.equal(reduced.results[0].requestedTicks, 300);
    assert.equal(reduced.results[0].actualTicks, 300);
    assert.equal(cooldowns.getEndFrame('actor-a', 'combo.base'), 330);

    cooldowns.modify({
        frame: 100,
        actorId: 'actor-a',
        selector: { skillId: 'combo.enhanced' },
        operation: 'Set',
        isPercentage: false,
        value: 3
    });
    assert.equal(cooldowns.getEndFrame('actor-a', 'combo.base'), 190);
    assert.equal(cooldowns.intervals()[0].endFrame, 190,
        'the UI interval must reflect the same mutated end frame as admission');

    const cleared = cooldowns.modify({
        frame: 160,
        actorId: 'actor-a',
        selector: { skillId: 'combo.base' },
        operation: 'Reduce',
        isPercentage: false,
        value: 10
    });
    assert.equal(cleared.results[0].actualTicks, 30);
    assert.equal(cleared.results[0].discardedTicks, 270);
    assert.equal(cooldowns.getEndFrame('actor-a', 'combo.enhanced'), 160);
});

test('real Chen listener reduces the live combo cooldown through the shared runtime', () => {
    const raw = JSON.parse(readFileSync(new URL(
        'SkillData/chr_0005_chen_combo_skill.json',
        AKE_JSON_URL
    ), 'utf8'));
    const listener = findActions(raw, 'EventListenerAction')[0];
    const compiled = new AkeActionCompiler().compileAction(listener, {
        path: 'chen.combo.listener',
        scope: 'skill',
        skillId: raw.skillId,
        timelineStartFrame: 0,
        timelineEndFrame: 100,
        blackboard: { cd_reduction: 0.2 }
    });
    assert.deepEqual(compiled.unresolved, []);

    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'chen', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            skillCooldowns: [{
                actorId: 'chen',
                skillId: raw.skillId,
                skillType: 'ComboSkill',
                groupId: 'chen:ComboSkill',
                baseDurationTicks: 480
            }]
        }
    });
    runtime.cooldowns.start({
        frame: 0,
        actorId: 'chen',
        skillId: raw.skillId,
        durationTicks: 480
    });
    runtime.scheduleProgram({
        skillId: raw.skillId,
        blackboard: { cd_reduction: 0.2 },
        timeline: [{
            groupIndex: 0,
            startFrame: 0,
            endFrame: 100,
            actions: compiled.actions,
            cleanupActions: compiled.cleanupActions
        }]
    }, {
        frame: 0,
        sourceId: 'chen',
        ownerId: 'chen',
        targetId: 'enemy',
        skillId: raw.skillId,
        rootSkillId: raw.skillId,
        skillType: 'ComboSkill',
        castId: 'cast:chen-combo'
    });
    runtime.runUntil(0);
    runtime.notifyAbilityEvent({
        frame: 10,
        eventType: 'OnBeforeOutputAirborne',
        sourceId: 'chen',
        ownerId: 'chen',
        targetId: 'enemy',
        listenerTargetId: 'chen'
    });

    assert.equal(runtime.cooldowns.getEndFrame('chen', raw.skillId), 384);
    const mutation = runtime.cooldowns.trace.find(entry =>
        entry.stage === 'CooldownModified'
    );
    assert.deepEqual({
        operation: mutation.operation,
        percentageBasis: mutation.percentageBasis,
        requestedTicks: mutation.requestedTicks,
        actualTicks: mutation.actualTicks
    }, {
        operation: 'Reduce',
        percentageBasis: 'BaseCooldown',
        requestedTicks: 96,
        actualTicks: 96
    });
});

test('single runner reads the same group cooldown for successive attack ids', () => {
    const bundle = new AkeScenarioAssembler().assemble({
        characterId: 'chr_0004_pelica',
        enemyId: 'eny_0007_mimicw'
    });
    bundle.programs.get('chr_0004_pelica_attack1').cooldownTicks = 60;
    const result = new AkeScenarioRunner(bundle).run({
        commands: [
            { frame: 0, commandType: 'Attack', commandId: 'attack-1' },
            { frame: 30, commandType: 'Attack', commandId: 'attack-2' }
        ],
        endFrame: 60
    });
    const second = result.commandTrace.find(entry =>
        entry.type === 'CommandExecuted' && entry.commandId === 'attack-2'
    );
    assert.equal(second.success, false);
    assert.equal(second.reason, 'COOLDOWN_ACTIVE');
    assert.equal(result.cooldownTrace[0].endFrame, 60);
    assert.equal(result.cooldownMutationTrace.some(entry =>
        entry.stage === 'CooldownStarted'
    ), true);
});
