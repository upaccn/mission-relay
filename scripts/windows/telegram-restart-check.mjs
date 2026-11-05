// Read-only quiescence gate. Fail closed on errors or ambiguous in-flight sends.
import { DatabaseSync } from 'node:sqlite';

const filename = process.argv[2];
if (!filename) process.exit(2);
let db;
try {
  db = new DatabaseSync(filename, { readOnly: true });
  const active = db.prepare("SELECT count(*) AS n FROM missions WHERE state IN ('RUNNING','VERIFYING')").get().n;
  const unsent = db.prepare("SELECT count(*) AS n FROM channel_commands WHERE source='telegram' AND status!='delivered'").get().n;
  // The browser turn receipts are stored as JSON in meta. A reserved Send may
  // already have reached ChatGPT; never interrupt/replay it by policy.
  const records = db.prepare("SELECT value FROM meta WHERE key LIKE 'chatgpt.browser.active.%'").all();
  const reserved = records.filter(({value}) => JSON.parse(value).status === 'reserved').length;
  if (active || unsent || reserved) {
    console.error('Restart deferred: active missions, pending notifications, or reserved browser Sends.');
    process.exitCode = 3;
  } else {
    console.log('Restart preflight passed: no active Mission, pending notification, or reserved browser Send.');
  }
} catch {
  console.error('Restart preflight failed: cannot verify local SQLite state.');
  process.exitCode = 2;
} finally {
  db?.close();
}
