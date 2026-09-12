import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateSquadDemo } from '../demo/demo-service.mjs';

const lastrite = 'chr_0026_lastrite';
const tangtang = 'chr_0027_tangtang';
const members = [lastrite, tangtang].map(characterId => ({ memberId: characterId,
    characterId, level: 90, skillLevel: 12, initialUltimateSp: 0 }));
const attack = { memberId: lastrite, commandId: 'attack', commandType: 'Attack',
    attackMode: 'full-combo', frame: 0 };
const infuse = { memberId: lastrite, commandId: 'infuse', commandType: 'NormalSkill', frame: 50 };
const run = input => simulateSquadDemo({ members, initialControllerCharacterId: lastrite,
    commands: [], endFrame: 500, ...input });
const hpHits = result => result.hits.filter(hit => hit.damageAttributeType === 'Hp');
const pursuit = result => hpHits(result).filter(hit => hit.sourceBuffId?.includes('_phantom'));
const direct = result => hpHits(result).filter(hit => !hit.sourceBuffId);

// Real raw SkillData and BuffData, through the same entry point as the browser.
test('only the current controller consumes Last Rite infusion, including mid-attack switches', () => {
    const commands = [{ ...infuse, frame: 0 }, { ...attack, frame: 180 }];
    assert.equal(pursuit(run({ commands })).length, 2);
    assert.equal(pursuit(run({ commands, initialControllerCharacterId: tangtang })).length, 0);
    const leave = run({ commands, operatorSwitches: [{ characterId: tangtang, frame: 250 }] });
    assert.equal(pursuit(leave).length, 0, 'a delayed heavy hit must read control at impact');
    const arrive = run({ commands, initialControllerCharacterId: tangtang,
        operatorSwitches: [{ characterId: lastrite, frame: 250 }] });
    assert.equal(pursuit(arrive).length, 2, 'the Buff must also allow a newly controlled attacker');
    assert.equal(arrive.finalState.mainCharacterId, lastrite);
    assert.equal(arrive.controllerEvents.at(-1).frame, 250);
    assert.equal(pursuit(run({ commands })).length, 2, 'another run cannot mutate cached entity control');
});

test('raw Buff-cast replacement preserves all original attack hits and charges its own resources once', () => {
    const baseline = direct(run({ commands: [attack] })).map(hit => [hit.frame, hit.expectedDamage]);
    assert.equal(baseline.length, 6);
    for (const frame of [50, 95]) {
        const result = run({ commands: [attack, { ...infuse, frame }] });
        assert.deepEqual(direct(result).map(hit => [hit.frame, hit.expectedDamage]), baseline);
        assert.equal(pursuit(result).length, 2);
        assert.deepEqual(result.commands.map(command => [command.actualFrame, command.endFrame]), [[0, 131], [frame, frame]]);
        assert.equal(result.resourceEvents.filter(event => event.reason === 'CastCost').length, 1);
        assert.equal(result.finalState.ultimateSpByCharacterId[lastrite], 16);
        assert.ok(result.finalState.ultimateSpByCharacterId[tangtang] > 6.49);
        assert.ok(result.finalState.ultimateSpByCharacterId[tangtang] < 6.51);
    }
});

test('a zero-time switch before or after the same-frame infusion has different real effects', () => {
    const commands = [attack, { ...infuse, timelineOrder: 10 }];
    const before = run({ commands, operatorSwitches: [{ characterId: tangtang, frame: 50, timelineOrder: 5 }] });
    const after = run({ commands, operatorSwitches: [{ characterId: tangtang, frame: 50, timelineOrder: 20 }] });
    assert.equal(direct(before).length, 3, 'off-field cast uses the ordinary skill animation');
    assert.equal(direct(after).length, 6, 'infusion before handoff preserves the existing combo');
    assert.equal(after.commands[1].endFrame, 50);
});

test('v1 same-frame handoff consumes logical order and survives transport array reversal', () => {
    const commands = [{ ...attack, operationOrder: 0 }, { ...infuse, operationOrder: 10 }];
    for (const [order, expectedHits] of [[5, 3], [20, 6]]) {
        const input = { operationOrderVersion: 1, commands,
            operatorSwitches: [{ switchId: 'handoff', characterId: tangtang, frame: 50, operationOrder: order }] };
        const result = run(input);
        assert.equal(direct(result).length, expectedHits);
        const reversed = run({ ...input, commands: [...commands].reverse() });
        for (const key of ['commands', 'hits', 'controllerEvents', 'statusEvents', 'resourceEvents', 'finalState']) {
            assert.deepEqual(reversed[key], result[key], key);
        }
        assert.equal(result.operationOrderVersion, 1);
        assert.deepEqual(result.operationOrders.map(entry => entry.operationOrder), [0, order, 10].sort((a, b) => a - b));
    }
});

test('a switch anchored to a real heavy impact waits for the resolved hit', () => {
    const result = run({ commands: [attack], operatorSwitches: [{ switchId: 'handoff',
        characterId: tangtang, frame: 0, releaseDependency: { kind: 'damage-hit',
            sourceCommandId: 'attack', sourceSkillId: `${lastrite}_attack4`,
            sourceTimelineFrame: 21, delayFrames: 2 } }] });
    const event = result.controllerEvents.find(event => event.switchId === 'handoff');
    assert.equal(event.stage, 'MainCharacterChanged');
    assert.equal(event.frame, 108);
});

test('Last Rite accepts her tagged skill recovery and rejects generic teammate recovery', () => {
    const normalSkill = run({ commands: [{ ...infuse, frame: 0 }] });
    assert.equal(normalSkill.finalState.ultimateSpByCharacterId[lastrite], 16);
    const teammate = run({ initialControllerCharacterId: tangtang,
        commands: [{ ...infuse, memberId: tangtang, frame: 0 }] });
    assert.equal(teammate.finalState.ultimateSpByCharacterId[lastrite], 0);
    assert.ok(teammate.finalState.ultimateSpByCharacterId[tangtang] > 0);
});


test('infusion only replaces the cast strictly before the real attack occupation ends', () => {
    const inside = run({ commands: [attack, { ...infuse, frame: 130 }] });
    assert.equal(inside.commands[1].endFrame, 130);
    for (const frame of [131, 132, 140]) {
        const alone = run({ commands: [{ ...infuse, frame }] });
        const afterAttack = run({ commands: [attack, { ...infuse, frame }] });
        assert.equal(afterAttack.commands[1].endFrame, alone.commands[0].endFrame);
        assert.ok(afterAttack.commands[1].endFrame > frame);
        assert.equal(afterAttack.commands[0].completion, 'Completed');
    }
});
