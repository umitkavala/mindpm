import type Database from 'better-sqlite3';

export interface DeliveryMetrics {
  project: string;
  period: string;
  throughput: {
    tasks_completed: number;
    per_week_avg: number;
    trend: 'improving' | 'declining' | 'stable';
  };
  lead_time: { median_days: number; p90_days: number; trend: 'improving' | 'declining' | 'stable' } | { note: string };
  flow_efficiency: {
    blocked_rate_pct: number | null;
    avg_blocked_days: number | null;
    currently_blocked: number;
  };
  dora_tier: 'Elite' | 'High' | 'Medium' | 'Low' | 'unknown';
  insights: string[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function doraLabel(sorted: number[]): DeliveryMetrics['dora_tier'] {
  if (sorted.length === 0) return 'unknown';
  const med = percentile(sorted, 50);
  if (med < 1) return 'Elite';
  if (med < 7) return 'High';
  if (med < 30) return 'Medium';
  return 'Low';
}

function tpTrend(cur: number, prev: number): 'improving' | 'declining' | 'stable' {
  if (prev === 0) return cur > 0 ? 'improving' : 'stable';
  const d = (cur - prev) / prev;
  return d > 0.1 ? 'improving' : d < -0.1 ? 'declining' : 'stable';
}

function ltTrend(cur: number, prev: number): 'improving' | 'declining' | 'stable' {
  if (prev === 0) return 'stable';
  const d = (cur - prev) / prev;
  return d < -0.1 ? 'improving' : d > 0.1 ? 'declining' : 'stable';
}

export function computeDeliveryMetrics(
  db: Database.Database,
  projectId: string,
  projectName: string,
  days: number,
): DeliveryMetrics {
  const w = `datetime('now', '-${days} days')`;
  const pw = `datetime('now', '-${days * 2} days')`;

  type LeadRow = { lead_days: number };
  const completed = db.prepare(
    `SELECT julianday(completed_at) - julianday(created_at) AS lead_days
     FROM tasks WHERE project_id = ? AND status = 'done' AND completed_at >= ${w}`,
  ).all(projectId) as LeadRow[];

  const prevCompleted = db.prepare(
    `SELECT julianday(completed_at) - julianday(created_at) AS lead_days
     FROM tasks WHERE project_id = ? AND status = 'done'
     AND completed_at >= ${pw} AND completed_at < ${w}`,
  ).all(projectId) as LeadRow[];

  const leadTimes = completed.map(r => r.lead_days).sort((a, b) => a - b);
  const prevLeadTimes = prevCompleted.map(r => r.lead_days).sort((a, b) => a - b);
  const completedCount = completed.length;
  const prevCount = prevCompleted.length;

  // Status-change events in window
  type HistRow = { task_id: string; new_value: string; old_value: string; created_at: string };
  const events = db.prepare(
    `SELECT h.task_id, h.new_value, h.old_value, h.created_at
     FROM task_history h JOIN tasks t ON h.task_id = t.id
     WHERE t.project_id = ? AND h.event = 'status_changed' AND h.created_at >= ${w}
     ORDER BY h.task_id, h.created_at ASC`,
  ).all(projectId) as HistRow[];

  const touchedIds = new Set(events.map(e => e.task_id));
  const blockedIds = new Set<string>();
  let totalBlockedDays = 0;
  let blockedPairs = 0;

  const byTask = new Map<string, HistRow[]>();
  for (const ev of events) {
    if (!byTask.has(ev.task_id)) byTask.set(ev.task_id, []);
    byTask.get(ev.task_id)!.push(ev);
  }
  for (const [tid, evs] of byTask) {
    let blockedAt: number | null = null;
    for (const ev of evs) {
      if (ev.new_value === 'blocked') {
        blockedIds.add(tid);
        blockedAt = new Date(ev.created_at).getTime();
      } else if (blockedAt !== null && ev.old_value === 'blocked') {
        totalBlockedDays += (new Date(ev.created_at).getTime() - blockedAt) / 86_400_000;
        blockedPairs++;
        blockedAt = null;
      }
    }
  }

  const currentlyBlocked = (db.prepare(
    `SELECT COUNT(*) as n FROM tasks WHERE project_id = ? AND status = 'blocked'`,
  ).get(projectId) as { n: number }).n;

  const perWeekAvg = Math.round((completedCount / (days / 7)) * 10) / 10;
  const median = leadTimes.length ? percentile(leadTimes, 50) : null;
  const p90 = leadTimes.length ? percentile(leadTimes, 90) : null;
  const prevMedian = prevLeadTimes.length ? percentile(prevLeadTimes, 50) : null;
  const blockedRatePct = touchedIds.size > 0 ? Math.round((blockedIds.size / touchedIds.size) * 100) : null;
  const avgBlockedDays = blockedPairs > 0 ? Math.round((totalBlockedDays / blockedPairs) * 10) / 10 : null;

  const throughputTrend = tpTrend(completedCount, prevCount);
  const leadTrendVal = median !== null && prevMedian !== null ? ltTrend(median, prevMedian) : 'stable';

  const insights: string[] = [];
  if (completedCount === 0) {
    insights.push(`No tasks completed in the last ${days} days.`);
  } else {
    if (throughputTrend === 'improving') insights.push(`Throughput up vs prior ${days}-day period (${completedCount} vs ${prevCount} tasks).`);
    if (throughputTrend === 'declining') insights.push(`Throughput down vs prior ${days}-day period (${completedCount} vs ${prevCount} tasks).`);
    if (leadTrendVal === 'declining' && median !== null) insights.push(`Lead time worsened — median now ${median.toFixed(1)} days (was ${prevMedian!.toFixed(1)}).`);
    if (leadTrendVal === 'improving' && median !== null) insights.push(`Lead time improved — median now ${median.toFixed(1)} days (was ${prevMedian!.toFixed(1)}).`);
  }
  if (currentlyBlocked > 0) insights.push(`${currentlyBlocked} task${currentlyBlocked > 1 ? 's' : ''} currently blocked.`);

  return {
    project: projectName,
    period: `last ${days} days`,
    throughput: { tasks_completed: completedCount, per_week_avg: perWeekAvg, trend: throughputTrend },
    lead_time: median !== null
      ? { median_days: Math.round(median * 10) / 10, p90_days: Math.round((p90 ?? 0) * 10) / 10, trend: leadTrendVal }
      : { note: 'No completed tasks in this period.' },
    flow_efficiency: { blocked_rate_pct: blockedRatePct, avg_blocked_days: avgBlockedDays, currently_blocked: currentlyBlocked },
    dora_tier: doraLabel(leadTimes),
    insights,
  };
}
