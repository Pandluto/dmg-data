import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildBasicAttackCutOptions,
  type ActionTailTimingContract,
} from '../../core/domain/combatActionTailPlanner';
import { BasicAttackCutDialog } from './BasicAttackCutDialog';

const contract: ActionTailTimingContract = {
  actionId: 'basic',
  kind: 'basic-attack',
  naturalEndOffsetFrames: 100,
  effectEndOffsetFrames: 70,
  exclusiveEndOffsetFrames: 100,
  priority: 0,
  interruptibleAtOffsetFrames: [],
  successorWindows: [],
  commitEvents: [
    { id: 'hit-1', kind: 'hit', commitOffsetFrames: 5, effectOffsetFrames: 5, basicStageOrdinal: 1 },
    { id: 'hit-2', kind: 'hit', commitOffsetFrames: 15, effectOffsetFrames: 15, basicStageOrdinal: 2 },
    { id: 'hit-3', kind: 'hit', commitOffsetFrames: 40, effectOffsetFrames: 40, basicStageOrdinal: 3 },
    { id: 'hit-4', kind: 'hit', commitOffsetFrames: 70, effectOffsetFrames: 70, basicStageOrdinal: 4 },
  ],
  tailCancelable: true,
  commitEvidence: 'verified',
  basicCombo: {
    comboId: 'basic-combo',
    stageCount: 4,
    startingStageIndex: 0,
    renderedStageCount: 4,
  },
};
const options = buildBasicAttackCutOptions({
  predecessor: contract,
  successor: { actionId: 'skill', kind: 'normal-skill', priority: 2 },
  boundary: 'append',
  debounceFrames: 6,
});
const html = renderToStaticMarkup(
  <BasicAttackCutDialog
    predecessorLabel="四段普攻"
    successorLabel="战技"
    contract={contract}
    options={options}
    selectedStageCount={2}
    tickRate={30}
    onSelectedStageCountChange={() => undefined}
    onCancel={() => undefined}
    onConfirm={() => undefined}
  />,
);

assert.match(html, /选择打出几段普攻/);
assert.match(html, /第 2 段后衔接/);
assert.match(html, /0\.70s/);
assert.match(html, /确认并锁定拼接/);
assert.match(html, /basic-cut-hit is-pruned/);

console.log('Basic attack cut dialog: PASS');
