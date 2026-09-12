import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAkeOperationOrder } from '../src/core/ake-operation-order.mjs';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner, runAkeSquadScenario } from '../src/core/ake-squad-scenario-runner.mjs';
import { simulateSquadDemo, DemoInputError } from '../demo/demo-service.mjs';

const members = [
    { memberId: 'p', characterId: 'chr_0004_pelica' },
    { memberId: 'c', characterId: 'chr_0005_chen' },
];
const base = { operationOrderVersion: 1, endFrame: 150, commands: [
    { commandId: 'source', memberId: 'p', commandType: 'Attack', frame: 0, operationOrder: 10 },
], operatorSwitches: [] };
let bundle;
const getBundle = () => bundle ??= new AkeSquadScenarioAssembler().assemble({ members, enemyId: 'eny_0007_mimicw' });

test('v1 invalid inputs fail in the parser, direct runner, convenience runner and demo adapter', () => {
    const invalid = [
        { ...base, operationOrderVersion: 0 }, { ...base, operationOrderVersion: 2 },
        { ...base, operationOrderVersion: null }, { ...base, operationOrderVersion: '1' },
        { ...base, operationOrderVersion: undefined },
        ...[undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map(operationOrder => ({
            ...base, commands: [{ ...base.commands[0], operationOrder }],
        })),
        { ...base, commands: [{ ...base.commands[0], timelineOrder: 0 }] },
        { ...base, commands: [{ ...base.commands[0], commandId: undefined }] },
        { ...base, operatorSwitches: [{ switchId: 's', characterId: members[0].characterId, frame: 0, operationOrder: 10 }] },
        { ...base, operatorSwitches: [{ switchId: 'source', characterId: members[0].characterId, frame: 0, operationOrder: 11 }] },
        { ...base, operatorSwitches: [{ switchId: 's', characterId: members[0].characterId, frame: 0, operationOrder: 11, timelineOrder: undefined }] },
    ];
    for (const input of invalid) {
        assert.throws(() => parseAkeOperationOrder(input), TypeError);
        assert.throws(() => new AkeSquadScenarioRunner(getBundle()).run(input), TypeError);
        assert.throws(() => runAkeSquadScenario(getBundle(), { run: input }), TypeError);
        assert.throws(() => simulateSquadDemo({ ...input, members }), DemoInputError);
    }
});

test('empty v1 and sparse safe integer orders are valid; v0 is not upgraded', () => {
    assert.equal(parseAkeOperationOrder({ commands: [], operatorSwitches: [] }).version, undefined);
    const empty = runAkeSquadScenario(getBundle(), { operationOrderVersion: 1, endFrame: 0 });
    assert.equal(empty.scenario.operationOrderVersion, 1);
    assert.equal(parseAkeOperationOrder({ ...base, commands: [{ ...base.commands[0], operationOrder: Number.MAX_SAFE_INTEGER }] }).isV1, true);
});

test('submission trace reports the versioned order while preserving legacy metadata', () => {
    const v1 = runAkeSquadScenario(getBundle(), base).commandTrace.find(e => e.type === 'CommandSubmitted');
    assert.deepEqual([v1.sameFrameOrderKey, v1.operationOrderVersion, v1.operationOrder], [10, 1, 10]);
    const { operationOrder: unusedOrder, ...command } = base.commands[0];
    const v0 = runAkeSquadScenario(getBundle(), { commands: [command], endFrame: base.endFrame })
        .commandTrace.find(e => e.type === 'CommandSubmitted');
    assert.equal(v0.sameFrameOrderKey, 'p');
    assert.equal(Object.hasOwn(v0, 'operationOrderVersion'), false);
    assert.equal(Object.hasOwn(v0, 'operationOrder'), false);
});

test('same-source zero-delay successors order switches and commands after the cause, independent of arrays', () => {
    const dependency = { kind: 'action-start', sourceCommandId: 'source', delayFrames: 0 };
    const input = { ...base, commands: [
        ...base.commands,
        { commandId: 'child', memberId: 'c', commandType: 'Attack', frame: 100,
            operationOrder: 3, releaseDependency: dependency },
    ], operatorSwitches: [
        { switchId: 'last', characterId: members[0].characterId, frame: 100, operationOrder: 4, releaseDependency: dependency },
        { switchId: 'first', characterId: members[1].characterId, frame: 100, operationOrder: 2, releaseDependency: dependency },
    ] };
    const result = runAkeSquadScenario(getBundle(), input);
    const reversed = runAkeSquadScenario(getBundle(), { ...input,
        commands: [...input.commands].reverse(), operatorSwitches: [...input.operatorSwitches].reverse() });
    assert.deepEqual(reversed, result);
    const switches = result.controllerTrace.filter(entry => entry.switchId);
    assert.deepEqual(switches.map(entry => entry.switchId), ['first', 'last']);
    const resolved = result.commandTrace.find(entry => entry.type === 'ReleaseAnchorResolved' && entry.commandId === 'child');
    assert.equal(resolved.frame, 0);
    const executed = result.commandTrace.filter(entry => entry.type === 'CommandExecuted');
    assert.deepEqual(executed.map(entry => entry.commandId), ['source', 'child']);
    assert.ok(result.commandTrace.indexOf(resolved) > result.commandTrace.indexOf(executed[0]));
});

test('a lower order cannot run before its later cause or reorder separate ready batches', () => {
    const input = { operationOrderVersion: 1, commands: [], endFrame: 100, operatorSwitches: [
        { switchId: 'future-child', characterId: members[0].characterId, frame: 0, operationOrder: 0,
            releaseDependency: { kind: 'action-end', sourceCommandId: 'future', delayFrames: 0 } },
        { switchId: 'now-child', characterId: members[0].characterId, frame: 0, operationOrder: 1,
            releaseDependency: { kind: 'action-end', sourceCommandId: 'now', delayFrames: 0 } },
        { switchId: 'future', characterId: members[1].characterId, frame: 40, operationOrder: 2 },
        { switchId: 'now', characterId: members[1].characterId, frame: 20, operationOrder: 3 },
    ] };
    const result = runAkeSquadScenario(getBundle(), input);
    assert.deepEqual(result.controllerTrace.filter(e => e.switchId).map(e => [e.switchId, e.frame]),
        [['now', 20], ['now-child', 20], ['future', 40], ['future-child', 40]]);
    const sameFrame = structuredClone(input);
    sameFrame.operatorSwitches[0].operationOrder = 1;
    sameFrame.operatorSwitches[1].operationOrder = 0;
    sameFrame.operatorSwitches[2].frame = 20;
    const sameFrameResult = runAkeSquadScenario(getBundle(), sameFrame);
    assert.deepEqual(sameFrameResult.controllerTrace.filter(e => e.switchId).map(e => e.switchId),
        ['future', 'now', 'future-child', 'now-child'],
        'children from separately occurring source events retain ready-batch chronology, not global order');
    const cyclic = structuredClone(input);
    cyclic.operatorSwitches[2].releaseDependency = { kind: 'action-end', sourceCommandId: 'future-child', delayFrames: 0 };
    assert.throws(() => runAkeSquadScenario(getBundle(), cyclic), /cycl/i);
});
