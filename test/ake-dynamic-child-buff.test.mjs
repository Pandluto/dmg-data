import assert from 'node:assert/strict';
import test from 'node:test';

import { AkeActionCompiler } from '../src/core/ake-action-compiler.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

test('CreateBuffAction retains a runtime Blackboard Buff id and its static dependency', () => {
    const compiler = new AkeActionCompiler({
        capabilities: { dynamicBuffIdResolver: true }
    });
    const compiled = compiler.compileActions([{
        $type: 'Beyond.Gameplay.Core.CreateBuffAction+Data, Gameplay.Beyond',
        buffs: [{
            buffId: '',
            readIdFromBlackboard: true,
            buffIdKey: 'child_buff_id',
            assignBlackboard: false,
            assignItems: []
        }],
        targetSettings: { targetSource: 'Owner' },
        asChildBuff: true,
        autoFinishByAction: true
    }], {
        blackboard: { child_buff_id: 'buff.child.default' },
        scope: 'buff'
    });

    assert.equal(compiled.status, 'executable');
    assert.deepEqual(compiled.actions[0].buffs[0], {
        buffId: 'buff.child.default',
        buffIdBlackboardKey: 'child_buff_id',
        assignBlackboard: false,
        assignments: []
    });
    assert.equal(compiled.actions[0].asChildBuff, true);
    assert.equal(compiled.cleanupActions[0].childOfCurrentBuff, true);
});

test('dynamic child Buff resolves its id and cascades only with its parent instance', () => {
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'operator', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {
                'buff.parent': {
                    lifeType: 'Infinity',
                    duringEnableActions: [{
                        type: 'ApplyBuff',
                        target: 'Owner',
                        asChildBuff: true,
                        buffs: [{
                            buffId: 'buff.child.default',
                            buffIdBlackboardKey: 'child_buff_id'
                        }]
                    }]
                },
                'buff.child.default': { lifeType: 'Infinity' },
                'buff.child.override': { lifeType: 'Infinity' }
            }
        }
    });
    const context = {
        frame: 0,
        sourceId: 'operator',
        ownerId: 'operator',
        targetId: 'enemy'
    };

    runtime.execute({
        type: 'ApplyBuff',
        buffId: 'buff.parent',
        blackboard: { child_buff_id: 'buff.child.override' }
    }, context);
    const parent = runtime.statusEffects.list({
        active: true, buffId: 'buff.parent'
    })[0];
    const child = runtime.statusEffects.list({
        active: true, buffId: 'buff.child.override'
    })[0];
    assert.equal(child.metadata.parentBuffInstanceId, parent.instanceId);
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy', buffId: 'buff.child.default'
    }), false);

    runtime.statusEffects.finish({
        frame: 1,
        instanceId: parent.instanceId,
        reason: 'fixture-parent-finish'
    }, { ...context, frame: 1 });
    assert.equal(runtime.statusEffects.has({
        targetId: 'enemy', buffId: 'buff.child.override'
    }), false);
});
