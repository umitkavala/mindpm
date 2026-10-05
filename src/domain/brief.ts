import type Database from 'better-sqlite3';
import { resolveRepoPath } from '../db/queries.js';
import { buildFtsAnyMatch, ftsReady } from '../utils/fts.js';
import { attemptsUsed, maxAttempts } from './attempts.js';
import { plannedChecks } from './verification.js';
import { parseIdList, ToolError } from './lifecycle.js';
import { criterionKey, parseJsonArray, specKey, type CriterionRow, type SpecRow } from './specs.js';

export const BRIEF_TOKEN_BUDGET = 2000;
const RANKED_DECISIONS = 5;

interface BriefDecision { id: string; title: string; decision: string; why: string | null; source: 'spec' | 'ranked' }
interface BriefAttempt {
  attempt_no: number;
  outcome: string;
  failure_type: string | null;
  root_cause: string | null;
  notes: string | null;
  review_findings: string | null;
  escalation?: unknown;
  verification?: { outcome: string | null; findings?: unknown; self_report_mismatch?: string };
}

export interface TaskBrief {
  task: { key: string; title: string; description?: string; priority: string; status: string; branch: string | null; attempt_no: number; attempts_left: number };
  spec: {
    key: string; version: number; status: string; risk_level: string; title: string; objective: string; why: string;
    approach: string | null; constraints: string[]; out_of_scope: string[];
  } | null;
  criteria: { id: string; key: string; statement: string; verify_kind: string; verify_ref: string | null }[];
  project: { name: string; tech_stack: string | null; conventions: string | null; repo_path: string | null };
  // Commands for the executor to run. Hints only: the verifier runs
  // verifier_checks, which only a human can change.
  verification: Record<string, string>;
  verifier_checks: { name: string; command: string }[];
  decisions: Omit<BriefDecision, 'source' | 'id'>[];
  dependencies: { key: string; title: string; status: string }[];
  previous_attempts: BriefAttempt[];
  trimmed?: { previous_attempts: number; decisions: number; hint: string };
}

// Rough token estimate: ~4 characters per token for JSON-heavy English.
export const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

