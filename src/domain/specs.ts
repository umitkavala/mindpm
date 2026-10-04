import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { ToolError, type Actor } from './lifecycle.js';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface SpecRow {
  id: string;
  project_id: string;
  seq: number;
  title: string;
  objective: string;
  why: string;
  approach: string | null;
  constraints: string | null;
  out_of_scope: string | null;
  risk_level: RiskLevel;
  status: 'draft' | 'approved' | 'superseded' | 'cancelled';
  version: number;
  superseded_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approved_hash: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CriterionRow {
  id: string;
  spec_id: string;
  seq: number;
  statement: string;
  verify_kind: 'test' | 'command' | 'review';
  verify_ref: string | null;
}

export const specKey = (spec: { seq: number }) => `SPEC-${spec.seq}`;
export const criterionKey = (spec: { seq: number }, c: { seq: number }) => `AC-${spec.seq}.${c.seq}`;

export function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// Resolve a spec by id, or by "SPEC-<seq>" within a project. Keys are only
// unique per project, so a key without a project is ambiguous unless it
// matches exactly one spec.
export function resolveSpec(db: Database.Database, ref: string, projectId?: string): SpecRow {
  const byId = db.prepare('SELECT * FROM specs WHERE id = ?').get(ref) as SpecRow | undefined;
  if (byId) return byId;
  const m = ref.match(/^SPEC-(\d+)$/i);
  if (m) {
    const seq = parseInt(m[1], 10);
    const rows = (projectId
      ? db.prepare('SELECT * FROM specs WHERE project_id = ? AND seq = ?').all(projectId, seq)
      : db.prepare('SELECT * FROM specs WHERE seq = ?').all(seq)) as SpecRow[];
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) throw new ToolError('ambiguous_spec', `"${ref}" exists in several projects. Pass the spec id or a project.`);
  }
  throw new ToolError('not_found', `Spec "${ref}" not found.`);
}

export function criteriaOf(db: Database.Database, specId: string): CriterionRow[] {
  return db.prepare('SELECT * FROM acceptance_criteria WHERE spec_id = ? ORDER BY seq').all(specId) as CriterionRow[];
}

// Resolve criterion refs (ids or "AC-<spec>.<n>" keys) against one spec.
// Every ref must belong to that spec.
export function resolveCriteria(db: Database.Database, spec: SpecRow, refs: string[]): CriterionRow[] {
  const all = criteriaOf(db, spec.id);
  return refs.map(ref => {
    const found = all.find(c => c.id === ref || criterionKey(spec, c).toLowerCase() === ref.toLowerCase());
    if (!found) throw new ToolError('invalid_criteria', `Criterion "${ref}" does not belong to ${specKey(spec)}.`);
    return found;
  });
}

// Hash of everything an executor relies on. approve_spec compares it with
// the hash at the last approval to decide whether the version must bump.
export function specContentHash(spec: SpecRow, criteria: CriterionRow[]): string {
  const content = {
    title: spec.title,
    objective: spec.objective,
    why: spec.why,
    approach: spec.approach,
    constraints: parseJsonArray(spec.constraints),
    out_of_scope: parseJsonArray(spec.out_of_scope),
    risk_level: spec.risk_level,
    criteria: criteria.map(c => [c.seq, c.statement, c.verify_kind, c.verify_ref]),
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

// Approving (or editing an approved spec, which republishes it): high and
// medium risk need a human; low risk also allows agent:architect.
export function assertCanApprove(actor: Actor, risk: RiskLevel): void {
  if (actor.kind === 'human') return;
  if (actor.kind === 'architect' && risk === 'low') return;
  throw new ToolError(
    'forbidden',
    risk === 'low'
      ? `${actor.id} cannot approve specs. Low-risk specs need human:* or agent:architect.`
      : `${risk}-risk specs need a human (human:*) to approve.`,
  );
}

// Defining specs is architect or human work.
export function assertCanAuthor(actor: Actor): void {
  if (actor.kind === 'human' || actor.kind === 'architect') return;
  throw new ToolError('forbidden', `${actor.id} cannot author specs. Use agent:architect or human:*.`);
}
