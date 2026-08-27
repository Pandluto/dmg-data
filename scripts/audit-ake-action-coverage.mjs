import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    AKE_BUFF_ACTION_TYPES,
    AKE_SKILL_ACTION_TYPES
} from '../src/core/ake-parser.mjs';
import {
    canonicalEffectType,
    DEFAULT_EFFECT_ACTION_TYPES
} from '../src/core/effect-runtime.mjs';
import {
    AkeActionCompiler,
    classifyAkeActionType
} from '../src/core/ake-action-compiler.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const semanticMappings = JSON.parse(await readFile(
    path.join(projectRoot, 'spec', 'engine-semantic-mappings.json'),
    'utf8'
));
const actionCompiler = new AkeActionCompiler({ semanticMappings });
const sources = [
    {
        dataset: 'BuffData',
        directory: path.join(projectRoot, 'reference', 'public-data', 'akedata', 'Json', 'BuffData'),
        parserTypes: new Set(AKE_BUFF_ACTION_TYPES)
    },
    {
        dataset: 'SkillData',
        directory: path.join(projectRoot, 'reference', 'public-data', 'akedata', 'Json', 'SkillData'),
        parserTypes: new Set(AKE_SKILL_ACTION_TYPES)
    }
];
const effectTypes = new Set(DEFAULT_EFFECT_ACTION_TYPES);
const actionPattern = /(Action|Infliction)$/;
const actionNames = new Set([
    'LaunchProjectile', 'ModifyDynamicBlackboard', 'ReadSkillSettingData',
    'StoreAttributeValue', 'ObtainUspInNormalSkill', 'ModifyResilienceDecreaseFactor',
    'FinishBuffAdvanced', 'FinishBuffByTag', 'SpellInflictionOnChar',
    'InverseSpellInfliction', 'GainBreakingAttackAtb', 'RecoverPoiseAction',
    'JumpToAction', 'MarkCanInterrupt', 'SpawnAbilityEntity', 'AddGlobalCDTimer'
]);
const conditionPattern = /^(Check|Compare|Probablity$|OrCondition|NotNextCheck)/;

function shortType(rawType) {
    return String(rawType).split(',')[0].split('+')[0].split('.').at(-1);
}

function jsonPathPart(key) {
    return /^\d+$/.test(String(key)) ? `[${key}]` : `.${key}`;
}

function counterEntry(map, type) {
    if (!map.has(type)) map.set(type, { type, count: 0, samples: [] });
    return map.get(type);
}

function record(map, type, sample) {
    const entry = counterEntry(map, type);
    entry.count += 1;
    if (entry.samples.length < 3
        && !entry.samples.some(existing => existing.file === sample.file
            && existing.path === sample.path)) entry.samples.push(sample);
    return entry;
}

function recordCompilation(entry, compilation) {
    entry.compiler ??= {
        statusCounts: { executable: 0, 'metadata-only': 0, unresolved: 0 },
        executionRouteCounts: {
            complete: 0,
            'adapter-required': 0,
            blocked: 0,
            'metadata-only': 0
        },
        runtimeActions: 0,
        cleanupActions: 0,
        metadataNodes: 0,
        unresolvedCodes: {}
    };
    const status = compilation.status ?? 'unresolved';
    entry.compiler.statusCounts[status] = (entry.compiler.statusCounts[status] ?? 0) + 1;
    const runtimeActionCount = compilation.actions?.length ?? 0;
    const runtimeConditionCount = compilation.condition ? 1 : 0;
    const cleanupActionCount = compilation.cleanupActions?.length ?? 0;
    const route = status === 'executable'
        ? 'complete'
        : status === 'metadata-only'
            ? 'metadata-only'
            : runtimeActionCount + cleanupActionCount > 0
                ? 'adapter-required'
                : 'blocked';
    entry.compiler.executionRouteCounts[route] += 1;
    entry.compiler.runtimeActions += runtimeActionCount;
    if (runtimeConditionCount > 0) {
        entry.compiler.runtimeConditions =
            (entry.compiler.runtimeConditions ?? 0) + runtimeConditionCount;
    }
    entry.compiler.cleanupActions += cleanupActionCount;
    entry.compiler.metadataNodes += compilation.metadata?.length ?? 0;
    for (const unresolved of compilation.unresolved ?? []) {
        const code = unresolved.code ?? 'UNKNOWN';
        entry.compiler.unresolvedCodes[code] =
            (entry.compiler.unresolvedCodes[code] ?? 0) + 1;
    }
}

