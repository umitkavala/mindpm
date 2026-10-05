export interface Project {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  status: 'active' | 'paused' | 'completed' | 'archived';
  repo_path: string | null;
  tech_stack: string | null;
  // Off: a human accepts submitted work directly. On: a verifier must pass it first.
  verification?: 'off' | 'on';
  created_at: string;
  updated_at: string;
  task_counts?: { status: string; count: number }[];
  active_task_count?: number;
  done_task_count?: number;
}

export interface Task {
  id: string;
  project_id: string;
  seq: number | null;
  short_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string | null;
  parent_task_id: string | null;
  blocked_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  // Board extras from the tasks listing.
  claimed_by?: string | null;
  max_attempts?: number | null;
  spec_key?: string | null;
  risk_level?: RiskLevel;
  attempt_no?: number | null;
  running_verifier?: string | null;
  escalation?: string | null;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export interface CheckResult {
  name: string;
  command: string;
  exit_code: number | null;
  duration_ms: number | null;
  output_tail: string | null;
  report: { total: number; passed: number; failed: number; skipped: number; failing: string[]; path: string } | null;
}

export interface CriterionResult {
  criterion_id: string;
  key: string;
  statement: string | null;
  result: 'pass' | 'fail' | 'missing';
  source: 'test' | 'command' | 'review';
  evidence: string;
  recorded_by: string;
}

export interface VerificationRun {
  id: string;
  attempt_no: number;
  verifier: string;
  head_sha: string;
  spec_version: number | null;
  status: 'running' | 'passed' | 'failed' | 'error' | 'superseded';
  error_reason: string | null;
  started_at: string;
  ended_at: string | null;
  checks: CheckResult[];
  criteria: CriterionResult[];
}

export interface TaskVerification {
  status: TaskStatus;
  risk_level: RiskLevel;
  verification: 'off' | 'on';
  verified_run_id: string | null;
  submission: {
    attempt_no: number;
    actor: string;
    head_sha: string | null;
    branch: string | null;
    summary: string | null;
    criteria_results: { key: string; result: string; evidence: string }[];
    verification_outcome: string | null;
    self_report_mismatch: number;
    ended_at: string | null;
  } | null;
  runs: VerificationRun[];
}

export interface Verifier {
  id: string;
  name: string;
  actor: string;
  kind: 'local' | 'reviewer';
  project_ids: string[];
  created_by: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type Resolution = 'requeue' | 'cancel' | 'revise_spec' | 'reverify';

export interface Decision {
  id: string;
  project_id: string;
  task_id: string | null;
  title: string;
  decision: string;
  reasoning: string | null;
  alternatives: string | null;
  tags: string | null;
  created_at: string;
}

export interface Note {
  id: string;
  project_id: string;
  task_id: string | null;
  content: string;
  category: 'general' | 'architecture' | 'bug' | 'idea' | 'research' | 'meeting' | 'review';
  tags: string | null;
  created_at: string;
}

export interface TaskHistoryEvent {
  id: string;
  task_id: string;
  event: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

export interface DeliveryMetrics {
  project: string;
  period: string;
  throughput: { tasks_completed: number; per_week_avg: number; trend: 'improving' | 'declining' | 'stable' };
  lead_time: { median_days: number; p90_days: number; trend: 'improving' | 'declining' | 'stable' } | { note: string };
  flow_efficiency: { blocked_rate_pct: number | null; avg_blocked_days: number | null; currently_blocked: number };
  dora_tier: 'Elite' | 'High' | 'Medium' | 'Low' | 'unknown';
  verification?: {
    verified_submissions: number;
    first_run_pass_rate_pct: number | null;
    self_report_mismatch_rate_pct: number | null;
    median_hours_to_verified: number | null;
    awaiting_acceptance: number;
  };
  insights: string[];
}

export type TaskStatus =
  | 'backlog' | 'ready' | 'claimed' | 'blocked' | 'needs_verification' | 'verified' | 'needs_human' | 'done' | 'cancelled';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

// "All statuses" view: one column per status.
export const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'ready', label: 'Ready' },
  { status: 'claimed', label: 'Claimed' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'needs_human', label: 'Needs Human' },
  { status: 'needs_verification', label: 'Needs Verification' },
  { status: 'verified', label: 'Verified' },
  { status: 'done', label: 'Done' },
  { status: 'cancelled', label: 'Cancelled' },
];

// "Grouped" view: five lanes that fit a laptop screen. Cards keep their exact
// status as a chip.
export type LaneId = 'planned' | 'in_progress' | 'review' | 'attention' | 'done';
export const LANES: { id: LaneId; label: string; statuses: TaskStatus[] }[] = [
  { id: 'planned', label: 'Planned', statuses: ['backlog', 'ready'] },
  { id: 'in_progress', label: 'In progress', statuses: ['claimed'] },
  { id: 'review', label: 'Review', statuses: ['needs_verification', 'verified'] },
  { id: 'attention', label: 'Needs attention', statuses: ['needs_human', 'blocked'] },
  { id: 'done', label: 'Done', statuses: ['done'] },
];

export const STATUS_CHIP: Record<TaskStatus, string> = {
  backlog: 'BACKLOG',
  ready: 'READY',
  claimed: 'CLAIMED',
  blocked: 'BLOCKED',
  needs_verification: 'VERIFYING',
  verified: 'VERIFIED',
  needs_human: 'NEEDS HUMAN',
  done: 'DONE',
  cancelled: 'CANCELLED',
};

export const PRIORITY_ORDER: TaskPriority[] = ['critical', 'high', 'medium', 'low'];

export interface VerificationSetup {
  mode: 'off' | 'on';
  // What turning it on still needs; empty when it can be turned on.
  missing: string[];
  warning: string | null;
}
