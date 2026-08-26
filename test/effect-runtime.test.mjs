import test from 'node:test';
import assert from 'node:assert/strict';

import CombatContext from '../src/core/combat-context.mjs';
import EffectRuntime from '../src/core/effect-runtime.mjs';

function makeContext() {
    return new CombatContext({
        entities: [
            {
                id: 'caster',
                kind: 'Character',
                team: 'ally',
                attributes: { power: 10, hp: 80 },
                tags: ['Ready']
            },
            {
                id: 'owner',
                kind: 'Summon',
                team: 'ally',
                ownerId: 'caster',
                attributes: { power: 2 }
            },
            {
                id: 'target',
                kind: 'Enemy',
                team: 'enemy',
                attributes: { hp: 20, maxHp: 100 }
            }
        ]
    });
}

test('CombatContext keeps Source and Owner distinct and creates isolated event contexts', () => {
    const context = makeContext();
    const event = context.createEventContext({
        frame: 4,
        eventType: 'Hit',
        sourceId: 'caster',
        ownerId: 'owner',
        targetId: 'target',
        blackboard: { amount: 5 },
        payload: { nested: { ok: true } }
    });

    assert.equal(context.resolveEntityRef('Source', event).id, 'caster');
    assert.equal(context.resolveEntityRef('Owner', event).id, 'owner');
    assert.equal(context.resolveEntityRef('Target', event).id, 'target');
    assert.equal(context.resolveEntityRef('Self', event).id, 'caster');

    const child = context.createEventContext(event, {
        targetId: 'caster',
        blackboard: { amount: 9 }
    });
    child.blackboard.amount = 100;
    child.payload.nested.ok = false;
    assert.equal(event.targetId, 'target');
    assert.equal(event.blackboard.amount, 5);
    assert.equal(event.payload.nested.ok, true);
});

test('EffectRuntime evaluates condition trees and executes the selected branch', () => {
    const context = makeContext();
    const runtime = new EffectRuntime({ context });
    const event = context.createEventContext({
        frame: 8,
        eventType: 'Hit',
        sourceId: 'caster',
        ownerId: 'owner',
        targetId: 'target',
        blackboard: { threshold: 10 }
    });

    const condition = {
        type: 'All',
        ruleId: 'ready-hit',
        conditions: [
            { type: 'HasTag', entity: 'Source', tag: 'Ready' },
            {
                type: 'Compare',
                left: { type: 'Attribute', entity: 'Target', key: 'hp' },
                operator: 'LT',
                right: { type: 'Blackboard', key: 'threshold' }
            },
            { type: 'Not', condition: { type: 'EventTypeIs', value: 'Miss' } }
        ]
    };
    assert.equal(runtime.evaluate(condition, event), false);

    context.setAttribute('target', 'hp', 5, event);
    assert.equal(runtime.evaluate(condition, event), true);

    const result = runtime.execute({
        type: 'IfElseAction',
        conditions: [condition],
        success: [
            { type: 'ModifyAttribute', entity: 'Target', attribute: 'hp', amount: -2 },
            { type: 'ApplyTag', entity: 'Target', tag: 'Marked' }
        ],
        failure: { type: 'ApplyTag', entity: 'Target', tag: 'Skipped' }
    }, event);

    assert.equal(Array.isArray(result), true);
    assert.equal(context.getAttribute('target', 'hp'), 3);
    assert.equal(context.hasTag('target', 'Marked'), true);
    assert.equal(context.hasTag('target', 'Skipped'), false);
    assert.ok(runtime.trace.some(record => record.stage === 'ActionBranch' && record.passed));
});