function mergeCompilation(target, source) {
    if (!source) return;
    target.compiler ??= {
        statusCounts: { executable: 0, 'metadata-only': 0, unresolved: 0 },
        executionRouteCounts: {
            complete: 0,
            'adapter-required': 0,
            blocked: 0,
            'metadata-only': 0
        },
        runtimeActions: 0,
        cleanupActions: 0,
        metadataNodes: 0,
        unresolvedCodes: {}
    };
    for (const [status, count] of Object.entries(source.statusCounts ?? {})) {
        target.compiler.statusCounts[status] =
            (target.compiler.statusCounts[status] ?? 0) + count;
    }
    for (const [route, count] of Object.entries(source.executionRouteCounts ?? {})) {
        target.compiler.executionRouteCounts[route] =
            (target.compiler.executionRouteCounts[route] ?? 0) + count;
    }
    target.compiler.runtimeActions += source.runtimeActions ?? 0;
    if ((source.runtimeConditions ?? 0) > 0) {
        target.compiler.runtimeConditions =
            (target.compiler.runtimeConditions ?? 0) + source.runtimeConditions;
    }
    target.compiler.cleanupActions += source.cleanupActions ?? 0;
    target.compiler.metadataNodes += source.metadataNodes ?? 0;
    for (const [code, count] of Object.entries(source.unresolvedCodes ?? {})) {
        target.compiler.unresolvedCodes[code] =
            (target.compiler.unresolvedCodes[code] ?? 0) + count;
    }
}

function visit(value, location, buckets) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, {
            ...location,
            path: `${location.path}[${index}]`
        }, buckets));
        return;
    }
    if (value.$type) {
        const type = shortType(value.$type);
        const sample = { file: location.file, path: location.path || '$' };
        record(buckets.serializedTypes, type, sample);
        const isCondition = conditionPattern.test(type);
        if (actionPattern.test(type) || actionNames.has(type)) {
            const entry = record(buckets.actions, type, sample);
            try {
                const compiled = isCondition
                    ? actionCompiler.compileCondition(value, {
                        path: `${location.file}:${location.path || '$'}`,
                        scope: location.scope
                    })
                    : actionCompiler.compileAction(value, {
                        path: `${location.file}:${location.path || '$'}`,
                        // Lifecycle-sensitive actions cannot be judged from an
                        // isolated node without retaining their source dataset.
                        // SkillData actions own timeline-group start/end frames;
                        // BuffData actions instead belong to Buff/event lifetime.
                        scope: location.scope
                    });
                recordCompilation(entry, isCondition ? {
                    ...compiled,
                    status: compiled.unresolved.length > 0
                        ? 'unresolved'
                        : 'executable',
                    actions: [],
                    cleanupActions: [],
                    metadata: []
                } : compiled);
            } catch (error) {
                recordCompilation(entry, {
                    status: 'unresolved',
                    actions: [],
                    cleanupActions: [],
                    metadata: [],
                    unresolved: [{ code: 'AKE_COMPILER_EXCEPTION', message: error.message }]
                });
            }
        }
        if (isCondition) record(buckets.conditions, type, sample);
    }
    for (const [key, child] of Object.entries(value)) {
        visit(child, {
            ...location,
            path: `${location.path}${jsonPathPart(key)}`
        }, buckets);
    }
}

function sorted(map) {
    return [...map.values()].sort((left, right) => right.count - left.count
        || left.type.localeCompare(right.type));
}

const report = {
    schemaVersion: 1,
    source: 'reference/public-data/akedata/Json/{BuffData,SkillData}',
    datasets: {},
    totals: {
        files: 0,
        actionOccurrences: 0,
        uniqueActionTypes: 0,
        parsedOccurrences: 0,
        effectRoutedOccurrences: 0
    }
};
const allActions = new Map();

