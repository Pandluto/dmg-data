import assert from 'node:assert/strict';
import test from 'node:test';

import { CombatRuntime } from '../src/core/combat-runtime.mjs';

test('missing Buff definitions are rejected without creating a phantom status', () => {
    const runtime = new CombatRuntime({
        definitions: {
            entities: [
                { id: 'caster', kind: 'Character', team: 'ally' },
                { id: 'enemy', kind: 'Enemy', team: 'enemy' }
            ],
            buffs: {}
        }
    });
    const result = runtime.execute({
        type: 'ApplyBuff',
        buffId: 'buff.missing',
        target: 'Target'
    }, {
        frame: 7,
        eventType: 'ContractProbe',
        sourceId: 'caster',
        ownerId: 'caster',
        targetId: 'enemy',
        skillId: 'skill.contract',
        castId: 'cast.contract'
    });

    assert.equal(result.stage, 'StatusEffectUnresolved');
    assert.equal(result.status, 'Unresolved');
    assert.equal(result.code, 'STATUS_DEFINITION_MISSING');
    assert.match(result.eventId, /^status-event:/);
    assert.match(result.transactionId, /^effect-tx:/);
    assert.equal(result.sourceId, 'caster');
    assert.equal(result.carrierId, 'enemy');
    assert.equal(result.damageSourceId, 'caster');
    assert.equal(runtime.statusEffects.list({ active: true }).length, 0);
    assert.equal(runtime.statusEffects.trace.length, 1);
});
