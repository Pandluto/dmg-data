export type StateMarkerTone = 'fire' | 'ice' | 'electric' | 'nature' | 'physical' | 'neutral';

const STATUS_TONES: Readonly<Record<string, StateMarkerTone>> = {
  buff_common_energy_shard_attached_fire: 'fire',
  buff_common_energy_shard_attached_cryst: 'ice',
  buff_common_energy_shard_attached_pulse: 'electric',
  buff_common_energy_shard_attached_natural: 'nature',
  buff_common_enemy_spell_status_burning: 'fire',
  buff_common_enemy_spell_status_frozen: 'ice',
  buff_common_enemy_spell_status_conduct: 'electric',
  buff_common_enemy_spell_status_corrupt: 'nature',
};

const ATTACHMENT_ICON_TONES: Readonly<Record<string, StateMarkerTone>> = {
  icon_energy_fusion_fire: 'fire',
  icon_energy_fusion_cryst: 'ice',
  icon_energy_fusion_pulse: 'electric',
  icon_energy_fusion_natural: 'nature',
};

export function stateMarkerTone(event: { buffId: string; iconUrl?: string }): StateMarkerTone {
  const buffId = event.buffId.toLowerCase();
  if (STATUS_TONES[buffId]) return STATUS_TONES[buffId];
  if (buffId.startsWith('buff_physical_')) return 'physical';
  // fusion is shared by all four attachment assets, not the name of an element.
  // Only known icon basenames may supply a fallback; paths and hosts cannot.
  const filename = (event.iconUrl ?? '').split(/[?#]/, 1)[0].split('/').pop() ?? '';
  const iconId = filename.replace(/\.[^.]+$/, '').toLowerCase();
  return ATTACHMENT_ICON_TONES[iconId] ?? 'neutral';
}
