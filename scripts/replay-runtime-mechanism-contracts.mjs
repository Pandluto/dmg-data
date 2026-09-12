// One replay per immutable original full input; imports always use this checkout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { simulateSquadDemo } from '../demo/demo-service.mjs';
const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/replay-runtime-mechanism-contracts.mjs <original-repro-directory>');
for (const id of ['F-ultimate-cost-event', 'F-enhanced-attack-cooldown', 'F-independent-weapon-stacks']) {
    const raw = readFileSync(resolve(directory, `${id}.full.json`));
    const result = simulateSquadDemo(JSON.parse(raw).input);
    let actual;
    if (id === 'F-ultimate-cost-event') {
        actual = result.statusEvents.filter(x => x.buffId === 'buff_wpn_sword_0006_valid' && x.stage === 'StatusEffectApplied').map(x => x.frame);
        assert.equal(actual.length, 1);
    } else if (id === 'F-enhanced-attack-cooldown') {
        const command = result.commands.find(x => x.commandType === 'Attack');
        assert.equal(command.success, true);
        assert.ok(result.hits.some(x => x.skillId === 'chr_0016_laevat_ult_attack1'));
        actual = { frame: command.actualFrame, success: command.success };
    } else {
        const changes = result.statusEvents.filter(x => x.buffId === 'buff_wpn_sword_0019_up');
        const first = changes.find(x => x.stage === 'StatusEffectApplied').frame;
        actual = [0, 27, 60].map(offset => {
            const frame = first + 600 + offset;
            const event = changes.filter(x => x.frame <= frame).at(-1);
            return [frame, event.stage === 'StatusEffectFinished' ? 0 : event.stackCount];
        });
        assert.deepEqual(actual, [[first + 600, 2], [first + 627, 1], [first + 660, 0]]);
    }
    console.log(JSON.stringify({ id, sha256: createHash('sha256').update(raw).digest('hex'), passed: true, actual,
        diagnostics: result.diagnostics ?? [], failures: result.commands.filter(x => !x.success).map(x => ({ commandType: x.commandType, reason: x.reason })) }));
}