function parseObject(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// tech_stack is stored as a JSON array by create_project; older rows may hold plain text.
function techStack(raw: string | null): string | null {
  if (!raw) return null;
  const list = parseJsonArray(raw);
  return list.length ? list.join(', ') : raw;
}

// Active decisions linked to the spec, then the top-ranked active decisions
// by FTS against the spec (or, for a plain task, the task) text.
function relevantDecisions(db: Database.Database, projectId: string, spec: SpecRow | null, fallbackText: string): BriefDecision[] {
  type Row = { id: string; title: string; decision: string; reasoning: string | null };
  const linked = spec
    ? (db.prepare("SELECT id, title, decision, reasoning FROM decisions WHERE spec_id = ? AND status = 'active' ORDER BY created_at").all(spec.id) as Row[])
    : [];
  const text = spec ? [spec.title, spec.objective, spec.approach ?? ''].join(' ') : fallbackText;
  const match = buildFtsAnyMatch(text);
  let ranked: Row[] = [];
  if (match && ftsReady(db)) {
    const exclude = linked.map(d => d.id);
    ranked = db.prepare(
      `SELECT d.id, d.title, d.decision, d.reasoning FROM decisions_fts JOIN decisions d ON d.rowid = decisions_fts.rowid
       WHERE decisions_fts MATCH ? AND d.project_id = ? AND d.status = 'active'
       ${exclude.length ? `AND d.id NOT IN (${exclude.map(() => '?').join(',')})` : ''}
       ORDER BY bm25(decisions_fts) LIMIT ?`,
    ).all(match, projectId, ...exclude, RANKED_DECISIONS) as Row[];
  }
  const shape = (source: 'spec' | 'ranked') => (d: Row): BriefDecision => ({ id: d.id, title: d.title, decision: d.decision, why: d.reasoning, source });
  return [...linked.map(shape('spec')), ...ranked.map(shape('ranked'))];
}

// The whole contract for one run. Kept under BRIEF_TOKEN_BUDGET by dropping
// the oldest attempts first (the latest always stays), then ranked decisions
// from the least relevant, then spec-linked decisions from the oldest.
export function buildBrief(db: Database.Database, taskId: string): TaskBrief {
  const task = db.prepare(
    `SELECT t.*, p.slug || '-' || t.seq AS key, p.name AS project_name, p.tech_stack, p.conventions, p.verification_defaults
     FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = ?`,
  ).get(taskId) as Record<string, any> | undefined;
  if (!task) throw new ToolError('not_found', `Task "${taskId}" not found.`);

  const spec = task.spec_id ? (db.prepare('SELECT * FROM specs WHERE id = ?').get(task.spec_id) as SpecRow) : null;
  const criteria = db.prepare(
    'SELECT c.* FROM acceptance_criteria c JOIN task_criteria tc ON tc.criterion_id = c.id WHERE tc.task_id = ? ORDER BY c.seq',
  ).all(taskId) as CriterionRow[];

  const active = db.prepare("SELECT attempt_no FROM attempts WHERE task_id = ? AND outcome = 'active'").get(taskId) as { attempt_no: number } | undefined;
  const lastNo = (db.prepare('SELECT COALESCE(MAX(attempt_no), 0) AS n FROM attempts WHERE task_id = ?').get(taskId) as { n: number }).n;
  const attemptNo = active?.attempt_no ?? lastNo + 1;
  // Attempts left after this one, so attempt 2 of 3 reports 1.
  const attemptsLeft = Math.max(0, maxAttempts(task as { max_attempts: number | null }) - attemptsUsed(db, taskId) - 1);

  type AttemptQueryRow = Omit<BriefAttempt, 'escalation' | 'verification'> & {
    escalation: string | null; verification_outcome: string | null; verification_findings: string | null; self_report_mismatch: number;
  };
  const previous = (db.prepare(
    `SELECT attempt_no, outcome, failure_type, root_cause, notes, review_findings, escalation,
       verification_outcome, verification_findings, self_report_mismatch
     FROM attempts WHERE task_id = ? AND outcome != 'active' ORDER BY attempt_no DESC`,
  ).all(taskId) as AttemptQueryRow[]).map(({ escalation, verification_outcome, verification_findings, self_report_mismatch, ...a }) => {
    const out: BriefAttempt = { ...a };
    if (escalation) out.escalation = JSON.parse(escalation);
    if (verification_outcome) {
      out.verification = {
        outcome: verification_outcome,
        ...(verification_findings ? { findings: JSON.parse(verification_findings) } : {}),
        ...(self_report_mismatch
          ? { self_report_mismatch: 'This attempt reported criteria as passing that the verifier found failing or missing.' }
          : {}),
      };
    }
    return out;
  });

  const dependencies = parseIdList(task.blocked_by).map(id => {
    const dep = db.prepare("SELECT p.slug || '-' || t.seq AS key, t.title, t.status FROM tasks t JOIN projects p ON t.project_id = p.id WHERE t.id = ?")
      .get(id) as { key: string; title: string; status: string } | undefined;
    return dep ?? { key: id, title: '(unknown task)', status: 'unknown' };
  });

  const decisions = relevantDecisions(db, task.project_id, spec, `${task.title} ${task.description ?? ''}`);

  const brief: TaskBrief = {
    task: {
      key: task.key,
      title: task.title,
      ...(task.description ? { description: task.description } : {}),
      priority: task.priority,
      status: task.status,
      branch: task.branch,
      attempt_no: attemptNo,
      attempts_left: attemptsLeft,
    },
    spec: spec ? {
      key: specKey(spec),
      version: spec.version,
      status: spec.status,
      risk_level: spec.risk_level,
      title: spec.title,
      objective: spec.objective,
      why: spec.why,
      approach: spec.approach,
      constraints: parseJsonArray(spec.constraints),
      out_of_scope: parseJsonArray(spec.out_of_scope),
    } : null,
    criteria: spec
      ? criteria.map(c => ({ id: c.id, key: criterionKey(spec, c), statement: c.statement, verify_kind: c.verify_kind, verify_ref: c.verify_ref }))
      : [],
    project: {
      name: task.project_name,
      tech_stack: techStack(task.tech_stack),
      conventions: task.conventions,
      repo_path: resolveRepoPath(task.project_id),
    },
    verification: { ...parseObject(task.verification_defaults), ...parseObject(task.verification) },
    verifier_checks: plannedChecks(db, task.project_id),
    decisions: [],
    dependencies,
    previous_attempts: previous,
  };

  const kept = [...decisions];
  const render = () => {
    brief.decisions = kept.map(({ title, decision, why }) => ({ title, decision, why }));
  };
  render();
  let droppedAttempts = 0;
  let droppedDecisions = 0;
  while (estimateTokens(brief) > BRIEF_TOKEN_BUDGET) {
    if (brief.previous_attempts.length > 1) {
      brief.previous_attempts.pop();
      droppedAttempts++;
      continue;
    }
    const lastRanked = kept.map(d => d.source).lastIndexOf('ranked');
    const idx = lastRanked !== -1 ? lastRanked : kept.findIndex(d => d.source === 'spec');
    if (idx === -1) break;
    kept.splice(idx, 1);
    droppedDecisions++;
    render();
  }
  if (droppedAttempts || droppedDecisions) {
    brief.trimmed = {
      previous_attempts: droppedAttempts,
      decisions: droppedDecisions,
      hint: 'Trimmed to fit the brief budget. get_task lists every attempt; get_spec lists every linked decision.',
    };
  }
  return brief;
}