for (const source of sources) {
    const files = (await readdir(source.directory))
        .filter(file => file.endsWith('.json'))
        .sort();
    const buckets = {
        serializedTypes: new Map(),
        actions: new Map(),
        conditions: new Map()
    };
    for (const file of files) {
        const absolute = path.join(source.directory, file);
        const document = JSON.parse(await readFile(absolute, 'utf8'));
        visit(document, {
            file: path.relative(projectRoot, absolute).replaceAll('\\', '/'),
            path: '$',
            scope: source.dataset === 'SkillData' ? 'skill' : 'buff'
        }, buckets);
    }
    const actions = sorted(buckets.actions).map(entry => {
        const canonicalType = canonicalEffectType(entry.type);
        const result = {
            ...entry,
            parserSupported: source.parserTypes.has(entry.type),
            canonicalEffectType: canonicalType,
            effectRouteAvailable: effectTypes.has(canonicalType),
            classification: classifyAkeActionType(entry.type)
        };
        const combined = counterEntry(allActions, entry.type);
        combined.count += entry.count;
        combined.datasets ??= {};
        combined.datasets[source.dataset] = entry.count;
        combined.samples.push(...entry.samples.slice(0, Math.max(0, 3 - combined.samples.length)));
        combined.parserSupported = Boolean(combined.parserSupported || result.parserSupported);
        combined.canonicalEffectType = canonicalType;
        combined.effectRouteAvailable = Boolean(combined.effectRouteAvailable || result.effectRouteAvailable);
        combined.classification = result.classification;
        mergeCompilation(combined, result.compiler);
        return result;
    });
    const parsedOccurrences = actions
        .filter(entry => entry.parserSupported)
        .reduce((sum, entry) => sum + entry.count, 0);
    const effectRoutedOccurrences = actions
        .filter(entry => entry.effectRouteAvailable)
        .reduce((sum, entry) => sum + entry.count, 0);
    report.datasets[source.dataset] = {
        files: files.length,
        actionOccurrences: actions.reduce((sum, entry) => sum + entry.count, 0),
        uniqueActionTypes: actions.length,
        parsedOccurrences,
        effectRoutedOccurrences,
        actions,
        conditions: sorted(buckets.conditions),
        serializedTypes: sorted(buckets.serializedTypes)
    };
    report.totals.files += files.length;
    report.totals.actionOccurrences += report.datasets[source.dataset].actionOccurrences;
    report.totals.parsedOccurrences += parsedOccurrences;
    report.totals.effectRoutedOccurrences += effectRoutedOccurrences;
}

report.actions = sorted(allActions).map(entry => ({
    ...entry,
    datasets: entry.datasets ?? {},
    parserSupported: Boolean(entry.parserSupported),
    effectRouteAvailable: Boolean(entry.effectRouteAvailable)
}));
report.totals.uniqueActionTypes = report.actions.length;
report.totals.parserCoverage = report.totals.actionOccurrences === 0 ? 0
    : report.totals.parsedOccurrences / report.totals.actionOccurrences;
report.totals.effectRouteCoverage = report.totals.actionOccurrences === 0 ? 0
    : report.totals.effectRoutedOccurrences / report.totals.actionOccurrences;
report.totals.compilerStatuses = report.actions.reduce((totals, entry) => {
    for (const [status, count] of Object.entries(entry.compiler?.statusCounts ?? {})) {
        totals[status] = (totals[status] ?? 0) + count;
    }
    return totals;
}, { executable: 0, 'metadata-only': 0, unresolved: 0 });
report.totals.compilerRoutingCoverage = report.totals.actionOccurrences === 0 ? 0
    : (report.totals.compilerStatuses.executable
        + report.totals.compilerStatuses['metadata-only']) / report.totals.actionOccurrences;
report.totals.compilerExecutionRoutes = report.actions.reduce((totals, entry) => {
    for (const [route, count] of Object.entries(entry.compiler?.executionRouteCounts ?? {})) {
        totals[route] = (totals[route] ?? 0) + count;
    }
    return totals;
}, { complete: 0, 'adapter-required': 0, blocked: 0, 'metadata-only': 0 });
report.totals.executableRouteCoverage = report.totals.actionOccurrences === 0 ? 0
    : (report.totals.compilerExecutionRoutes.complete
        + report.totals.compilerExecutionRoutes['adapter-required'])
        / report.totals.actionOccurrences;
