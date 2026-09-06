import assert from 'node:assert/strict';
import {
  clampTimelineBatchContextMenuPosition,
  stopTimelineBatchContextMenuPointerDown,
} from './TimelineBatchContextMenu';

assert.deepEqual(
  clampTimelineBatchContextMenuPosition(
    { x: 999, y: 799 },
    { width: 1000, height: 800 },
  ),
  { x: 868, y: 766 },
);
assert.deepEqual(
  clampTimelineBatchContextMenuPosition(
    { x: -10, y: -4 },
    { width: 1000, height: 800 },
  ),
  { x: 0, y: 0 },
);

let propagationStopped = false;
stopTimelineBatchContextMenuPointerDown({
  stopPropagation: () => {
    propagationStopped = true;
  },
});
assert.equal(propagationStopped, true);

console.log('Timeline batch context menu behavior: PASS');
