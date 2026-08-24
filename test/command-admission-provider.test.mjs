import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CommandAdmissionProvider } from '../src/core/command-admission-provider.mjs';

const semanticMappings = JSON.parse(readFileSync(new URL(
    '../spec/engine-semantic-mappings.json',
    import.meta.url
), 'utf8'));

function provider() {
    return new CommandAdmissionProvider({ semanticMappings });
}

function activeSkill({
    commandType,
    priority,
    interruptible = false,
    exclusiveFrames = 100,
    allowNextWindows = [],
    interruptMarks = []
}) {
    return {
        skillId: `active:${commandType}`,
        commandType,
        priority,
        interruptible,
        skill: { exclusiveFrames, allowNextWindows, interruptMarks }
    };
}

test('command profiles are loaded from evidence mappings instead of runner branches', () => {
    const admission = provider();
    assert.deepEqual([
        admission.profile('Attack').priority,
        admission.profile('NormalSkill').priority,
        admission.profile('ComboSkill').priority,
        admission.profile('UltimateSkill').priority
    ], [0, 2, 5, 7]);
    assert.equal(admission.profile('Attack').centerState, 'Attack');
    assert.equal(admission.profile('NormalSkill').centerState, 'Skill');
    assert.equal(admission.profile('BreakingAttack').priority, null);
    assert.equal(admission.profile('BreakingAttack').admissionMode, 'ExternalGate');
});

test('higher priority wins before an already-open interrupt marker', () => {
    const result = provider().evaluate({
        commandType: 'NormalSkill',
        skillId: 'next:normal',
        timelineFrame: 20,
        currentSkill: activeSkill({
            commandType: 'Attack',
            priority: 0,
            interruptible: true
        })
    });
    assert.equal(result.accepted, true);
    assert.equal(result.reason, 'HIGHER_PRIORITY');
    assert.equal(result.currentPriority, 0);
    assert.equal(result.newPriority, 2);
});

test('AllowNext admits a lower-priority skill selected by skill ID', () => {
    const result = provider().evaluate({
        commandType: 'NormalSkill',
        skillId: 'next:normal',
        timelineFrame: 30,
        currentSkill: activeSkill({
            commandType: 'ComboSkill',
            priority: 5,
            allowNextWindows: [{
                startFrame: 30,
                endFrame: 35,
                allowedSkillIds: ['next:normal']
            }]
        })
    });
    assert.equal(result.accepted, true);
    assert.equal(result.reason, 'ALLOWED_NEXT');
});

test('blocked commands retry at the earliest marker, window or exclusive frame', () => {
    const result = provider().evaluate({
        commandType: 'Attack',
        skillId: 'next:attack',
        timelineFrame: 30,
        currentSkill: activeSkill({
            commandType: 'NormalSkill',
            priority: 2,
            exclusiveFrames: 142,
            allowNextWindows: [{
                startFrame: 76,
                endFrame: 90,
                allowedSkillIds: ['next:attack']
            }],
            interruptMarks: [{ startFrame: 48 }]
        })
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'PRIORITY_BLOCK');
    assert.equal(result.nextTimelineFrame, 48);
});

test('MarkCanInterrupt retry is generic and not restricted to Attack input', () => {
    const result = provider().evaluate({
        commandType: 'NormalSkill',
        skillId: 'next:normal',
        timelineFrame: 12,
        currentSkill: activeSkill({
            commandType: 'UltimateSkill',
            priority: 7,
            exclusiveFrames: 120,
            interruptMarks: [{ startFrame: 40 }]
        })
    });
    assert.equal(result.accepted, false);
    assert.equal(result.nextTimelineFrame, 40);
});

test('BreakingAttack stays on its separately evidenced execution gate', () => {
    const result = provider().evaluate({
        commandType: 'BreakingAttack',
        skillId: 'next:execution',
        timelineFrame: 10,
        currentSkill: activeSkill({
            commandType: 'UltimateSkill',
            priority: 7
        })
    });
    assert.equal(result.accepted, true);
    assert.equal(result.reason, 'EXTERNAL_GATE');
    assert.equal(result.newPriority, null);
});

test('unknown command vocabulary fails closed', () => {
    assert.throws(() => provider().evaluate({
        commandType: 'ImaginarySkill',
        skillId: 'missing',
        timelineFrame: 0,
        currentSkill: null
    }), /Missing CommandAdmissionRule/);
});
