#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';

import { RiaArchive } from '../src/ria/archive.mjs';
import { newRiaId } from '../src/ria/common.mjs';
import { recordNodeTestFailure } from '../src/ria/test-reporter.mjs';

function parse(argv) {
    const options = {};
    const testArgs = [];
    let passthrough = false;
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--') {
            passthrough = true;
            continue;
        }
        if (passthrough || !value.startsWith('--ria-')) {
            testArgs.push(value);
            continue;
        }
        const key = value.slice('--ria-'.length);
        const next = argv[index + 1];
        if (next === undefined || next === '--' || next.startsWith('--ria-')) {
            throw new Error(`${value} requires a value.`);
        }
        options[key] = next;
        index += 1;
    }
    return { options, testArgs };
}

function appendTail(current, chunk, maximum = 200_000) {
    const next = `${current}${chunk.toString('utf8')}`;
    return next.length > maximum ? next.slice(-maximum) : next;
}

function failingNames(output) {
    return [
        ...output.matchAll(/^not ok \d+ - (.+)$/gm),
        ...output.matchAll(/^✖\s+(.+?)(?:\s+\([\d.]+ms\))?$/gm)
    ]
        .map(match => match[1].trim())
        .filter(Boolean)
        .slice(0, 200);
}

const { options, testArgs } = parse(process.argv.slice(2));
const projectRoot = path.resolve(options['project-root'] ?? new URL('..', import.meta.url).pathname);
const archiveRoot = options['archive-root'] ? path.resolve(options['archive-root']) : null;
const caseId = options['case-id'] ?? newRiaId('case-test-failure');
const sessionId = options['session-id'] ?? newRiaId('session-test-failure');
const runId = options['run-id'] ?? newRiaId('run-test-failure');
const childArgs = ['--test', ...testArgs];
const child = spawn(process.execPath, childArgs, {
    cwd: projectRoot,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false
});
let stdoutTail = '';
let stderrTail = '';
child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    stdoutTail = appendTail(stdoutTail, chunk);
});
child.stderr.on('data', chunk => {
    process.stderr.write(chunk);
    stderrTail = appendTail(stderrTail, chunk);
});

const completion = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
});

if (completion.code !== 0) {
    try {
        const archive = await new RiaArchive({ projectRoot, archiveRoot }).initialize();
        try {
            await archive.getCase(caseId);
        } catch (error) {
            if (error.code !== 'RIA_CASE_NOT_FOUND') throw error;
            await archive.createCase({
                caseId,
                title: 'Opt-in Node test failure investigation',
                description: 'Automatically created only because the RIA test wrapper observed a failure.'
            });
        }
        try {
            await archive.getSession(caseId, sessionId);
        } catch (error) {
            if (error.code !== 'RIA_SESSION_NOT_FOUND') throw error;
            await archive.createSession({
                caseId,
                sessionId,
                summary: 'Node test failure capture',
                actor: 'ria-node-test'
            });
        }
        if (options['thread-id']) {
            await archive.appendSessionEntry(caseId, sessionId, {
                type: 'thread-link',
                actor: 'ria-node-test',
                content: 'Failure capture was requested from a Codex task.',
                threadId: options['thread-id'],
                threadSource: options['thread-source'] ?? 'codex'
            });
        }
        const names = failingNames(`${stdoutTail}\n${stderrTail}`);
        await recordNodeTestFailure({
            archive,
            caseId,
            sessionId,
            runId,
            argv: childArgs,
            exitCode: completion.code,
            signal: completion.signal,
            testNames: names,
            stdoutTail,
            stderrTail
        });
        process.stderr.write(`RIA_TEST_FAILURE_RUN ${caseId}/${sessionId}/${runId}\n`);
    } catch (error) {
        process.stderr.write(`RIA_TEST_FAILURE_ARCHIVE_ERROR ${error.code ?? error.name}: ${error.message}\n`);
    }
}

process.exitCode = completion.code;
