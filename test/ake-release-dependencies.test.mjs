import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { simulateSquadDemo } from '../demo/demo-service.mjs';

const saved = JSON.parse(readFileSync(new URL('../fixtures/ria/wulfa-camille-appended-ultimate.json', import.meta.url))).input;
const current = (delta = 0) => {
    const input = structuredClone(saved);
    // The archived fixture starts E1 at 94; the restored experiment starts at 62.
    for (const command of input.commands) if (command.frame > 0) command.frame += delta - 32;
    return input;
};
const executed = (result, id) => result.commands.find(command => command.commandId === id);
const T = 'chr_0027_tangtang';
const L = 'chr_0026_lastrite';
const members = [T, L].map(characterId => ({ characterId, memberId: characterId, level: 90, skillLevel: 12 }));
const smallRun = overrides => simulateSquadDemo({ members, initialControllerCharacterId: L,
    commands: [], endFrame: 500, ...overrides });

test('v1 actual hit fanout orders ready switches and commands without moving them before the hit', () => {
    const releaseDependency = { kind: 'damage-hit', sourceCommandId: 'attack',
        sourceSkillId: `${L}_attack4`, sourceTimelineFrame: 21, delayFrames: 0 };
    const input = { operationOrderVersion: 1, commands: [
        { commandId: 'attack', memberId: L, commandType: 'Attack', attackMode: 'full-combo', frame: 0, operationOrder: 9 },
        { commandId: 'infuse', memberId: L, commandType: 'NormalSkill', frame: 400, operationOrder: 2, releaseDependency },
    ], operatorSwitches: [
        { switchId: 'last', characterId: T, frame: 400, operationOrder: 3, releaseDependency },
        { switchId: 'first', characterId: L, frame: 400, operationOrder: 1, releaseDependency },
    ] };
    const result = smallRun(input);
    assert.equal(executed(result, 'infuse').actualFrame, 106);
    assert.equal(executed(result, 'infuse').endFrame, 106, 'infusion executes before handoff and preserves the attack');
    assert.deepEqual(result.controllerEvents.filter(e => e.switchId).map(e => [e.switchId, e.frame]), [['first', 106], ['last', 106]]);
    const reversed = smallRun({ ...input, commands: [...input.commands].reverse(), operatorSwitches: [...input.operatorSwitches].reverse() });
    for (const key of ['commands', 'controllerEvents', 'hits', 'statusEvents', 'resourceEvents', 'finalState']) {
        assert.deepEqual(reversed[key], result[key], key);
    }
});

// Real inputs/raw programs through the browser's entry point: an old frame hint
// must not become a lower bound when moving the whole source sequence earlier.
test('Camille last impact + 6 follows F395 in both directions and retains two-stack consumption', () => {
    for (const delta of [-20, 0, 20]) {
        const input = current(delta);
        input.commands.find(command => command.commandId === 'v605nh6s1').frame = 700;
        const result = simulateSquadDemo(input);
        const ultimate = executed(result, 'v605nh6s1');
        assert.equal(ultimate.success, true);
        assert.equal(ultimate.actualFrame, 401 + delta);
        const source = executed(result, '7k8i2b6rg');
        assert.ok(result.hits.some(hit => hit.rootCastId === source.castId && hit.frame === 395 + delta));
        assert.ok(result.teamComboLedger.settlements.some(event => event.commandId === 'v605nh6s1'
            && event.consumedStacks === 2));
    }
});

test('action end, same-frame switch, and landing resolve as one causal chain', () => {
    for (const start of [0, 60]) {
        const result = smallRun({ commands: [
            { commandId: 'q', memberId: T, commandType: 'UltimateSkill', frame: start },
            { commandId: 'landing', memberId: T, commandType: 'Attack', attackMode: 'plunging-impact',
                frame: 400, releaseDependency: { kind: 'action-end', sourceCommandId: 'switch', delayFrames: 0 } },
        ], operatorSwitches: [{ switchId: 'switch', characterId: T, frame: 400,
            releaseDependency: { kind: 'action-end', sourceCommandId: 'q', delayFrames: 0 } }] });
        const source = executed(result, 'q');
        assert.equal(executed(result, 'landing').actualFrame, source.endFrame);
        assert.equal(executed(result, 'landing').success, true);
        assert.equal(result.controllerEvents.find(event => event.switchId === 'switch').frame, source.endFrame);
    }
});

