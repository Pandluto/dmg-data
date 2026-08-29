#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RiaArchive } from './archive.mjs';
import { normalizeBoolean, RiaInputError } from './common.mjs';
import { recordFixtureRun, replayArchivedRun } from './execute.mjs';
import { createRiaServer } from './server.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(moduleDirectory, '..', '..');

function parseArguments(argv) {
    const positionals = [];
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith('--')) {
            positionals.push(argument);
            continue;
        }
        const separator = argument.indexOf('=');
        if (separator !== -1) {
            options[argument.slice(2, separator)] = argument.slice(separator + 1);
            continue;
        }
        const key = argument.slice(2);
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
            options[key] = next;
            index += 1;
        } else {
            options[key] = true;
        }
    }
    return { positionals, options };
}

function option(options, name, fallback = undefined) {
    return options[name] ?? fallback;
}

function required(options, name) {
    const value = option(options, name);
    if (value === undefined || value === true || String(value).length === 0) {
        throw new RiaInputError(`--${name} is required.`);
    }
    return String(value);
}

function numberOption(options, name, fallback) {
    const raw = option(options, name, fallback);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new RiaInputError(`--${name} must be numeric.`);
    return value;
}

function output(value, json, label = null) {
    if (json || typeof value !== 'object' || value === null) {
        process.stdout.write(`${json ? JSON.stringify(value) : String(value)}\n`);
        return;
    }
    if (label) process.stdout.write(`${label}\n`);
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
    return `Replayable Investigation Archive (RIA)

Usage:
  npm run ria -- server [--port 43822]
  npm run ria -- case create --title TEXT [--case-id ID]
  npm run ria -- case close --case-id ID [--resolution TEXT]
  npm run ria -- session create --case-id ID [--summary TEXT] [--session-id ID]
  npm run ria -- session append --case-id ID --session-id ID --type TYPE --content TEXT
  npm run ria -- session entries --case-id ID --session-id ID [--after-sequence N]
  npm run ria -- record --case-id ID --session-id ID --fixture FILE
  npm run ria -- run --case-id ID --session-id ID --fixture FILE
  npm run ria -- list cases|sessions|runs [--case-id ID] [--session-id ID]
  npm run ria -- show case|session|run|manifest|fixture|commands|events|snapshots|assertions|result|ui-actions|findings|state ...
  npm run ria -- replay --run-id ID [--case-id ID]
  npm run ria -- diff --left-run-id ID --right-run-id ID
  npm run ria -- doctor
  npm run ria -- verify [--run-id ID]
  npm run ria -- rebuild-index
  npm run ria -- prune --case-id ID [--apply]

Global options: --project-root PATH --archive-root PATH --json
`;
}

