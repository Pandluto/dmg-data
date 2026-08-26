#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AkeDataRepository } from '../src/core/ake-data-repository.mjs';
import { AkeSquadScenarioAssembler } from '../src/core/ake-squad-scenario-assembler.mjs';
import { AkeSquadScenarioRunner } from '../src/core/ake-squad-scenario-runner.mjs';
import { projectAkeTimeline } from '../src/core/ake-timeline-projector.mjs';
import { CommandAdmissionProvider } from '../src/core/command-admission-provider.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(projectRoot, 'derived', 'cleanroom', 'ake-timing-profiles.json');
const enemyId = 'eny_0007_mimicw';
const probeEndFrame = 1_200;

function walkActions(actions, visit) {
    for (const action of actions ?? []) {
        if (!action || typeof action !== 'object') continue;
        visit(action);
        for (const key of ['actions', 'success', 'failure', 'children', 'steps']) {
            if (Array.isArray(action[key])) walkActions(action[key], visit);
        }
        for (const key of ['onApplyTargetActions', 'onRemoveTargetActions']) {
            if (Array.isArray(action.definition?.[key])) {
                walkActions(action.definition[key], visit);
            }
        }
    }
}

function containsHpDamage(actions) {
    let found = false;
    walkActions(actions, action => {
        if (action.type === 'ResolveDamagePacket'
            && (action.damageUnits ?? []).some(unit => unit?.damageAttributeType === 'Hp')) {
            found = true;
        }
    });
    return found;
}

function compiledHitFrames(programs, rootSkillId) {
    const hits = [];
    const visit = (skillId, baseFrame, stack) => {
        if (stack.has(skillId)) return;
        const program = programs.get(skillId);
        if (!program) return;
        const nextStack = new Set(stack).add(skillId);
        for (const group of program.timeline ?? []) {
            const groupFrame = baseFrame + Number(group.startFrame ?? 0);
            if (containsHpDamage(group.actions)) {
                hits.push({
                    offsetFrames: groupFrame,
                    sourceSkillId: skillId,
                    rootSkillId,
                    kind: skillId === rootSkillId ? 'direct' : 'projectile',
                    hitCount: 1,
                    damageTypes: []
                });
            }
            walkActions(group.actions, action => {
                if (action.type !== 'LaunchSkillProgram' || !action.childSkillId) return;
                visit(
                    action.childSkillId,
                    groupFrame + Number(action.launchDelayTicks ?? 0),
                    nextStack
                );
            });
        }
    };
    visit(rootSkillId, 0, new Set());
    return hits.sort((left, right) => left.offsetFrames - right.offsetFrames);
}

function launchOffsetFor(programs, rootSkillId, targetSkillId) {
    const candidates = [];
    const visit = (skillId, baseFrame, stack) => {
        if (stack.has(skillId)) return;
        const program = programs.get(skillId);
        if (!program) return;
        const nextStack = new Set(stack).add(skillId);
        for (const group of program.timeline ?? []) {
            const groupFrame = baseFrame + Number(group.startFrame ?? 0);
            walkActions(group.actions, action => {
                if (action.type !== 'LaunchSkillProgram' || !action.childSkillId) return;
                const launchFrame = groupFrame + Number(action.launchDelayTicks ?? 0);
                if (action.childSkillId === targetSkillId) candidates.push(launchFrame);
                visit(action.childSkillId, launchFrame, nextStack);
            });
        }
    };
    visit(rootSkillId, 0, new Set());
    return candidates.length > 0 ? Math.min(...candidates) : null;
}