test('action-start keeps its offset, while an inadmissible same-actor input is rejected without queueing', () => {
    const result = smallRun({ initialControllerCharacterId: T, commands: [
        { commandId: 'q', memberId: T, commandType: 'UltimateSkill', frame: 30 },
        { commandId: 'early-landing', memberId: T, commandType: 'Attack', attackMode: 'plunging-impact',
            frame: 300, releaseDependency: { kind: 'action-start', sourceCommandId: 'q', delayFrames: 3 } },
        { commandId: 'other', memberId: L, commandType: 'NormalSkill', frame: 300,
            releaseDependency: { kind: 'action-start', sourceCommandId: 'q', delayFrames: 3 } },
    ] });
    assert.equal(executed(result, 'other').actualFrame, 33);
    assert.equal(executed(result, 'early-landing').success, false);
    assert.equal(executed(result, 'early-landing').reason, 'PLUNGING_IMPACT_BLOCKED');
});

function withPrecision(delta = 0, offset = 57) {
    const input = current(delta);
    const command = input.commands.find(command => command.commandId === 'j1xnfsn7v');
    command.frame = 700;
    command.releaseDependency = { kind: 'timed-input', sourceCommandId: '1j9udz734',
        sourceOffsetFrames: offset, delayFrames: 0, windowKind: 'precision',
        sourceSkillId: 'chr_0028_wulfa_combo_2_skill',
        windowStartOffsetFrames: 52, windowEndOffsetFramesExclusive: 64 };
    return input;
}

test('precision input follows the source cast and validates the actual half-open window', () => {
    for (const delta of [0, 20]) {
        const result = simulateSquadDemo(withPrecision(delta));
        assert.equal(executed(result, 'j1xnfsn7v').actualFrame, 119 + delta);
        assert.equal(result.timeline.timedInputWindows[0].resolvedFrame, 119 + delta);
    }
    const expired = simulateSquadDemo(withPrecision(0, 64));
    assert.equal(executed(expired, 'j1xnfsn7v').reason, 'RELEASE_WINDOW_EXPIRED');
    const wrongSource = withPrecision();
    wrongSource.commands.find(command => command.commandId === 'j1xnfsn7v')
        .releaseDependency.sourceSkillId = 'another-skill';
    assert.equal(executed(simulateSquadDemo(wrongSource), 'j1xnfsn7v').reason, 'RELEASE_WINDOW_NOT_ACTIVE');
});

test('broad input stays non-precise and does not drift to the later precision interval', () => {
    const input = withPrecision(0, 40);
    const command = input.commands.find(command => command.commandId === 'j1xnfsn7v');
    Object.assign(command.releaseDependency, { windowKind: 'broad', windowStartOffsetFrames: 37,
        windowEndOffsetFramesExclusive: 217 });
    const result = simulateSquadDemo(input);
    assert.equal(executed(result, 'j1xnfsn7v').actualFrame, 102);
    assert.equal(result.timeline.timedInputWindows[0].resolvedFrame, null);
});

test('failed source and cross-kind dependency cycles never manufacture a release', () => {
    const result = smallRun({ members: members.map(member => ({ ...member, initialUltimateSp: 0 })), commands: [
        { commandId: 'q', memberId: T, commandType: 'UltimateSkill', frame: 0 },
        { commandId: 'next', memberId: L, commandType: 'NormalSkill', frame: 0,
            releaseDependency: { kind: 'action-end', sourceCommandId: 'q', delayFrames: 0 } },
    ] });
    assert.equal(executed(result, 'q').success, false);
    assert.equal(executed(result, 'next').reason, 'RELEASE_ANCHOR_NOT_REACHED');
    assert.throws(() => smallRun({ commands: [
        { commandId: 'a', memberId: L, commandType: 'NormalSkill', frame: 0,
            releaseDependency: { kind: 'action-end', sourceCommandId: 'switch', delayFrames: 0 } },
    ], operatorSwitches: [{ switchId: 'switch', characterId: T, frame: 0,
        releaseDependency: { kind: 'action-end', sourceCommandId: 'a', delayFrames: 0 } }] }), /cycle/);
});

test('a full basic attack ends once after its final stage, rather than after stage one', () => {
    const result = smallRun({ commands: [
        { commandId: 'attack', memberId: L, commandType: 'Attack', attackMode: 'full-combo', frame: 0 },
        { commandId: 'next', memberId: T, commandType: 'NormalSkill', frame: 0,
            releaseDependency: { kind: 'action-end', sourceCommandId: 'attack', delayFrames: 3 } },
    ] });
    assert.equal(executed(result, 'attack').endFrame, 131);
    assert.equal(executed(result, 'next').actualFrame, 134);
});