export async function runCli(argv = process.argv.slice(2)) {
    const { positionals, options } = parseArguments(argv);
    const json = normalizeBoolean(options.json, false);
    const projectRoot = path.resolve(String(option(options, 'project-root', defaultProjectRoot)));
    const archiveRoot = option(options, 'archive-root') === undefined
        ? null
        : path.resolve(String(options['archive-root']));
    const archive = await new RiaArchive({ projectRoot, archiveRoot }).initialize();
    const [command, subcommand] = positionals;

    if (!command || ['help', '-h'].includes(command)) {
        process.stdout.write(help());
        return { ok: true };
    }
    if (command === 'server') {
        const host = String(option(options, 'host', '127.0.0.1'));
        const service = createRiaServer({
            archive,
            host,
            port: numberOption(options, 'port', 43822),
            allowRemote: normalizeBoolean(options['allow-remote'], false)
        });
        const address = await service.listen();
        output({
            ok: true,
            service: 'replayable-investigation-archive',
            ...address,
            archiveRoot: archive.root
        }, json, 'RIA server started');
        await new Promise(resolve => {
            let closing = false;
            const close = async () => {
                if (closing) return;
                closing = true;
                await service.close();
                resolve();
            };
            process.once('SIGINT', close);
            process.once('SIGTERM', close);
        });
        return { ok: true };
    }
    if (command === 'case' && subcommand === 'create') {
        const result = await archive.createCase({
            ...(options['case-id'] === undefined ? {} : { caseId: String(options['case-id']) }),
            title: required(options, 'title'),
            description: String(option(options, 'description', '')),
            tags: String(option(options, 'tags', '')).split(',').filter(Boolean),
            policy: {
                retentionDays: options['retention-days'] === undefined
                    ? null
                    : numberOption(options, 'retention-days'),
                maxRuns: options['max-runs'] === undefined
                    ? null
                    : numberOption(options, 'max-runs'),
                compression: String(option(options, 'compression', 'none'))
            }
        });
        output(result, json, `Created case ${result.caseId}`);
        return result;
    }
    if (command === 'case' && subcommand === 'close') {
        const result = await archive.closeCase(required(options, 'case-id'), {
            resolution: String(option(options, 'resolution', ''))
        });
        output(result, json, `Closed case ${result.caseId}`);
        return result;
    }
    if (command === 'session' && subcommand === 'create') {
        const result = await archive.createSession({
            caseId: required(options, 'case-id'),
            ...(options['session-id'] === undefined
                ? {}
                : { sessionId: String(options['session-id']) }),
            summary: String(option(options, 'summary', '')),
            actor: String(option(options, 'actor', 'codex'))
        });
        output(result, json, `Created session ${result.sessionId}`);
        return result;
    }
    if (command === 'session' && subcommand === 'append') {
        const entry = {
            type: required(options, 'type'),
            content: required(options, 'content'),
            actor: String(option(options, 'actor', 'codex')),
            ...(options['run-id'] === undefined ? {} : { runId: String(options['run-id']) }),
            ...(options['related-run-id'] === undefined
                ? {}
                : { relatedRunId: String(options['related-run-id']) }),
            ...(options.relation === undefined ? {} : { relation: String(options.relation) }),
            ...(options.commit === undefined ? {} : { commit: String(options.commit) }),
            ...(options['thread-id'] === undefined
                ? {}
                : { threadId: String(options['thread-id']) }),
            ...(options['thread-source'] === undefined
                ? {}
                : { threadSource: String(options['thread-source']) }),
            metadata: options.metadata === undefined ? {} : JSON.parse(String(options.metadata))
        };
        const result = await archive.appendSessionEntry(
            required(options, 'case-id'),
            required(options, 'session-id'),
            entry
        );
        output(result, json, `Appended session entry ${result.sequence}`);
        return result;
    }
    if (command === 'session' && subcommand === 'entries') {
        const result = await archive.listSessionEntries(
            required(options, 'case-id'),
            required(options, 'session-id'),
            {
                afterSequence: option(options, 'after-sequence', 0),
                limit: option(options, 'limit', 100),
                ...(options.type === undefined ? {} : { type: String(options.type) })
            }
        );
        output(result, json, `Found ${result.items.length} session entries`);
        return result;
    }
    if (['record', 'run'].includes(command)) {
        const fixturePath = path.resolve(required(options, 'fixture'));
        const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
        const result = await recordFixtureRun({
            archive,
            caseId: required(options, 'case-id'),
            sessionId: required(options, 'session-id'),
            ...(options['run-id'] === undefined ? {} : { runId: String(options['run-id']) }),
            fixture,
            seed: option(options, 'seed', null),
            config: {
                explicitRecording: true,
                compression: String(option(options, 'compression', 'none')),
                fixturePath
            },
            findings: String(option(options, 'findings', ''))
        });
        const summary = {
            caseId: result.caseId,
            sessionId: result.sessionId,
            runId: result.runId,
            status: result.manifest.status,
            eventCount: result.manifest.counts.events,
            contentHash: result.manifest.contentHash,
            resultHash: result.assertions.checks[0]?.actualHash ?? null
        };
        output(summary, json, `Recorded run ${result.runId}`);
        return summary;
    }
    if (command === 'list') {
        let result;
        if (subcommand === 'cases') result = await archive.listCases();
        else if (subcommand === 'sessions') result = await archive.listSessions(required(options, 'case-id'));
        else if (subcommand === 'runs') result = await archive.listRuns({
            caseId: option(options, 'case-id', null),
            sessionId: option(options, 'session-id', null),
            status: option(options, 'status', null)
        });
        else throw new RiaInputError('list requires cases, sessions or runs.');
        output({ items: result }, json, `Found ${result.length} ${subcommand}`);
        return result;
    }
    if (command === 'show') {
        let result;
        if (subcommand === 'case') result = await archive.getCase(required(options, 'case-id'));
        else if (subcommand === 'session') result = await archive.getSession(
            required(options, 'case-id'),
            required(options, 'session-id')
        );
        else if (subcommand === 'run') result = await archive.getRun(
            required(options, 'run-id'),
            option(options, 'case-id', null)
        );
        else if (subcommand === 'state') result = await archive.stateAtFrame(
            required(options, 'run-id'),
            numberOption(options, 'frame', 0),
            option(options, 'case-id', null)
        );
        else if (subcommand === 'events') result = await archive.queryEvents(
            required(options, 'run-id'),
            {
                afterSequence: option(options, 'after-sequence', 0),
                fromFrame: option(options, 'from-frame'),
                toFrame: option(options, 'to-frame'),
                eventType: option(options, 'event-type'),
                actorId: option(options, 'actor-id'),
                targetId: option(options, 'target-id'),
                rootCastId: option(options, 'root-cast-id'),
                childCastId: option(options, 'child-cast-id'),
                cursor: option(options, 'cursor'),
                limit: option(options, 'limit', 100)
            },
            option(options, 'case-id', null)
        );
        else if (['manifest', 'fixture', 'commands', 'snapshots', 'assertions', 'result', 'ui-actions', 'findings'].includes(subcommand)) {
            result = await archive.readRunArtifact(
                required(options, 'run-id'),
                subcommand === 'ui-actions' ? 'uiActions' : subcommand,
                option(options, 'case-id', null)
            );
        } else throw new RiaInputError('Unknown show target.');
        output(result, json);
        return result;
    }
    if (command === 'replay') {
        const result = await replayArchivedRun({
            archive,
            runId: required(options, 'run-id'),
            caseId: option(options, 'case-id', null),
            sessionId: option(options, 'session-id', null),
            replayRunId: option(options, 'replay-run-id')
        });
        output(result, json, `Replay ${result.replayRunId}: ${result.deterministic ? 'deterministic' : 'diverged'}`);
        return result;
    }
    if (command === 'diff') {
        const result = await archive.diffRuns(
            required(options, 'left-run-id'),
            required(options, 'right-run-id'),
            {
                leftCaseId: option(options, 'left-case-id', null),
                rightCaseId: option(options, 'right-case-id', null)
            }
        );
        output(result, json, result.firstDivergence.identical ? 'Runs are identical' : 'Run divergence found');
        return result;
    }
    if (command === 'doctor') {
        const result = await archive.doctor();
        output(result, json, result.ok ? 'RIA archive is healthy' : 'RIA archive has errors');
        if (!result.ok) process.exitCode = 1;
        return result;
    }
    if (command === 'verify') {
        const result = options['run-id']
            ? await archive.verifyRun(required(options, 'run-id'), option(options, 'case-id', null))
            : await archive.doctor();
        output(result, json, result.ok ? 'Verification passed' : 'Verification failed');
        if (!result.ok) process.exitCode = 1;
        return result;
    }
    if (command === 'rebuild-index') {
        const result = await archive.rebuildIndex();
        output(result, json, `Rebuilt index with ${result.runs.length} runs`);
        return result;
    }
    if (command === 'prune') {
        const result = await archive.prune({
            caseId: required(options, 'case-id'),
            apply: normalizeBoolean(options.apply, false)
        });
        output(result, json, result.applied
            ? `Moved ${result.moved.length} run(s) to recoverable trash`
            : `Retention dry-run found ${result.candidates.length} candidate(s)`);
        return result;
    }
    throw new RiaInputError(`Unknown RIA command: ${positionals.join(' ')}`);
}

const isMain = process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
    runCli().catch(error => {
        const payload = {
            error: {
                code: error.code ?? 'RIA_CLI_ERROR',
                message: error.message,
                run: error.riaRun ?? null
            }
        };
        const json = process.argv.includes('--json');
        process.stderr.write(`${json ? JSON.stringify(payload) : `${payload.error.code}: ${payload.error.message}${payload.error.run ? `\nPreserved run: ${payload.error.run.runId}` : ''}`}\n`);
        process.exitCode = 1;
    });
}
