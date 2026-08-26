import { isDeepStrictEqual } from 'node:util';

import { AkeScenarioAssembler } from './ake-scenario-assembler.mjs';

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function identifier(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${label} must be a non-empty string.`);
    }
    return value;
}

function nonNegativeNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new TypeError(`${label} must be a non-negative finite number.`);
    }
    return number;
}

function positiveInteger(value, label) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) {
        throw new TypeError(`${label} must be a positive integer.`);
    }
    return number;
}

function mergeMap(target, source, label) {
    for (const [id, value] of source ?? []) {
        if (!target.has(id)) {
            target.set(id, value);
            continue;
        }
        if (!isDeepStrictEqual(target.get(id), value)) {
            throw new Error(`${label} ${id} resolves to conflicting definitions across squad members.`);
        }
    }
}

function selectedDefinition(definitions, predicate, label) {
    const selected = (definitions ?? []).filter(predicate);
    if (selected.length !== 1) {
        throw new Error(`Expected exactly one ${label}; found ${selected.length}.`);
    }
    return selected[0];
}

function normalizedMembers(members) {
    if (!Array.isArray(members) || members.length < 1 || members.length > 4) {
        throw new TypeError('members must contain one to four squad members.');
    }
    const normalized = members.map((member, index) => {
        if (!isRecord(member)) throw new TypeError(`members[${index}] must be an object.`);
        const characterId = identifier(member.characterId, `members[${index}].characterId`);
        const memberId = identifier(
            member.memberId ?? member.uuid ?? `member-${index + 1}`,
            `members[${index}].memberId`
        );
        return {
            ...clone(member),
            memberId,
            uuid: memberId,
            characterId,
            squadIndex: index
        };
    });
    const memberIds = new Set(normalized.map(member => member.memberId));
    if (memberIds.size !== normalized.length) {
        throw new Error('Squad memberId/uuid values must be unique.');
    }
    const characterIds = new Set(normalized.map(member => member.characterId));
    if (characterIds.size !== normalized.length) {
        throw new Error('A squad cannot contain the same character more than once.');
    }
    return normalized;
}

/**
 * Builds one runtime bundle for a complete squad. Every character still goes
 * through the audited single-character AKEDatabase join, then the bundles are
 * merged around one enemy entity and one shared ATB pool.
 */
export class AkeSquadScenarioAssembler {
    constructor(options = {}) {
        this.singleAssembler = new AkeScenarioAssembler(options);
    }

    assemble(options = {}) {
        if (!isRecord(options)) throw new TypeError('assemble options must be an object.');
        const members = normalizedMembers(options.members);
        const enemyId = identifier(options.enemyId, 'enemyId');
        const enemyLevel = positiveInteger(
            options.enemyLevel ?? options.level ?? 1,
            'enemyLevel'
        );
        const initialAtb = nonNegativeNumber(options.initialAtb ?? 300, 'initialAtb');
        const maxAtb = nonNegativeNumber(options.maxAtb ?? 300, 'maxAtb');
        if (initialAtb > maxAtb) throw new RangeError('initialAtb cannot exceed maxAtb.');

        const {
            members: ignoredMembers,
            squadId: ignoredSquadId,
            ...commonOptions
        } = options;
        const assembled = members.map(member => this.singleAssembler.assemble({
            ...commonOptions,
            ...member,
            characterId: member.characterId,
            enemyId,
            enemyLevel,
            initialAtb,
            maxAtb
        }));
        const first = assembled[0];
        const programs = new Map();
        const rawSkills = new Map();
        const buffs = new Map();
        const rawBuffs = new Map();
        for (const bundle of assembled) {
            mergeMap(programs, bundle.programs, 'Skill program');
            mergeMap(rawSkills, bundle.rawSkills, 'Raw skill');
            mergeMap(buffs, bundle.buffs, 'Buff definition');
            mergeMap(rawBuffs, bundle.rawBuffs, 'Raw Buff');
            if (!isDeepStrictEqual(bundle.semanticMappings, first.semanticMappings)) {
                throw new Error('Squad members were assembled with different semantic mappings.');
            }
        }

        const enemy = selectedDefinition(
            first.definitions.entities,
            entity => entity.id === enemyId,
            `enemy definition ${enemyId}`
        );
        for (const bundle of assembled.slice(1)) {
            const candidate = selectedDefinition(
                bundle.definitions.entities,
                entity => entity.id === enemyId,
                `enemy definition ${enemyId}`
            );
            if (!isDeepStrictEqual(candidate, enemy)) {
                throw new Error('Squad members resolved different enemy definitions. Set enemyLevel and enemy overrides at squad scope.');
            }
        }
        const sharedAtb = selectedDefinition(
            first.definitions.resources,
            pool => pool.resourceType === 'Atb' && pool.scope === 'Shared',
            'shared ATB pool'
        );
        const memberRecords = assembled.map((bundle, index) => {
            const input = members[index];
            const entity = selectedDefinition(
                bundle.definitions.entities,
                candidate => candidate.id === input.characterId,
                `character definition ${input.characterId}`
            );
            const ultimateSp = selectedDefinition(
                bundle.definitions.resources,
                pool => pool.resourceType === 'UltimateSp'
                    && pool.scope === 'Entity'
                    && pool.ownerId === input.characterId,
                `Ultimate SP pool for ${input.characterId}`
            );
            return {
                memberId: input.memberId,
                uuid: input.memberId,
                squadIndex: input.squadIndex,
                characterId: input.characterId,
                identity: clone(bundle.identity),
                roles: clone(bundle.roles),
                parameters: clone(bundle.parameters),
                entity: clone(entity),
                ultimateSp: clone(ultimateSp),
                loadoutEffects: clone(bundle.loadoutEffects ?? []),
                intrinsicPassives: clone(bundle.intrinsicPassives ?? []),
                diagnostics: clone(bundle.diagnostics ?? [])
            };
        });
        const definitions = {
            entities: [
                ...memberRecords.map(member => member.entity),
                clone(enemy)
            ],
            resources: [
                clone(sharedAtb),
                ...memberRecords.map(member => member.ultimateSp)
            ],
            buffs: Object.fromEntries(buffs)
        };
        const diagnostics = memberRecords.flatMap(member => member.diagnostics.map(entry => ({
            memberId: member.memberId,
            characterId: member.characterId,
            ...clone(entry)
        })));
        const unresolved = assembled.flatMap((bundle, index) =>
            (bundle.compiler?.unresolved ?? []).map(entry => ({
                memberId: members[index].memberId,
                characterId: members[index].characterId,
                ...clone(entry)
            }))
        );
        const squadId = identifier(
            options.squadId ?? `squad:${members.map(member => member.memberId).join('+')}`,
            'squadId'
        );

        return {
            schemaVersion: 1,
            tickRate: first.tickRate,
            identity: {
                squadId,
                enemyId,
                enemyLevel,
                characterIds: memberRecords.map(member => member.characterId),
                memberIds: memberRecords.map(member => member.memberId)
            },
            members: memberRecords,
            membersById: Object.fromEntries(memberRecords.map(member => [member.memberId, member])),
            memberIdByCharacterId: Object.fromEntries(memberRecords.map(member => [
                member.characterId,
                member.memberId
            ])),
            rolesByCharacterId: Object.fromEntries(memberRecords.map(member => [
                member.characterId,
                clone(member.roles)
            ])),
            programs,
            rawSkills,
            buffs,
            rawBuffs,
            definitions,
            semanticMappings: clone(first.semanticMappings),
            sourcePaths: {
                tables: clone(first.sourcePaths.tables),
                members: Object.fromEntries(assembled.map((bundle, index) => [
                    members[index].memberId,
                    clone(bundle.sourcePaths)
                ]))
            },
            parameters: {
                source: clone(first.parameters.source),
                enemyAttributes: clone(first.parameters.enemyAttributes),
                enemyMaxHp: first.parameters.enemyMaxHp,
                enemyMaxResilience: first.parameters.enemyMaxResilience,
                sharedAtb: {
                    initial: initialAtb,
                    max: maxAtb,
                    passiveRecovery: clone(sharedAtb.passiveRecovery)
                },
                members: Object.fromEntries(memberRecords.map(member => [
                    member.memberId,
                    clone(member.parameters)
                ]))
            },
            dependencySummary: {
                memberCount: memberRecords.length,
                programCount: programs.size,
                buffCount: buffs.size,
                loadoutEffectCount: memberRecords.reduce(
                    (sum, member) => sum + member.loadoutEffects.length,
                    0
                ),
                intrinsicPassiveCount: memberRecords.reduce(
                    (sum, member) => sum + member.intrinsicPassives.length,
                    0
                ),
                missingSkillCount: diagnostics.filter(item =>
                    item.code === 'AKE_SKILL_DATA_MISSING').length,
                missingBuffCount: diagnostics.filter(item =>
                    item.code === 'AKE_BUFF_DATA_MISSING').length
            },
            compiler: {
                unresolved,
                unresolvedCodes: Object.fromEntries([...new Set(unresolved.map(item => item.code))]
                    .map(code => [
                        code,
                        unresolved.filter(item => item.code === code).length
                    ]))
            },
            diagnostics
        };
    }
}

export function serializableAkeSquadScenario(bundle) {
    if (!isRecord(bundle)) throw new TypeError('bundle must be an assembled squad object.');
    return {
        ...clone({
            ...bundle,
            programs: undefined,
            rawSkills: undefined,
            buffs: undefined,
            rawBuffs: undefined
        }),
        programs: Object.fromEntries(bundle.programs ?? []),
        buffs: Object.fromEntries(bundle.buffs ?? [])
    };
}

export default AkeSquadScenarioAssembler;
