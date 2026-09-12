import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { simulateSquadDemo } from '../demo/demo-service.mjs';

const fields = ['commands', 'controllerEvents', 'hits', 'statusEvents', 'resourceEvents', 'finalState', 'teamComboLedger'];
const facts = result => Object.fromEntries(fields.map(key => [key, result[key]]));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Recorded by executing the unchanged inputs at 11ef693, before production edits.
// Wulfa/Camille was rebased to the independently archived 584c0b3 result when
// integrating the skill-cost notification fix. Only trace identities changed;
// see artifacts/legacy-pairs-20260912/comparison.json. Keep the full-fact hash.
const baselines = {
    'lastrite-tangtang-status-provenance': '5fd5e94948922e629fd9034b0858e37f6a2765261bd16b2384a1403fae7732ff',
    'wulfa-camille-appended-ultimate': '6fcf1fbbbb678f1e6e021a6999322d0e6bee981843fbf7ac4631fc2746c9a5e4',
};

function firstDifference(left, right, path = '') {
    if (JSON.stringify(left) === JSON.stringify(right)) return null;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
        return { path, before: left, after: right };
    }
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        const difference = firstDifference(left[key], right[key], `${path}/${key}`);
        if (difference) return difference;
    }
    return null;
}

// Test-only v1 copies for these two archived fixtures, not the frontend migration.
// Fixed v0 order: explicit legacy key, switch-first ties, then normalized command
// frame/member/source order or original switch order. Original JSON is untouched.
function versionedCopy(input) {
    const copy = structuredClone(input);
    copy.operationOrderVersion = 1;
    const nodes = [
        ...copy.commands.map((node, index) => ({ node, index, kind: 'command', order: node.timelineOrder ?? 0 })),
        ...(copy.operatorSwitches ?? []).map((node, index) => ({ node, index, kind: 'switch', order: node.timelineOrder ?? -1 })),
    ];
    nodes.sort((a, b) => a.order - b.order || (a.kind !== b.kind ? a.kind === 'switch' ? -1 : 1
        : a.kind === 'switch' ? a.index - b.index
            : a.node.frame - b.node.frame || a.node.memberId.localeCompare(b.node.memberId) || a.index - b.index));
    nodes.forEach(({ node }, index) => { delete node.timelineOrder; node.operationOrder = index; });
    return copy;
}

for (const [name, baseline] of Object.entries(baselines)) {
    test(`${name}: v0 baseline and explicit v1 copy preserve full execution facts`, () => {
        const input = JSON.parse(readFileSync(new URL(`../fixtures/ria/${name}.json`, import.meta.url))).input;
        const original = structuredClone(input);
        const v0 = facts(simulateSquadDemo(input));
        assert.equal(hash(v0), baseline, 'v0 changed from the executed pre-edit baseline');
        const versioned = versionedCopy(input);
        const v1 = facts(simulateSquadDemo(versioned));
        assert.deepEqual(firstDifference(v0, v1), null, 'first v0/v1 execution difference');
        versioned.commands.reverse();
        versioned.operatorSwitches?.reverse();
        assert.deepEqual(firstDifference(v1, facts(simulateSquadDemo(versioned))), null, 'first array-reversal difference');
        assert.deepEqual(input, original);
    });
}
