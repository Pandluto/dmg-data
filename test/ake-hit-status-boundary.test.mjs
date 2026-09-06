import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { simulateSquadDemo } from '../demo/demo-service.mjs';

const frontendRoot = fileURLToPath(new URL('../demo/lts-ui/', import.meta.url));
const frontendRequire = createRequire(new URL('../demo/lts-ui/package.json', import.meta.url));
const coldId = 'buff_common_energy_shard_attached_cryst';

test('real cold consumption separates earlier and later hits in the same frame in the UI ledger', async () => {
    // Actual user timeline: the two Last Rite hits precede consumption; Tangtang's
    // continuing battle skill hits again later in that same frame.
    const input = JSON.parse(fs.readFileSync(new URL('./fixtures/ake-hit-status-boundary.json', import.meta.url)));
    const result = simulateSquadDemo(input);
    const consumption = result.statusEvents.find(event => event.buffId === coldId && event.consumption);
    assert.equal(consumption.consumedStacks, 4);
    const before = result.hits.filter(hit => hit.frame === consumption.frame
        && hit.skillId === 'chr_0026_lastrite_combo_skill' && hit.damageAttributeType === 'Hp');
    const after = result.hits.find(hit => hit.frame === consumption.frame
        && hit.skillId === 'chr_0027_tangtang_normal_skill' && hit.damageAttributeType === 'Hp');
    assert.deepEqual(before.map(hit => hit.atkScale), [9.6, 1.6]);
    assert.ok(before.every(hit => hit.statusEventSequenceBeforeHit < consumption.sequence));
    assert.ok(after.statusEventSequenceBeforeHit >= consumption.sequence);
    assert.ok(before.every(hit => hit.operands.vulnerableDmgScale > 1));
    assert.ok(after.operands.vulnerableDmgScale > 1, 'independent vulnerability survives attachment consumption');

    const { createServer } = await import(pathToFileURL(frontendRequire.resolve('vite')).href);
    const server = await createServer({ root: frontendRoot, configFile: false,
        server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', logLevel: 'error' });
    try {
        const { buildAkeRuntimeCommandLedger } = await server.ssrLoadModule('/src/core/services/akeRuntimeLedger.ts');
        const report = { ...result, enemyId: result.enemy.id,
            characters: result.members.map(member => ({ akeCharacterId: member.characterId,
                memberId: member.memberId, localCharacterId: member.characterId,
                characterName: member.name, loadout: member.loadout })) };
        const ledgerHit = rawHit => {
            const command = result.timeline.commands.find(item => item.castId === rawHit.rootCastId);
            return buildAkeRuntimeCommandLedger({ report, commandId: command.commandId })
                .hits.find(item => item.hit.hitId === rawHit.hitId);
        };
        for (const hit of before) {
            assert.equal(ledgerHit(hit).statuses.filter(status => status.buffId === coldId).length, 1,
                'a hit before the independent consumption still sees four cold stacks');
        }
        const actualAfter = ledgerHit(after);
        assert.equal(actualAfter.statuses.some(status => status.buffId === coldId), false,
            'the later same-frame hit must not show already-consumed cold');
        assert.equal(actualAfter.formula.buffTags.some(tag => tag.buffId === coldId), false);
        assert.equal(result.finalState.activeStatuses.some(status => status.buffId === coldId), false);
    } finally {
        await server.close();
    }
});
