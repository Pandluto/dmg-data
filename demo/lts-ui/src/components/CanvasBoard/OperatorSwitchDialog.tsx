import { useMemo, useState } from 'react';
import type { Character, OperatorSwitchConfig } from '../../types';
import { normalizeAssetUrl } from '../../utils/assetResolver';
import './ForcedWaitConfigDialog.css';

interface OperatorSwitchDialogProps {
  sourceCharacterId: string;
  characters: Character[];
  initialConfig?: OperatorSwitchConfig;
  onCancel: () => void;
  onConfirm: (config: OperatorSwitchConfig) => void;
}

export function OperatorSwitchDialog({
  sourceCharacterId,
  characters,
  initialConfig,
  onCancel,
  onConfirm,
}: OperatorSwitchDialogProps) {
  const targets = useMemo(
    () => characters.filter(character => character.id !== sourceCharacterId),
    [characters, sourceCharacterId],
  );
  const defaultTargetId = initialConfig?.targetCharacterId ?? targets[0]?.id ?? '';
  const [targetCharacterId, setTargetCharacterId] = useState(defaultTargetId);

  return (
    <div className="forced-wait-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="forced-wait-dialog operator-switch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operator-switch-dialog-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header>
          <span>主控交接 / 零时长控制节点</span>
          <h2 id="operator-switch-dialog-title">选择切换目标</h2>
          <p>切人占一格但不推进真实时间，并强制打断当前非终结技动作。</p>
        </header>

        <div className="operator-switch-target-grid" role="radiogroup" aria-label="切换目标">
          {targets.map(character => (
            <button
              key={character.id}
              type="button"
              role="radio"
              aria-checked={targetCharacterId === character.id}
              className={targetCharacterId === character.id ? 'is-selected' : ''}
              onClick={() => setTargetCharacterId(character.id)}
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
          关闭弹窗会保留默认的“下一位干员”；终结技完整动画期间不会提供切人吸附点。
        </div>

        <footer>
          <button type="button" onClick={onCancel}>保留默认</button>
          <button
            type="button"
            className="is-primary"
            disabled={!targetCharacterId}
            onClick={() => onConfirm({ schemaVersion: 1, targetCharacterId })}
          >
            确认切人
          </button>
        </footer>
      </section>
    </div>
  );
}
