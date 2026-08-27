import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timingPath = path.join(projectRoot, 'derived', 'cleanroom', 'ake-timing-profiles.json');

test('derived timing profiles never place a projectile effect before its launch', () => {
    const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'));
    const violations = [];
    for (const [characterId, character] of Object.entries(timing.characters ?? {})) {
        for (const profile of character.profiles ?? []) {
            for (const [hitIndex, hit] of (profile.hits ?? []).entries()) {
                if (hit.launchOffsetFrames === null || hit.launchOffsetFrames === undefined) continue;
                if (Number(hit.launchOffsetFrames) <= Number(hit.offsetFrames)) continue;
                violations.push({
                    characterId,
                    skillId: profile.skillId,
                    hitIndex: hitIndex + 1,
                    effectOffsetFrames: hit.offsetFrames,
                    launchOffsetFrames: hit.launchOffsetFrames
                });
            }
        }
    }
    assert.deepEqual(violations, []);
});
