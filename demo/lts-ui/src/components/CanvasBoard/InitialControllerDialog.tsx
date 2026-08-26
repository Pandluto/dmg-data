import { useState } from 'react';
import type { Character } from '../../types';
import { normalizeAssetUrl } from '../../utils/assetResolver';
import './ForcedWaitConfigDialog.css';

interface InitialControllerDialogProps {
  characters: Character[];
  initialCharacterId?: string | null;
  onCancel: () => void;
  onConfirm: (characterId: string) => void;
}

export function InitialControllerDialog({
  characters,
  initialCharacterId,
  onCancel,
  onConfirm,
}: InitialControllerDialogProps) {
  const fallbackId = characters[0]?.id ?? '';
  const [characterId, setCharacterId] = useState(
    characters.some(character => character.id === initialCharacterId)
      ? initialCharacterId ?? fallbackId
      : fallbackId,
  );

  return (
    <div className="forced-wait-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="forced-wait-dialog initial-controller-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="initial-controller-dialog-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header>
          <span>时间轴起点 / 0.00 秒</span>
          <h2 id="initial-controller-dialog-title">选择初始主控干员</h2>
          <p>初始主控决定谁能在轴首普攻、闪避和发起切人；后续控制权由切人节点接管。</p>
        </header>

        <div className="operator-switch-target-grid" role="radiogroup" aria-label="初始主控干员">
          {characters.map(character => (
            <button
              key={character.id}
              type="button"
              role="radio"
              aria-checked={characterId === character.id}
              className={characterId === character.id ? 'is-selected' : ''}
              onClick={() => setCharacterId(character.id)}
            >
              {character.avatarUrl ? (
                <img src={normalizeAssetUrl(character.avatarUrl)} alt="" />
              ) : (
                <i aria-hidden="true">{character.name.slice(0, 1)}</i>
              )}
              <span>{character.name}</span>
            </button>
          ))}
        </div>

        <div className="forced-wait-seal-note">
          轴首紫色箭头会移动到所选干员；已经放置的动作会立即按新主控重新校验。
        </div>

        <footer>
          <button type="button" onClick={onCancel}>取消</button>
          <button
            type="button"
            className="is-primary"
            disabled={!characterId}
            onClick={() => onConfirm(characterId)}
          >
            设为初始主控
          </button>
        </footer>
      </section>
    </div>
  );
}
