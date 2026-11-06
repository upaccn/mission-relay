// Read-only quiescence gate. Fail closed on errors or ambiguous in-flight sends.
import { DatabaseSync } from 'node:sqlite';

const filename = process.argv[2];
if (!filename) {
  console.error('Restart preflight requires the absolute local missions.sqlite path (argument 1).');
  process.exit(2);
}
let db;
try {
  db = new DatabaseSync(filename, { readOnly: true });
  const active = db.prepare("SELECT count(*) AS n FROM missions WHERE state IN ('RUNNING','VERIFYING')").get().n;
  // An accepted PI task can be READY before its first browser reservation.
  // The real SQLite drain already rejects this case; preflight must agree.
  const piReady = db.prepare("SELECT id FROM missions WHERE state='READY'").all().some(({id}) =>
    db.prepare('SELECT value FROM meta WHERE key=?')
      .get(`pi.autopilot.enabled.${id}`)?.value === '1');
  const unsent = db.prepare("SELECT count(*) AS n FROM channel_commands WHERE source='telegram' AND status!='delivered'").get().n;
  // The browser turn receipts are stored as JSON in meta. A reserved Send may
  // already have reached ChatGPT; never interrupt/replay it by policy.
  const records = db.prepare("SELECT value FROM meta WHERE key LIKE 'chatgpt.browser.active.%'").all();
  const reserved = records.filter(({value}) => {
    const receipt=JSON.parse(value);
    if (!receipt || typeof receipt!=='object' || Array.isArray(receipt) ||
      !['reserved','observed','uncertain','reconciled'].includes(receipt.status))
      throw new Error('Invalid browser receipt; fail closed');
    return receipt.status === 'reserved';
  }).length;
  if (active || piReady || unsent || reserved) {
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