test('EffectRuntime resolves target-group references and treats an empty group as a failed condition', () => {
    const context = makeContext();
    const runtime = new EffectRuntime({ context });
    const targetGroup = {
        type: 'TargetGroup',
        key: 'selected',
        index: 0,
        fallback: 'Target'
    };
    const grouped = context.createEventContext({
        sourceId: 'caster',
        ownerId: 'owner',
        targetId: 'target',
        blackboard: { __akeTargetGroups: { selected: ['caster'] } }
    });
    assert.equal(runtime.evaluate({
        type: 'HasTag', entity: targetGroup, tag: 'Ready'
    }, grouped), true);
    assert.equal(runtime.evaluate({
        type: 'Compare',
        left: { type: 'Attribute', entity: targetGroup, key: 'power' },
        operator: 'EQ',
        right: 10
    }, grouped), true);

    const empty = context.createEventContext(grouped, {
        blackboard: { __akeTargetGroups: { selected: [] } }
    });
    assert.equal(runtime.evaluate({
        type: 'HasTag', entity: targetGroup, tag: 'Ready'
    }, empty), false);
    runtime.execute({
        type: 'ModifyAttribute',
        entity: targetGroup,
        attribute: 'hp',
        amount: -1
    }, empty);
    assert.equal(context.getAttribute('target', 'hp'), 19,
        'an executable action may use its explicit fallback when the group is empty');

    const missing = context.createEventContext({
        sourceId: 'caster',
        ownerId: 'owner',
        targetId: 'target',
        blackboard: {}
    });
    assert.equal(runtime.evaluate({
        type: 'Compare',
        left: { type: 'Attribute', entity: targetGroup, key: 'hp' },
        operator: 'EQ',
        right: 19
    }, missing), true);
});

test('EffectRuntime delegates machine actions and reports unsupported nodes explicitly', () => {
    const context = makeContext();
    const delegated = [];
    const runtime = new EffectRuntime({
        context,
        handlers: {
            ResourceChange(action, event) {
                delegated.push({ action, event });
                return { status: 'Applied', before: 1, requested: 2, actual: 2, discarded: 0, after: 3 };
            },
            HasBuff(condition) {
                return condition.buffId === 'buff.test';
            }
        }
    });
    const event = context.createEventContext({
        frame: 2,
        eventType: 'Cast',
        sourceId: 'caster',
        ownerId: 'owner',
        targetId: 'target'
    });

    assert.equal(runtime.evaluate({ type: 'HasBuff', buffId: 'buff.test' }, event), true);
    const result = runtime.execute({
        type: 'ResourceChange',
        resourceType: 'SharedAtb',
        amount: -10,
        reason: 'CastCost'
    }, event);
    assert.equal(result.status, 'Applied');
    assert.equal(delegated.length, 1);
    assert.equal(delegated[0].event.sourceId, 'caster');

    assert.equal(runtime.evaluate({ type: 'FutureCondition' }, event), false);
    const unsupported = runtime.execute({ type: 'ApplyBuff', buffId: 'buff.test' }, event);
    assert.equal(unsupported.status, 'Unsupported');
    assert.ok(runtime.trace.some(record => record.stage === 'ActionUnsupported'));
    assert.ok(runtime.trace.some(record => record.reason === 'UnsupportedCondition'));
});

test('context attribute/tag mutations are validated and produce auditable records', () => {
    const context = makeContext();
    assert.throws(() => context.registerEntity({ id: 'caster', kind: 'Object' }), /Duplicate entity/);
    assert.throws(() => context.createEventContext({ sourceId: 'missing' }), /Unknown sourceId/);
    assert.throws(() => context.modifyAttribute('target', 'hp', Number.NaN), /finite number/);

    context.modifyAttribute('target', 'hp', 5);
    context.addTag('target', 'Visible');
    context.removeTag('target', 'Visible');
    const records = context.snapshot().trace;
    assert.ok(records.some(record => record.type === 'AttributeModified'));
    assert.ok(records.some(record => record.type === 'TagAdded'));
    assert.ok(records.some(record => record.type === 'TagRemoved'));
});

test('registered extension handlers execute custom action and condition types', () => {
    const context = makeContext();
    const runtime = new EffectRuntime({ context });
    const event = context.createEventContext({
        frame: 1,
        sourceId: 'caster',
        ownerId: 'owner',
        targetId: 'target'
    });
    runtime.registerConditionHandler('CustomGate', condition => condition.open === true);
    runtime.registerHandler('CustomAction', action => ({
        status: 'Applied',
        actual: action.amount
    }));

    assert.equal(runtime.evaluate({ type: 'CustomGate', open: true }, event), true);
    assert.deepEqual(runtime.execute({ type: 'CustomAction', amount: 4 }, event), {
        status: 'Applied',
        actual: 4
    });
});
