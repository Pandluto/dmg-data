import assert from 'node:assert/strict';
import { webDatabase } from '../database/webDatabase';
import { persistentWorkspaceStorage as storage } from './persistentStorage';

const originalBatch = webDatabase.batch;
const saved = new Map<string, string | null>();
try {
  webDatabase.batch = async statements => {
    for (const statement of statements) saved.set(String(statement.bind?.[1]), statement.bind?.[2] as string | null);
    return { changes: statements.length, statementChanges: statements.map(() => 1) };
  };
  const saveBatch = webDatabase.batch;
  webDatabase.batch = async () => { throw new Error('storage temporarily unavailable'); };
  storage.setItem('failed-write-retry', 'draft');
  await assert.rejects(storage.flush(), /temporarily unavailable/);
  webDatabase.batch = saveBatch;
  await storage.flush();
  assert.equal(saved.get('failed-write-retry'), 'draft');

  let rejectWrite!: (error: Error) => void;
  webDatabase.batch = () => new Promise((_resolve, reject) => { rejectWrite = reject; });
  storage.setItem('failed-write-retry', 'older');
  const failed = storage.flush();
  await Promise.resolve(); await Promise.resolve();
  storage.setItem('failed-write-retry', 'newer');
  rejectWrite(new Error('write interrupted'));
  await assert.rejects(failed, /interrupted/);
  webDatabase.batch = saveBatch;
  await storage.flush();
  assert.equal(saved.get('failed-write-retry'), 'newer', 'Retry must not overwrite a newer edit with a failed old write');
  storage.removeItem('failed-write-retry'); await storage.flush();
  console.log('PASS persistentStorage: failed writes retry without losing or overwriting newer edits');
} finally { webDatabase.batch = originalBatch; }
