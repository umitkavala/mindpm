import type Database from 'better-sqlite3';
import { UI_ACTOR } from '../domain/lifecycle.js';
import {
  authenticateVerifier, finishVerification, recordChecks, recordCriteria, registerVerifier, startVerification, type VerifierKind,
} from '../domain/verification.js';

export function registerTestVerifier(db: Database.Database, name = 'local-1', kind: VerifierKind = 'local', projectIds = ['*']): string {
  return registerVerifier(db, { name, kind, project_ids: projectIds }, UI_ACTOR).key;
}

// Run a full local verification in which every planned check exits 0 and
// every criterion (except those listed in fail) passes.
export function runVerification(db: Database.Database, key: string, taskRef: string, fail: string[] = []) {
  const verifier = authenticateVerifier(db, key);
  const run = startVerification(db, verifier, taskRef);
  if (run.checks.length) {
    recordChecks(db, verifier, run.run_id, run.checks.map(c => ({ ...c, exit_code: 0, duration_ms: 10, output_tail: 'ok' })), run.head_sha);
  }
  const local = run.criteria.filter(c => c.verify_kind !== 'review');
  if (local.length) {
    recordCriteria(db, verifier, run.run_id, local.map(c => ({
      criterion_id: c.key,
      result: fail.includes(c.key) ? 'fail' as const : 'pass' as const,
      evidence: `${c.verify_ref} ${fail.includes(c.key) ? 'failed' : 'passed'}`,
    })), run.head_sha);
  }
  return { run, result: finishVerification(db, verifier, run.run_id) };
}
