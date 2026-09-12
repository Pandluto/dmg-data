import assert from 'node:assert/strict';
import { STORAGE_KEYS } from '../../constants/storage-keys';
import {
  getSkillButtonTable as readStorageTable,
  getSkillButtonById as readStorageButton,
  setSkillButtonTable as saveStorageTable,
  safeSessionStorage,
} from '../../utils/storage';
import {
  getSkillButtonTable as readRepositoryTable,
  getSkillButtonById as readRepositoryButton,
  setSkillButtonTable as saveRepositoryTable,
} from './skillButtonRepository';

const originalStorage = { ...safeSessionStorage };
const values = new Map<string, string>();
const writes: string[] = [];
const legacy = JSON.stringify({ button: { id: 'button', characterId: 'chr_0026_lastrite',
  characterName: '别礼', skillType: 'B', staffIndex: 0, nodeIndex: 0,
  createdAt: 1, updatedAt: 2, selectedBuff: ['preserved-buff'],
  panelSnapshot: { legacyMarker: 'preserved-panel' } } });
safeSessionStorage.getItem = key => values.get(key) ?? null;
safeSessionStorage.setItem = (key, value) => { values.set(key, value); writes.push(key); };
safeSessionStorage.removeItem = key => { values.delete(key); writes.push(key); };

try {
  for (const reader of [
    { name: 'repository', table: readRepositoryTable, button: readRepositoryButton, save: saveRepositoryTable },
    { name: 'storage compatibility', table: readStorageTable, button: readStorageButton, save: saveStorageTable },
  ]) {
    values.clear();
    values.set(STORAGE_KEYS.SKILL_BUTTON_TABLE, legacy);
    writes.length = 0;
    const normalized = reader.table();
    assert.deepEqual(reader.button('button'), normalized.button);
    assert.deepEqual(reader.table(), normalized, `${reader.name}: repeated reads stay deterministic`);
    assert.equal(writes.length, 0, `${reader.name}: reading a legacy button must not persist normalization`);
    assert.equal(values.get(STORAGE_KEYS.SKILL_BUTTON_TABLE), legacy);
    assert.deepEqual(normalized.button.runtimeSnapshot, { legacyMarker: 'preserved-panel' });
    assert.deepEqual(normalized.button.selectedBuff, ['preserved-buff']);
    assert.equal(normalized.button.updatedAt, 2);
    assert.ok(!Object.hasOwn(normalized.button, 'panelSnapshot'));
    reader.save(normalized);
    assert.deepEqual(writes, [STORAGE_KEYS.SKILL_BUTTON_TABLE], `${reader.name}: explicit save persists the migrated value`);
    assert.deepEqual(JSON.parse(values.get(STORAGE_KEYS.SKILL_BUTTON_TABLE)!), normalized);
  }
} finally {
  Object.assign(safeSessionStorage, originalStorage);
}
console.log('Skill button reads: both paths normalize in memory; explicit saves persist once');