function forcedBundle(bundle, commandType, skillId) {
    const members = bundle.members.map(member => {
        const roles = structuredClone(member.roles);
        if (commandType === 'Attack') {
            roles.normalAttackIds = [skillId, ...roles.normalAttackIds.filter(id => id !== skillId)];
        } else if (commandType === 'NormalSkill') {
            roles.normalSkillId = skillId;
        } else if (commandType === 'ComboSkill') {
            roles.comboSkillId = skillId;
        } else if (commandType === 'UltimateSkill') {
            roles.ultimateSkillId = skillId;
        }
        return { ...member, roles };
    });
    return {
        ...bundle,
        members,
        membersById: Object.fromEntries(members.map(member => [member.memberId, member])),
        semanticMappings: commandType === 'ComboSkill'
            ? bundle.semanticMappings.filter(mapping => mapping.actionType !== 'ComboTriggerRule')
            : bundle.semanticMappings
    };
}

function roleProfiles(bundle) {
    const roles = bundle.members[0].roles;
    const entries = [];
    const seen = new Set();
    const add = (commandType, skillId) => {
        if (!skillId || !bundle.programs.has(skillId)) return;
        const key = `${commandType}\u0000${skillId}`;
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({ commandType, skillId });
    };
    for (const skillId of roles.normalAttackIds ?? []) add('Attack', skillId);
    for (const skillId of roles.groups?.normalSkill ?? []) add('NormalSkill', skillId);
    for (const skillId of roles.groups?.comboSkill ?? []) add('ComboSkill', skillId);
    for (const skillId of roles.groups?.ultimateSkill ?? []) {
        if (/(?:^|_)attack0*\d+(?:_|$)/i.test(skillId)) add('Attack', skillId);
        else add('UltimateSkill', skillId);
    }
    const nextVariant = new Map();
    return entries.map(entry => {
        const variantIndex = nextVariant.get(entry.commandType) ?? 0;
        nextVariant.set(entry.commandType, variantIndex + 1);
        return { ...entry, variantIndex };
    });
}

function normalizedFormSourceKey(value) {
    return String(value ?? '')
        .replace(/@status:\d+$/, '')
        .replace(/@command-cast:[^@]+$/, '');
}

function formEventsFromRunner(runner, characterId) {
    const snapshot = runner.lastRuntime?.snapshot();
    if (!snapshot?.skillForms) return [];
    const events = [];
    const pushEntry = (operation, entry, frame) => {
        if (!entry || entry.targetId !== characterId) return;
        const kind = entry.kind === 'SkillMode' ? 'mode' : 'override';
        events.push({
            offsetFrames: Number(frame ?? 0),
            operation,
            kind,
            stateKey: `${kind}:${normalizedFormSourceKey(entry.sourceKey)}`,
            ...(entry.skillSlot ? { skillSlot: entry.skillSlot } : {}),
            ...(entry.targetSkillId ? { targetSkillId: entry.targetSkillId } : {}),
            ...(entry.modeId ? { modeId: entry.modeId } : {})
        });
    };
    for (const trace of snapshot.skillForms.trace ?? []) {
        if (trace.stage === 'SkillOverrideApplied' || trace.stage === 'SkillModeApplied') {
            pushEntry('apply', trace.after, trace.frame);
        } else if (trace.stage === 'SkillOverrideRemoved' || trace.stage === 'SkillModeRemoved') {
            for (const entry of trace.removed ?? []) pushEntry('remove', entry, trace.frame);
        }
    }
    const statusByInstanceId = new Map((snapshot.statusEffects?.instances ?? [])
        .map(instance => [instance.instanceId, instance]));
    for (const entry of [
        ...(snapshot.skillForms.overrides ?? []),
        ...(snapshot.skillForms.modes ?? [])
    ]) {
        const status = statusByInstanceId.get(entry.buffInstanceId);
        if (status?.expireFrame !== null
            && status?.expireFrame !== undefined
            && Number.isFinite(Number(status.expireFrame))) {
            pushEntry('remove', entry, Number(status.expireFrame));
        }
    }
    return events.sort((left, right) => left.offsetFrames - right.offsetFrames
        || (left.operation === right.operation
            ? 0
            : left.operation === 'apply' ? -1 : 1)
        || left.stateKey.localeCompare(right.stateKey));
}

