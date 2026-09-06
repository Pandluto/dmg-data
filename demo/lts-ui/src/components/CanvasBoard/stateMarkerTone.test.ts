import assert from 'node:assert/strict';
import { stateMarkerTone } from './stateMarkerTone';

// The actual cold attachment asset shares the fusion prefix with all elements.
for (const [element, expected] of [['cryst', 'ice'], ['fire', 'fire'], ['pulse', 'electric'], ['natural', 'nature']]) {
  assert.equal(stateMarkerTone({
    buffId: `buff_common_energy_shard_attached_${element}`,
    iconUrl: `https://data.akedata.wiki/public/images/assets/beyond/dynamicassets/gameplay/ui/sprites/bufficon/icon_energy_fusion_${element}.png`,
  }), expected, `${element} attachment must keep its own element despite the shared fusion prefix`);
  assert.equal(stateMarkerTone({ buffId: `buff_common_energy_shard_attached_${element}` }), expected);
}
assert.equal(stateMarkerTone({ buffId: 'buff_common_energy_shard_attached_cryst', iconUrl: '/old/icon_energy_fusion_fire.png' }), 'ice', 'status identity takes precedence over a stale asset');
assert.equal(stateMarkerTone({ buffId: 'buff_physical_no_guard' }), 'physical');
assert.equal(stateMarkerTone({ buffId: 'buff_common_enemy_spell_status_frozen' }), 'ice');
assert.equal(stateMarkerTone({ buffId: 'buff_common_enemy_spell_status_burning' }), 'fire');
assert.equal(stateMarkerTone({ buffId: 'buff_common_enemy_spell_status_conduct' }), 'electric');
assert.equal(stateMarkerTone({ buffId: 'buff_common_enemy_spell_status_corrupt' }), 'nature');
assert.equal(stateMarkerTone({ buffId: 'unknown', iconUrl: '/fusion/fire/unknown.png' }), 'neutral', 'asset directory names are not element metadata');
assert.equal(stateMarkerTone({ buffId: 'unknown', iconUrl: '/icons/icon_energy_fusion_cryst.png?v=1' }), 'ice');
console.log('state marker element mapping passed for all four attachments and shared fusion assets');
