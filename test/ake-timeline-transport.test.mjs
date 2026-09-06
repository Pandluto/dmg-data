import assert from 'node:assert/strict';
import test from 'node:test';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { projectAkeTimeline } from '../src/core/ake-timeline-projector.mjs';
import { compactSquadHits, simulateSquadDemo } from '../demo/demo-service.mjs';
import { projectAkeTimelineTransport } from '../demo/ake-timeline-transport.mjs';

const tangtang = 'chr_0027_tangtang';
const lastrite = 'chr_0026_lastrite';
const members = [tangtang, lastrite].map(characterId => ({
    memberId: characterId, characterId, level: 90, skillLevel: 12, initialUltimateSp: 0
}));

test('real persistent-skill timeline transports every hit and resource fact without repeated aliases', () => {
    const bundle = new AkeSquadScenarioAssembler().assemble({
        members, enemyId: 'eny_0007_mimicw', enemyMaxHp: 1e12
    });
    const result = new AkeSquadScenarioRunner(bundle).run({
        commands: [0, 400, 800, 1200].map((frame, index) => ({
            memberId: tangtang, commandId: `water-${index}`, commandType: 'NormalSkill', frame
        })), endFrame: 1500
    });
    const full = projectAkeTimeline(result);
    const hits = compactSquadHits(result.damageLog);
    const beforeHits = structuredClone(hits);
    const compact = projectAkeTimelineTransport(full, hits);
    assert.equal(compact.transportProjection.schemaVersion, 1);
    assert.equal(Object.hasOwn(compact, 'lanes'), false);
    assert.equal(Object.hasOwn(compact, 'resourcePools'), false);
    assert.deepEqual(hits, beforeHits);
    assert.ok(hits.length > 100, 'the experiment must include actual repeated water attacks');
    const seen = [];
    for (let i = 0; i < full.hitBursts.length; i += 1) {
        const { hits: originals, ...marker } = full.hitBursts[i];
        const { hitIndices, ...transportedMarker } = compact.hitBursts[i];
        assert.deepEqual(transportedMarker, marker);
        const withoutIndex = ({ hitIndex, ...hit }) => hit;
        assert.deepEqual(hitIndices.map(index => withoutIndex(hits[index])),
            compactSquadHits(originals).map(withoutIndex));
        seen.push(...hitIndices);
    }
    assert.deepEqual([...seen].sort((a, b) => a - b), hits.map((_, index) => index));
    for (const key of Object.keys(full)) {
        if (!['lanes', 'resourcePools', 'hitBursts'].includes(key)) {
            assert.deepEqual(compact[key], full[key]);
        }
    }
    const pools = [compact.sharedAtb, ...compact.uspPools, ...(compact.otherResourcePools ?? [])]
        .filter(Boolean);
    assert.deepEqual(full.resourcePools, full.resourcePools.map(pool =>
        pools.find(candidate => candidate.poolId === pool.poolId)));
    const bytes = value => Buffer.byteLength(JSON.stringify(value));
    assert.ok(bytes({ hits, timeline: compact }) < bytes({ hits, timeline: full }) * 0.5);
    assert.ok(full.hitBursts.every(burst => Array.isArray(burst.hits)),
        'the core audit projection itself must remain complete');
});

test('browser simulation exposes versioned compact markers against its complete canonical hits', () => {
    const response = simulateSquadDemo({ members,
        commands: [{ memberId: tangtang, commandId: 'water', commandType: 'NormalSkill', frame: 0 }],
        endFrame: 300 });
    assert.equal(response.timeline.transportProjection.canonicalHitPath, '/hits');
    const indices = response.timeline.hitBursts.flatMap(burst => burst.hitIndices);
    assert.equal(indices.length, response.hits.length);
    assert.deepEqual([...indices].sort((a, b) => a - b), response.hits.map(hit => hit.hitIndex));
    const damage = response.hits.reduce((sum, hit) => sum + hit.finalDamage, 0);
    assert.ok(Math.abs(damage - response.summary.totalDamage) < 1e-6);
});