function profileResourceEvents(result, characterId) {
    const executed = (result?.commandTrace ?? []).find(event =>
        event.type === 'CommandExecuted'
        && event.commandId === 'timing-probe'
        && event.success === true
    );
    const castId = executed?.castId ?? null;
    return (result?.resourceTrace ?? []).flatMap(event => {
        if (event.reason === 'PassiveRecovery' || event.stage !== 'ResourceGained') return [];
        if (event.commandId !== 'timing-probe' && (castId === null || event.castId !== castId)) {
            return [];
        }
        const target = event.reason === 'ObtainUspInNormalSkill'
            ? 'team'
            : event.targetId === characterId
                ? 'self'
                : event.targetId
                    ? 'other'
                    : 'shared';
        return [{
            offsetFrames: Number(event.frame ?? 0),
            resourceType: event.resourceType,
            scope: event.scope,
            target,
            gainMethod: event.resourceGainMethod ?? 'Gain',
            amount: Number(event.actualDelta ?? event.actual ?? 0),
            reason: event.reason ?? null
        }];
    });
}

function comboTriggers(bundle, skillIds) {
    return bundle.semanticMappings.flatMap(mapping => {
        if (mapping.actionType !== 'ComboTriggerRule'
            || !skillIds.has(mapping.effect?.comboSkillId)) return [];
        return [{
            id: mapping.id,
            eventType: mapping.eventType,
            rootSkillIds: structuredClone(mapping.selector?.rootSkillIds ?? []),
            sourceSkillIds: structuredClone(mapping.selector?.sourceSkillIds ?? []),
            rootSkillRole: mapping.selector?.rootSkillRole ?? null,
            statusBuffIds: structuredClone(mapping.selector?.statusBuffIds ?? []),
            sourceCommandTypes: structuredClone(mapping.selector?.sourceCommandTypes ?? []),
            requireSourceOtherThanOwner:
                mapping.selector?.requireSourceOtherThanOwner === true,
            damageAttributeType: mapping.selector?.damageAttributeType ?? null,
            occurrence: mapping.selector?.occurrence ?? 'every-event',
            comboSkillId: mapping.effect.comboSkillId,
            pendingDurationFrames: Number(mapping.effect.pendingDurationTicks ?? 0),
            ownerBinding: mapping.effect.ownerBinding ?? 'event-source',
            ownerId: mapping.effect.ownerId ?? null,
            requireComboOffCooldown: mapping.effect.requireComboOffCooldown === true,
            pendingPolicy: mapping.effect.pendingPolicy ?? 'append',
            selectionPolicy: mapping.effect.selectionPolicy ?? 'newest',
            consumePolicy: mapping.effect.consumePolicy ?? 'selected',
            confidence: mapping.confidence ?? 'unknown'
        }];
    });
}