report.totals.categoryOccurrences = report.actions.reduce((totals, entry) => {
    const category = entry.classification.category;
    totals[category] = (totals[category] ?? 0) + entry.count;
    return totals;
}, {});
report.totals.gameplayOccurrences = report.actions
    .filter(entry => !['presentation', 'timeline'].includes(entry.classification.category))
    .reduce((sum, entry) => sum + entry.count, 0);
report.totals.gameplayExecutableOccurrences = report.actions
    .filter(entry => !['presentation', 'timeline'].includes(entry.classification.category))
    .reduce((sum, entry) => sum + (entry.compiler?.statusCounts.executable ?? 0), 0);
report.totals.gameplayMetadataOnlyOccurrences = report.actions
    .filter(entry => !['presentation', 'timeline'].includes(entry.classification.category))
    .reduce((sum, entry) => sum + (entry.compiler?.statusCounts['metadata-only'] ?? 0), 0);
report.totals.gameplayUnresolvedOccurrences = report.actions
    .filter(entry => !['presentation', 'timeline'].includes(entry.classification.category))
    .reduce((sum, entry) => sum + (entry.compiler?.statusCounts.unresolved ?? 0), 0);
report.totals.gameplayCompilerCoverage = report.totals.gameplayOccurrences === 0 ? 0
    : report.totals.gameplayExecutableOccurrences / report.totals.gameplayOccurrences;
report.totals.gameplayExecutableRouteOccurrences = report.actions
    .filter(entry => !['presentation', 'timeline'].includes(entry.classification.category))
    .reduce((sum, entry) => sum
        + (entry.compiler?.executionRouteCounts.complete ?? 0)
        + (entry.compiler?.executionRouteCounts['adapter-required'] ?? 0), 0);
report.totals.gameplayExecutableRouteCoverage = report.totals.gameplayOccurrences === 0 ? 0
    : report.totals.gameplayExecutableRouteOccurrences / report.totals.gameplayOccurrences;
const calculatorCoreCategories = new Set([
    'logic', 'buff', 'damage', 'resource', 'control', 'recovery', 'condition'
]);
report.totals.calculatorCore = report.actions
    .filter(entry => calculatorCoreCategories.has(entry.classification.category))
    .reduce((totals, entry) => {
        totals.occurrences += entry.count;
        totals.complete += entry.compiler?.executionRouteCounts.complete ?? 0;
        totals.adapterRequired +=
            entry.compiler?.executionRouteCounts['adapter-required'] ?? 0;
        totals.blocked += entry.compiler?.executionRouteCounts.blocked ?? 0;
        totals.metadataOnly +=
            entry.compiler?.executionRouteCounts['metadata-only'] ?? 0;
        return totals;
    }, {
        categories: [...calculatorCoreCategories],
        occurrences: 0,
        complete: 0,
        adapterRequired: 0,
        blocked: 0,
        metadataOnly: 0
    });
report.totals.calculatorCore.completeCoverage = report.totals.calculatorCore.occurrences === 0
    ? 0
    : report.totals.calculatorCore.complete / report.totals.calculatorCore.occurrences;
report.totals.calculatorCore.executableRouteCoverage =
    report.totals.calculatorCore.occurrences === 0
        ? 0
        : (report.totals.calculatorCore.complete
            + report.totals.calculatorCore.adapterRequired)
            / report.totals.calculatorCore.occurrences;

const outputPath = path.join(projectRoot, 'derived', 'cleanroom', 'ake-action-coverage.json');
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({
    output: path.relative(projectRoot, outputPath).replaceAll('\\', '/'),
    totals: report.totals,
    topUnparsed: report.actions.filter(entry => !entry.parserSupported).slice(0, 20),
    parsedWithoutEffectRoute: report.actions.filter(entry =>
        entry.parserSupported && !entry.effectRouteAvailable
    )
}, null, 2));
