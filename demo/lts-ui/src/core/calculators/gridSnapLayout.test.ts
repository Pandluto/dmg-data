import assert from 'node:assert/strict';
import { SKILL_BUTTON_BASELINE_OFFSET_Y } from '../../constants/canvas-layout';
import {
  findNearestGridLine,
  getGridEnergyRowTopY,
  getGridGroupTop,
  getGridLineCenterY,
  getGridMergedCellRect,
  getNormalizedGridLineOffsetY,
  getGridOperatorPairTopY,
  GRID_ENERGY_ROW_HEIGHT,
  GRID_GROUP_HEIGHT,
  GRID_OPERATOR_SLOT_HEIGHT,
  GRID_ROW_HEIGHT,
} from './gridSnapLayout';

const selectedCharacters = [
  { id: 'char-0' },
  { id: 'char-1' },
  { id: 'char-2' },
  { id: 'char-3' },
];

assert.equal(SKILL_BUTTON_BASELINE_OFFSET_Y, 0, '拖拽与重载不得使用额外的纵向补偿');
assert.equal(GRID_OPERATOR_SLOT_HEIGHT, 72, '每名干员应占上下两格和一条独立能量行');
assert.equal(GRID_GROUP_HEIGHT, 318, '四名干员的完整组高度应包含四条能量行');

const canonicalSecondGroupY = getGridGroupTop(1) + getGridLineCenterY(0);
assert.equal(
  getNormalizedGridLineOffsetY(canonicalSecondGroupY, 1, 0),
  0,
  '逻辑组与持久坐标一致时不得引入纵向偏移',
);
assert.equal(
  getNormalizedGridLineOffsetY(getGridGroupTop(0) + getGridLineCenterY(0), 1, 0),
  0,
  '压缩显示页误写成逻辑组坐标时应丢弃整组级偏移',
);
assert.equal(
  getNormalizedGridLineOffsetY(canonicalSecondGroupY + 8, 1, 0),
  8,
  '小于一行的真实视觉微调应被保留',
);

const firstMergedCell = getGridMergedCellRect(0, 0);
assert.deepEqual(firstMergedCell, {
  left: 42,
  top: 32,
  width: 76,
  height: 56,
}, '上下两行应合并成一个留有 2px 缝隙的 80×60 交互大格');

for (let lineIndex = 0; lineIndex < selectedCharacters.length; lineIndex += 1) {
  const pairTop = getGridOperatorPairTopY(lineIndex);
  const secondRowBottom = pairTop + GRID_ROW_HEIGHT * 2;
  const energyTop = getGridEnergyRowTopY(lineIndex);

  assert.equal(energyTop, secondRowBottom, `第 ${lineIndex + 1} 名干员的 HIT 应在第二格底线上`);

  if (lineIndex < selectedCharacters.length - 1) {
    assert.equal(
      getGridOperatorPairTopY(lineIndex + 1),
      energyTop + GRID_ENERGY_ROW_HEIGHT,
      `第 ${lineIndex + 1} 名干员后应保留独立能量行`,
    );
  }

  const restoredY = getGridGroupTop(0) + getGridLineCenterY(lineIndex) + SKILL_BUTTON_BASELINE_OFFSET_Y;
  const snapped = findNearestGridLine(restoredY, 1, selectedCharacters[lineIndex].id, selectedCharacters);

  assert.ok(snapped, `第 ${lineIndex + 1} 名干员应能吸附到自己的谱线`);
  assert.equal(snapped.lineY + SKILL_BUTTON_BASELINE_OFFSET_Y, restoredY, '拖拽吸附与重载恢复必须得到同一个 Y');
}
