import type { TimelineSnapshotPayload } from '../../utils/timelineSnapshotStorage';
import type { AiTimelineValidationIssue, AiTimelineValidationResult } from './types';
import { GRID_NODE_COUNT } from '../../core/calculators/gridSnapLayout';
import { wouldCreateReleaseCycle } from '../../core/domain/releaseAnchorGraph';

function collectTimelineButtonEntries(payload: TimelineSnapshotPayload) {
  return payload.timelineData.staffLines.flatMap((staffLine, staffOffset) => (
    Array.isArray(staffLine.buttons)
      ? staffLine.buttons.map((button, buttonOffset) => ({ button, staffLine, staffOffset, buttonOffset }))
      : []
  ));
}

function issue(code: string, message: string, path?: string): AiTimelineValidationIssue {
  return { code, message, path };
}

export function validateTimelinePayload(payload: TimelineSnapshotPayload): AiTimelineValidationResult {
  const issues: AiTimelineValidationIssue[] = [];
  if (!Array.isArray(payload.selectedCharacters)) {
    issues.push(issue('invalid-selected-characters', 'selectedCharacters must be an array.', 'selectedCharacters'));
  }
  if (!payload.timelineData || !Array.isArray(payload.timelineData.staffLines)) {
    issues.push(issue('invalid-timeline-data', 'timelineData.staffLines must be an array.', 'timelineData.staffLines'));
  }
  if (!payload.skillButtonTable || typeof payload.skillButtonTable !== 'object') {
    issues.push(issue('invalid-skill-button-table', 'skillButtonTable must be an object.', 'skillButtonTable'));
  }
  if (!Array.isArray(payload.allBuffList)) {
    issues.push(issue('invalid-buff-list', 'allBuffList must be an array.', 'allBuffList'));
  }
  if (issues.length) return { ok: false, issues };

  const timelineButtonEntries = collectTimelineButtonEntries(payload);
  const timelineButtonIds = new Set(timelineButtonEntries.map(({ button }) => button.id));
  const tableButtonIds = new Set(Object.keys(payload.skillButtonTable));
  for (const buttonId of timelineButtonIds) {
    if (!tableButtonIds.has(buttonId)) {
      issues.push(issue('timeline-button-missing-table-entry', `Timeline button ${buttonId} is missing from skillButtonTable.`, `skillButtonTable.${buttonId}`));
    }
  }
  for (const buttonId of tableButtonIds) {
    if (!timelineButtonIds.has(buttonId)) {
      issues.push(issue('table-button-missing-timeline-entry', `skillButtonTable button ${buttonId} is missing from timelineData.`, `timelineData.${buttonId}`));
    }
  }
  const validSkillTypes = new Set(['A', 'B', 'E', 'Q', 'Dot']);
  const selectedCharacters = new Set(payload.selectedCharacters);
  const initialControllerCharacterId = payload.timelineData.initialControllerCharacterId;
  if (initialControllerCharacterId !== undefined
    && (typeof initialControllerCharacterId !== 'string'
      || !initialControllerCharacterId.trim()
      || !selectedCharacters.has(initialControllerCharacterId))) {
    issues.push(issue(
      'invalid-initial-controller',
      'timelineData.initialControllerCharacterId must reference a selected character.',
      'timelineData.initialControllerCharacterId',
    ));
  }
  const staffIndices = new Set<number>();
  for (const [staffOffset, staffLine] of payload.timelineData.staffLines.entries()) {
    if (!Number.isInteger(staffLine.staffIndex) || staffLine.staffIndex < 0 || staffLine.staffIndex >= payload.selectedCharacters.length) {
      issues.push(issue('invalid-staff-index', `Staff line ${staffOffset} has an invalid staffIndex.`, `timelineData.staffLines.${staffOffset}.staffIndex`));
    } else if (staffIndices.has(staffLine.staffIndex)) {
      issues.push(issue('duplicate-staff-index', `Staff line index ${staffLine.staffIndex} appears more than once.`, `timelineData.staffLines.${staffOffset}.staffIndex`));
    } else {
      staffIndices.add(staffLine.staffIndex);
    }
    if (!staffLine.characterName?.trim()) {
      issues.push(issue('invalid-staff-character-name', `Staff line ${staffOffset} has no characterName.`, `timelineData.staffLines.${staffOffset}.characterName`));
    }
  }

  const seenTimelineButtonIds = new Set<string>();
  for (const { button, staffLine, staffOffset, buttonOffset } of timelineButtonEntries) {
    const buttonPath = `timelineData.staffLines.${staffOffset}.buttons.${buttonOffset}`;
    if (seenTimelineButtonIds.has(button.id)) {
      issues.push(issue('duplicate-timeline-button-entry', `Timeline button ${button.id} appears in more than one staff line.`, 'timelineData.staffLines'));
      continue;
    }
    seenTimelineButtonIds.add(button.id);
    const tableButton = payload.skillButtonTable[button.id];
    if (!button.characterId?.trim() || !selectedCharacters.has(button.characterId)) {
      issues.push(issue('invalid-button-character-id', `Timeline button ${button.id} has no selected characterId.`, `${buttonPath}.characterId`));
    }
    if (!button.characterName?.trim() || button.characterName !== staffLine.characterName) {
      issues.push(issue('invalid-button-character-name', `Timeline button ${button.id} does not match its staff line characterName.`, `${buttonPath}.characterName`));
    }
    if (!validSkillTypes.has(button.skillType)) {
      issues.push(issue('invalid-button-skill-type', `Timeline button ${button.id} needs skillType A, B, E, Q, or Dot.`, `${buttonPath}.skillType`));
    }
    const effectiveLineIndex = button.lineIndex ?? button.staffIndex;
    if (button.staffIndex !== staffLine.staffIndex || effectiveLineIndex !== staffLine.staffIndex) {
      issues.push(issue('timeline-button-staff-mismatch', `Timeline button ${button.id} must target persistent line ${staffLine.staffIndex}.`, buttonPath));
    }
    if (payload.selectedCharacters[staffLine.staffIndex] !== button.characterId) {
      issues.push(issue('timeline-button-character-staff-mismatch', `Timeline button ${button.id} character does not match selectedCharacters[${staffLine.staffIndex}].`, `${buttonPath}.characterId`));
    }
    if (!Number.isInteger(button.nodeIndex) || button.nodeIndex < 0) {
      issues.push(issue('invalid-button-node-index', `Timeline button ${button.id} has an invalid nodeIndex.`, `${buttonPath}.nodeIndex`));
    }
    if (tableButton) {
      for (const property of ['id', 'characterId', 'characterName', 'skillType', 'staffIndex', 'nodeIndex', 'nodeNumber'] as const) {
        if (tableButton[property] !== button[property]) {
          issues.push(issue('timeline-button-table-identity-mismatch', `Timeline button ${button.id} ${property} differs from skillButtonTable.`, `${buttonPath}.${property}`));
        }
      }
      if ((tableButton.lineIndex ?? tableButton.staffIndex) !== effectiveLineIndex) {
        issues.push(issue('timeline-button-table-identity-mismatch', `Timeline button ${button.id} lineIndex differs from skillButtonTable.`, `${buttonPath}.lineIndex`));
      }
      if (tableButton.basicAttackStageCount !== button.basicAttackStageCount
        || JSON.stringify(tableButton.basicAttackTailBundle ?? null)
          !== JSON.stringify(button.basicAttackTailBundle ?? null)) {
        issues.push(issue('timeline-button-table-tail-bundle-mismatch', `Timeline button ${button.id} basic attack tail bundle differs from skillButtonTable.`, `${buttonPath}.basicAttackTailBundle`));
      }
      if (JSON.stringify(tableButton.releaseAnchor ?? null)
          !== JSON.stringify(button.releaseAnchor ?? null)
        || tableButton.timelineModuleKind !== button.timelineModuleKind
        || JSON.stringify(tableButton.forcedWaitConfig ?? null)
          !== JSON.stringify(button.forcedWaitConfig ?? null)
        || JSON.stringify(tableButton.laneWaitConfig ?? null)
          !== JSON.stringify(button.laneWaitConfig ?? null)
        || JSON.stringify(tableButton.operatorSwitchConfig ?? null)
          !== JSON.stringify(button.operatorSwitchConfig ?? null)) {
        issues.push(issue('timeline-button-table-release-mismatch', `Timeline button ${button.id} release anchor or control-module configuration differs from skillButtonTable.`, `${buttonPath}.releaseAnchor`));
      }
      const timelineBuffIds = [...(button.buffIds || [])].sort();
      const tableBuffIds = [...(tableButton.selectedBuff || [])].sort();
      if (JSON.stringify(timelineBuffIds) !== JSON.stringify(tableBuffIds)) {
        issues.push(issue('timeline-button-table-buff-mismatch', `Timeline button ${button.id} Buff ids differ from skillButtonTable.`, `${buttonPath}.buffIds`));
      }
    }
  }

  const buffIds = new Set(payload.allBuffList.map((buff) => buff.id));
  const releaseGraphNodes = Object.values(payload.skillButtonTable).map(button => ({
    id: button.id,
    releaseAnchor: button.releaseAnchor,
  }));
  const validReleaseKinds = new Set(['group-start', 'action-start', 'action-end', 'damage-hit']);
  const validTimelineModuleKinds = new Set(['lane-wait', 'forced-wait', 'dodge', 'perfect-dodge', 'operator-switch']);
  for (const [buttonId, button] of Object.entries(payload.skillButtonTable)) {
    if (button.timelineModuleKind && !validTimelineModuleKinds.has(button.timelineModuleKind)) {
      issues.push(issue('invalid-timeline-module-kind', `Button ${buttonId} has an invalid timeline module kind.`, `skillButtonTable.${buttonId}.timelineModuleKind`));
    }
    const forcedWaitConfig = button.forcedWaitConfig;
    if (forcedWaitConfig) {
      const configPath = `skillButtonTable.${buttonId}.forcedWaitConfig`;
      const invalidFixedDuration = forcedWaitConfig.mode === 'fixed-duration'
        && (!Number.isFinite(forcedWaitConfig.durationSeconds)
          || forcedWaitConfig.durationSeconds <= 0);
      if (button.timelineModuleKind !== 'forced-wait'
        || forcedWaitConfig.schemaVersion !== 1
        || !['seal-only', 'fixed-duration'].includes(forcedWaitConfig.mode)
        || invalidFixedDuration) {
        issues.push(issue('invalid-forced-wait-config', `Button ${buttonId} has an invalid forced-wait configuration.`, configPath));
      }
    }
    const laneWaitConfig = button.laneWaitConfig;
    if (laneWaitConfig) {
      const configPath = `skillButtonTable.${buttonId}.laneWaitConfig`;
      const invalidFixedDuration = laneWaitConfig.mode === 'fixed-duration'
        && (!Number.isFinite(laneWaitConfig.durationSeconds)
          || laneWaitConfig.durationSeconds <= 0);
      if (button.timelineModuleKind !== 'lane-wait'
        || laneWaitConfig.schemaVersion !== 1
        || !['placeholder', 'fixed-duration'].includes(laneWaitConfig.mode)
        || invalidFixedDuration) {
        issues.push(issue('invalid-lane-wait-config', `Button ${buttonId} has an invalid ordinary-wait config.`, configPath));
      }
    }
    const operatorSwitchConfig = button.operatorSwitchConfig;
    if (button.timelineModuleKind === 'operator-switch' && !operatorSwitchConfig) {
      issues.push(issue(
        'missing-operator-switch-config',
        `Button ${buttonId} is missing its operator-switch target.`,
        `skillButtonTable.${buttonId}.operatorSwitchConfig`,
      ));
    }
    if (operatorSwitchConfig) {
      const configPath = `skillButtonTable.${buttonId}.operatorSwitchConfig`;
      if (button.timelineModuleKind !== 'operator-switch'
        || operatorSwitchConfig.schemaVersion !== 1
        || typeof operatorSwitchConfig.targetCharacterId !== 'string'
        || !operatorSwitchConfig.targetCharacterId.trim()
        || operatorSwitchConfig.targetCharacterId === button.characterId
        || !selectedCharacters.has(operatorSwitchConfig.targetCharacterId)) {
        issues.push(issue('invalid-operator-switch-config', `Button ${buttonId} has an invalid operator-switch target.`, configPath));
      }
    }
    const anchor = button.releaseAnchor;
    if (anchor) {
      const releasePath = `skillButtonTable.${buttonId}.releaseAnchor`;
      if (anchor.schemaVersion !== 1
        || !validReleaseKinds.has(anchor.kind)
        || !Number.isInteger(anchor.debounceFrames)
        || anchor.debounceFrames < 0) {
        issues.push(issue('invalid-release-anchor', `Button ${buttonId} has a malformed release anchor.`, releasePath));
      } else if (anchor.kind === 'group-start') {
        if (anchor.sourceButtonId) {
          issues.push(issue('invalid-release-anchor-source', `Group-start button ${buttonId} must not reference another action.`, `${releasePath}.sourceButtonId`));
        }
      } else {
        const sourceButtonId = anchor.sourceButtonId?.trim();
        const source = sourceButtonId ? payload.skillButtonTable[sourceButtonId] : undefined;
        if (!sourceButtonId || !source) {
          issues.push(issue('release-anchor-source-missing', `Button ${buttonId} references a missing release source.`, `${releasePath}.sourceButtonId`));
        } else if (sourceButtonId === buttonId) {
          issues.push(issue('release-anchor-self-reference', `Button ${buttonId} cannot anchor to itself.`, `${releasePath}.sourceButtonId`));
        } else {
          const targetGroup = Math.floor(button.nodeIndex / GRID_NODE_COUNT);
          const sourceGroup = Math.floor(source.nodeIndex / GRID_NODE_COUNT);
          if (targetGroup !== sourceGroup) {
            issues.push(issue('release-anchor-cross-group', `Button ${buttonId} must remain in the same release group as ${sourceButtonId}.`, `${releasePath}.sourceButtonId`));
          }
          if (wouldCreateReleaseCycle(releaseGraphNodes, buttonId, sourceButtonId)) {
            issues.push(issue('release-anchor-cycle', `Button ${buttonId} participates in a release dependency cycle.`, releasePath));
          }
        }
        if (anchor.kind === 'damage-hit'
          && (!anchor.sourceHitId?.trim()
            || !Number.isInteger(anchor.sourceHitOffsetFrames)
            || Number(anchor.sourceHitOffsetFrames) < 0)) {
          issues.push(issue('invalid-release-hit-anchor', `Button ${buttonId} has an invalid damage-hit anchor.`, releasePath));
        }
      }
    }
    for (const buffId of button.selectedBuff || []) {
      if (!buffIds.has(buffId)) {
        issues.push(issue('button-selected-buff-missing', `Button ${buttonId} references missing Buff ${buffId}.`, `skillButtonTable.${buttonId}.selectedBuff`));
      }
    }
    const bundle = button.basicAttackTailBundle;
    if (bundle) {
      const predecessor = payload.skillButtonTable[bundle.predecessorButtonId];
      const successor = payload.skillButtonTable[bundle.successorButtonId];
      if (!predecessor || !successor) {
        issues.push(issue('tail-bundle-peer-missing', `Button ${buttonId} has a basic attack tail bundle with a missing peer.`, `skillButtonTable.${buttonId}.basicAttackTailBundle`));
      } else if (predecessor.skillType !== 'A'
        || predecessor.basicAttackTailBundle?.id !== bundle.id
        || successor.basicAttackTailBundle?.id !== bundle.id
        || predecessor.basicAttackStageCount !== bundle.selectedStageCount
        || !Number.isInteger(bundle.selectedStageCount)
        || bundle.selectedStageCount < 1) {
        issues.push(issue('tail-bundle-invalid', `Button ${buttonId} has an inconsistent basic attack tail bundle.`, `skillButtonTable.${buttonId}.basicAttackTailBundle`));
      }
    }
  }

  return issues.length ? { ok: false, issues } : { ok: true, issues: [] };
}
