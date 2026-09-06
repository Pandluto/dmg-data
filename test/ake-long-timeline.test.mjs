import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateSquadDemo } from '../demo/demo-service.mjs';
import { CombatRuntime } from '../src/core/combat-runtime.mjs';

test('a supported long rotation completes and exposes every hit used by its damage total', () => {
    const tangtang = 'chr_0027_tangtang';
    const result = simulateSquadDemo({
        members: [tangtang, 'chr_0026_lastrite'].map(characterId => ({
            memberId: characterId, characterId, level: 90, skillLevel: 12, weaponLevel: 90
        })),
        initialAtb: 300,
        commands: Array.from({ length: 60 }, (_, index) => ({
            commandId: `tornado-${index}`, memberId: tangtang,
            frame: index * 360, commandType: 'NormalSkill'
        })),
        endFrame: 21600
    });
    assert.ok(result.hits.length > 1200, 'the real rotation must exercise the former result truncation');
    const total = result.hits.filter(hit => hit.damageAttributeType === 'Hp')
        .reduce((sum, hit) => sum + hit.finalDamage, 0);
    assert.ok(Math.abs(total - result.summary.totalDamage) < 1e-7);
    assert.ok(result.hits.at(-1).frame > 20000, 'the tail of the rotation must remain visible');
});

test('a larger total event budget still rejects a zero-time scheduling loop', () => {
    const runtime = new CombatRuntime({ maxEventsPerRun: 100_000 });
    const repeat = () => runtime.schedule(0, 0, repeat, 'fixture.zero-time-loop');
    repeat();
    assert.throws(() => runtime.runUntil(10), /Scheduled event limit at frame 0 exceeded/);
});
