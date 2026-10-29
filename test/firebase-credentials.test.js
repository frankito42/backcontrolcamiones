import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFirebaseServiceAccountJson } from '../src/push-notifications.js';

test('parses a Firebase service account from an environment variable', () => {
  const serviceAccount = {
    project_id: 'firebase-project',
    client_email: 'firebase@example.test',
    private_key: 'private-key',
  };

  assert.deepEqual(
    parseFirebaseServiceAccountJson(JSON.stringify(serviceAccount)),
    serviceAccount,
  );
});

test('rejects invalid Firebase JSON without echoing its contents', () => {
  assert.throws(
    () => parseFirebaseServiceAccountJson('sensitive-invalid-value'),
    (error) => {
      assert.match(error.message, /JSON válido/);
      assert.doesNotMatch(error.message, /sensitive-invalid-value/);
      return true;
    },
  );
});

test('rejects service account JSON missing required credential fields', () => {
  assert.throws(
    () => parseFirebaseServiceAccountJson(JSON.stringify({ project_id: 'project' })),
    /project_id, client_email y private_key/,
  );
});
