import assert from 'node:assert/strict';
import type { AkeCombatStateEvent } from '../../core/services/akeRuntimeLedger';
import { formatReadingStateStack, summarizeReadingStateEvents } from './readingModeState';

const state = (
  key: string,
  frame: number,
  sequence: number,
  overrides: Partial<AkeCombatStateEvent> = {},
): AkeCombatStateEvent => ({
  key,
  buffId: 'buff_physical_no_guard',
  label: '破防',
  scope: 'enemy',
  frame,
  sequence,
  change: '叠层并刷新',
  before: 0,
  after: 1,
  sourceId: 'source-a',
  actorId: 'actor-a',
  commandId: 'command-a',
  sourceCommandId: 'command-a',
  triggerCommandId: null,
  ...overrides,
});

const input = [
  state('first', 10, 1, { after: 1 }),
  state('later', 20, 2, { before: 1, after: 0, change: '消费' }),
  state('other-source', 30, 3, { sourceId: 'source-b', after: 2 }),
  state('foreign-command', 40, 4, { commandId: 'command-b', sourceCommandId: 'command-b' }),
];
const result = summarizeReadingStateEvents(input, 'command-a');

assert.deepEqual(result.map((event) => event.key), ['later', 'other-source']);
assert.deepEqual(input.map((event) => event.key), ['first', 'later', 'other-source', 'foreign-command']);
assert.equal(formatReadingStateStack(result[0]), '×');
assert.equal(formatReadingStateStack(result[1]), '2');
assert.equal(formatReadingStateStack({ after: null }), '?');
console.log('reading mode state summary: last-per-source and clear marker passed');