function simulateProfile(
    bundle,
    emptyUspBundle,
    emptyResourcesBundle,
    commandType,
    skillId,
    characterId
) {
    const program = bundle.programs.get(skillId);
    const simulationEndFrame = Math.max(
        probeEndFrame,
        Number(program?.durationFrames ?? 0) + 1,
        Number(program?.exclusiveFrames ?? 0) + 1
    );
    const fallbackHits = compiledHitFrames(bundle.programs, skillId);
    let result = null;
    let resourceResult = null;
    let timeline = null;
    let diagnostic = null;
    let formEvents = [];
    let runner = null;
    try {
        runner = new AkeSquadScenarioRunner(forcedBundle(bundle, commandType, skillId));
        result = runner.run({
            commands: [{
                commandId: 'timing-probe',
                memberId: characterId,
                frame: 0,
                commandType
            }],
            endFrame: simulationEndFrame
        });
        formEvents = formEventsFromRunner(runner, characterId);
        timeline = projectAkeTimeline(result);
        const resourceProbeBundle = ['Attack', 'ComboSkill'].includes(commandType)
            ? emptyResourcesBundle
            : commandType === 'UltimateSkill'
                ? bundle
                : emptyUspBundle;
        resourceResult = new AkeSquadScenarioRunner(
            forcedBundle(resourceProbeBundle, commandType, skillId)
        ).run({
            commands: [{
                commandId: 'timing-probe',
                memberId: characterId,
                frame: 0,
                commandType
            }],
            endFrame: simulationEndFrame
        });
    } catch (error) {
        if (runner) formEvents = formEventsFromRunner(runner, characterId);
        diagnostic = error instanceof Error ? error.message : String(error);
    }

    const settlement = timeline?.commands.find(command => command.commandId === 'timing-probe') ?? null;
    const simulatedHits = (timeline?.hitBursts ?? [])
        .filter(hit => hit.characterId === characterId
            && Number(hit.hpHitCount ?? 0) > 0
            && Math.abs(Number(hit.damage ?? 0)) > 1e-12)
        .map(hit => {
            const positiveHpHits = (hit.hits ?? []).filter(item => (
                item.damageAttributeType === 'Hp'
                && Math.abs(Number(item.atkScale ?? 0)) > 1e-12
                && Math.abs(Number(item.finalDamage ?? item.rawDamage ?? 0)) > 1e-12
            ));
            return {
                offsetFrames: Number(hit.frame ?? 0),
                launchOffsetFrames: hit.skillId && hit.skillId !== skillId
                    ? launchOffsetFor(bundle.programs, skillId, hit.skillId)
                    : null,
                sourceSkillId: hit.skillId ?? skillId,
                rootSkillId: hit.rootSkillId ?? skillId,
                kind: hit.skillId && hit.skillId !== skillId ? 'projectile' : 'direct',
                hitCount: positiveHpHits.length,
                observedAtkScale: positiveHpHits.reduce(
                    (sum, item) => sum + Number(item.atkScale ?? 0),
                    0
                ) / Math.max(1, positiveHpHits.length),
                damageTypes: structuredClone(hit.damageTypes ?? [])
            };
        })
        .filter(hit => hit.hitCount > 0);
    const hits = simulatedHits.length > 0 ? simulatedHits : fallbackHits;
    const exclusiveEndOffset = Number(program?.exclusiveFrames ?? 0) > 0
        ? Number(program.exclusiveFrames)
        : Math.max(0, Number(program?.durationFrames ?? 1) - 1);
    // SkillData.durationFrame is the complete asset/effect lifecycle and can
    // include a persistent field, projectile tail, camera track or idle pad.
    // The command body is the earlier of the runtime release and exclusiveFrame;
    // later real hits stay in tailEndOffset as independent hit events.
    const bodyEndOffset = Number.isFinite(Number(settlement?.endFrame))
        ? Math.min(Number(settlement.endFrame), exclusiveEndOffset)
        : exclusiveEndOffset;
    for (const hit of hits) {
        if (hit.offsetFrames > bodyEndOffset) hit.kind = 'lingering';
    }
    const recoveryPauses = (timeline?.sharedAtb?.recoveryWindows ?? []).map(window => ({
        startOffsetFrames: Number(window.startFrame ?? 0),
        endOffsetFrames: Number(window.endFrame ?? bodyEndOffset)
    }));
    return {
        bodyEndOffset,
        tailEndOffset: Math.max(bodyEndOffset, ...hits.map(hit => hit.offsetFrames), 0),
        hits,
        resourceEvents: profileResourceEvents(resourceResult ?? result, characterId),
        recoveryPauses,
        formEvents,
        derivation: diagnostic ? 'compiled-fallback' : 'isolated-runtime-probe',
        ...(diagnostic ? { diagnostic } : {})
    };
}

const data = new AkeDataRepository({ projectRoot });
const catalog = data.catalog();
const characterProfiles = {};

