import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAkeAbilityEventAudit } from '../scripts/audit-ake-ability-events.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ability-event audit aggregates every listener channel by producer status', () => {
    const audit = buildAkeAbilityEventAudit({ projectRoot });
    const committed = JSON.parse(readFileSync(path.join(
        projectRoot,
        'derived',
        'cleanroom',
        'ake-ability-event-audit.json'
    ), 'utf8'));

    assert.deepEqual(audit, committed);
    assert.equal(audit.summary.byChannel.BuffAbilityEventAction, 953);
    assert.ok(audit.summary.byChannel.SkillPassiveEventAction > 0);
    assert.ok(audit.summary.byChannel.EventListenerAction > 0);
    assert.equal(audit.events.find(entry =>
        entry.eventType === 'OnRemoveAllPendingComboSkill'
    ).status, 'complete');
    assert.equal(audit.events.find(entry =>
        entry.eventType === 'OnOwnerHpZero'
    ).status, 'emitter-required');
    assert.ok(audit.events.some(entry =>
        entry.status === 'invalid-type' && entry.serializedValue === 32
    ));
});
