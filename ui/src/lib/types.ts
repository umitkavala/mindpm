export interface Project {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  status: 'active' | 'paused' | 'completed' | 'archived';
  repo_path: string | null;
  tech_stack: string | null;
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
}

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
  insights: string[];
}

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'in_review' | 'done' | 'cancelled';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'Todo' },
  { status: 'in_progress', label: 'In Progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'in_review', label: 'In Review' },
  { status: 'done', label: 'Done' },
  { status: 'cancelled', label: 'Cancelled' },
];

export const PRIORITY_ORDER: TaskPriority[] = ['critical', 'high', 'medium', 'low'];