for (const character of catalog.characters.filter(entry => entry.id !== 'chr_9000_endmin')) {
    const assembleMember = (initialUltimateSp, initialAtb = 300) => new AkeSquadScenarioAssembler({ projectRoot }).assemble({
        enemyId,
        enemyLevel: 90,
        enemyMaxHp: 1_000_000_000_000,
        level: 90,
        skillLevel: 12,
        weaponLevel: 90,
        initialAtb,
        members: [{
            memberId: character.id,
            characterId: character.id,
            initialUltimateSp
        }]
    });
    const bundle = assembleMember(character.maxUltimateSp);
    const emptyUspBundle = assembleMember(0);
    const emptyResourcesBundle = assembleMember(0, 0);
    const admission = new CommandAdmissionProvider({ semanticMappings: bundle.semanticMappings });
    const profiles = roleProfiles(bundle).map(({ commandType, skillId, variantIndex }) => {
        const program = bundle.programs.get(skillId);
        const probe = simulateProfile(
            bundle,
            emptyUspBundle,
            emptyResourcesBundle,
            commandType,
            skillId,
            character.id
        );
        return {
            commandType,
            skillId,
            variantIndex,
            durationFrames: Number(program?.durationFrames ?? 0),
            bodyEndOffset: probe.bodyEndOffset,
            tailEndOffset: probe.tailEndOffset,
            exclusiveFrames: Number(program?.exclusiveFrames ?? 0),
            cooldownFrames: Number(program?.cooldownTicks ?? 0),
            costType: program?.costType ?? null,
            costValue: Number(program?.costValue ?? 0),
            priority: admission.profile(commandType).priority,
            allowNext: structuredClone(program?.allowNextWindows ?? []).map(window => ({
                startOffsetFrames: Number(window.startFrame ?? 0),
                endOffsetFrames: Number(window.endFrame ?? window.startFrame ?? 0),
                allowedSkillIds: structuredClone(window.allowedSkillIds ?? [])
            })),
            commandMappings: (program?.comboMappings ?? []).flatMap(cache =>
                (cache.mappings ?? []).flatMap(mapping => mapping.skillId ? [{
                    commandType: mapping.command,
                    skillId: mapping.skillId
                }] : [])
            ),
            interruptibleAt: (program?.interruptMarks ?? []).map(mark => Number(mark.startFrame ?? 0)),
            hits: probe.hits,
            resourceEvents: probe.resourceEvents,
            recoveryPauses: probe.recoveryPauses,
            formEvents: probe.formEvents,
            derivation: probe.derivation,
            ...(probe.diagnostic ? { diagnostic: probe.diagnostic } : {})
        };
    });
    characterProfiles[character.id] = {
        characterId: character.id,
        maxUltimateSp: Number(character.maxUltimateSp ?? 0),
        initialUltimateSp: Number(character.maxUltimateSp ?? 0),
        comboTriggers: comboTriggers(bundle, new Set(profiles.map(profile => profile.skillId))),
        profiles
    };
}

const atbRule = JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'spec', 'engine-semantic-mappings.json'),
    'utf8'
)).mappings.find(mapping => (
    mapping.actionType === 'ResourceRule' && mapping.selector?.resourceType === 'Atb'
))?.effect;

const output = {
    schemaVersion: 3,
    tickRate: 30,
    nodeFrameScale: 15,
    source: {
        provider: 'AKEDatabase + clean-room AKE runtime',
        sharedRevision: catalog.source.sharedRevision,
        generator: 'scripts/build-ake-timing-profiles.mjs',
        semantics: 'precompiled-temporal-preview-not-final-damage'
    },
    sharedAtb: {
        initial: 300,
        max: 300,
        ratePerSecond: Number(atbRule?.ratePerSecond ?? 8),
        firstTickFrame: Number(atbRule?.firstTickFrame ?? 1),
        resumeDelayFramesAfterSpend: Number(atbRule?.resumeDelayTicksAfterSpend ?? 16),
        quantization: atbRule?.quantization ?? 'float32'
    },
    characters: characterProfiles
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`wrote ${path.relative(projectRoot, outputPath)} (${Object.keys(characterProfiles).length} characters)`);
