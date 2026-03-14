<script lang="ts">
  import type { DeliveryMetrics } from '../lib/types.js';
  import { api } from '../lib/api.js';

  interface Props {
    projectId: string;
  }

  let { projectId }: Props = $props();

  let metrics: DeliveryMetrics | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);
  let days = $state(30);

  async function load() {
    loading = true;
    error = null;
    try {
      metrics = await api.getMetrics(projectId, days);
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    projectId;
    days;
    load();
  });

  const TIER_CLASS: Record<string, string> = {
    Elite: 'tier-elite',
    High: 'tier-high',
    Medium: 'tier-medium',
    Low: 'tier-low',
    unknown: 'tier-unknown',
  };

  const TREND_SYMBOL: Record<string, string> = {
    improving: '↑',
    declining: '↓',
    stable: '→',
  };

  const TREND_CLASS: Record<string, string> = {
    improving: 'trend-up',
    declining: 'trend-down',
    stable: 'trend-stable',
  };

  function hasLeadTime(lt: DeliveryMetrics['lead_time']): lt is { median_days: number; p90_days: number; trend: string } {
    return 'median_days' in lt;
  }
</script>

<div class="view">
  <div class="toolbar">
    <span class="toolbar-label">// window</span>
    {#each [7, 30, 90] as d}
      <button class="window-btn" class:active={days === d} onclick={() => days = d}>{d}d</button>
    {/each}
  </div>

  {#if loading}
    <div class="state-msg"><span class="prompt">&gt;</span> computing metrics...</div>
  {:else if error}
    <div class="state-msg err">[error] {error}</div>
  {:else if metrics}
    <div class="grid">

      <!-- Throughput -->
      <div class="card">
        <div class="card-label">Throughput</div>
        <div class="card-value">{metrics.throughput.tasks_completed}</div>
        <div class="card-sub">tasks completed</div>
        <div class="card-detail">{metrics.throughput.per_week_avg}/wk avg</div>
        <span class="trend {TREND_CLASS[metrics.throughput.trend]}">
          {TREND_SYMBOL[metrics.throughput.trend]} {metrics.throughput.trend}
        </span>
      </div>

      <!-- Lead Time -->
      <div class="card">
        <div class="card-label">Lead Time</div>
        {#if hasLeadTime(metrics.lead_time)}
          <div class="card-value">{metrics.lead_time.median_days}d</div>
          <div class="card-sub">median</div>
          <div class="card-detail">p90: {metrics.lead_time.p90_days}d</div>
          <span class="trend {TREND_CLASS[metrics.lead_time.trend]}">
            {TREND_SYMBOL[metrics.lead_time.trend]} {metrics.lead_time.trend}
          </span>
        {:else}
          <div class="card-value card-value--empty">—</div>
          <div class="card-sub muted">{metrics.lead_time.note}</div>
        {/if}
      </div>

      <!-- Blocked Rate -->
      <div class="card">
        <div class="card-label">Blocked Rate</div>
        {#if metrics.flow_efficiency.blocked_rate_pct !== null}
          <div class="card-value {metrics.flow_efficiency.blocked_rate_pct > 30 ? 'val-danger' : ''}">
            {metrics.flow_efficiency.blocked_rate_pct}%
          </div>
          <div class="card-sub">of active tasks hit a blocker</div>
        {:else}
          <div class="card-value card-value--empty">—</div>
          <div class="card-sub muted">no activity in window</div>
        {/if}
        {#if metrics.flow_efficiency.avg_blocked_days !== null}
          <div class="card-detail">avg blocked: {metrics.flow_efficiency.avg_blocked_days}d</div>
        {/if}
        {#if metrics.flow_efficiency.currently_blocked > 0}
          <span class="badge badge-blocked">{metrics.flow_efficiency.currently_blocked} blocked now</span>
        {/if}
      </div>

      <!-- DORA Tier -->
      <div class="card card--tier">
        <div class="card-label">Performance Tier</div>
        <div class="tier-badge {TIER_CLASS[metrics.dora_tier]}">{metrics.dora_tier}</div>
        <div class="card-sub tier-legend">
          <span class="tier-elite">Elite</span> &lt;1d ·
          <span class="tier-high">High</span> &lt;1wk ·
          <span class="tier-medium">Medium</span> &lt;1mo ·
          <span class="tier-low">Low</span> 1mo+
        </div>
      </div>

    </div>

    {#if metrics.insights.length > 0}
      <div class="insights">
        <div class="insights-label">// insights</div>
        {#each metrics.insights as insight}
          <div class="insight-row"><span class="insight-bullet">›</span> {insight}</div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .view {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .toolbar-label {
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-right: 4px;
  }

  .window-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.72rem;
    font-family: inherit;
    padding: 3px 10px;
    border-radius: 3px;
    cursor: pointer;
    transition: color 0.1s, border-color 0.1s;
  }

  .window-btn:hover {
    color: var(--text-dim);
    border-color: var(--text-muted);
  }

  .window-btn.active {
    color: var(--primary);
    border-color: var(--primary);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .card-label {
    font-size: 0.67rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-muted);
  }

  .card-value {
    font-size: 2rem;
    font-weight: 700;
    color: var(--text);
    line-height: 1.1;
  }

  .card-value--empty {
    color: var(--text-muted);
  }

  .val-danger {
    color: var(--danger);
  }

  .card-sub {
    font-size: 0.72rem;
    color: var(--text-dim);
  }

  .card-sub.muted {
    color: var(--text-muted);
  }

  .card-detail {
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .trend {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 6px;
  }

  .trend-up { color: var(--success, #4caf50); }
  .trend-down { color: var(--danger); }
  .trend-stable { color: var(--text-muted); }

  .badge {
    display: inline-block;
    font-size: 0.65rem;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 3px;
    margin-top: 6px;
    width: fit-content;
  }

  .badge-blocked {
    background: color-mix(in srgb, var(--danger) 15%, transparent);
    color: var(--danger);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  }

  .card--tier {
    align-items: flex-start;
  }

  .tier-badge {
    font-size: 1.6rem;
    font-weight: 800;
    letter-spacing: -0.5px;
    margin: 4px 0;
  }

  .tier-elite  { color: #4caf50; }
  .tier-high   { color: var(--primary); }
  .tier-medium { color: #f59e0b; }
  .tier-low    { color: var(--danger); }
  .tier-unknown { color: var(--text-muted); }

  .tier-legend {
    font-size: 0.65rem;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .insights {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .insights-label {
    font-size: 0.67rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-muted);
    margin-bottom: 2px;
  }

  .insight-row {
    font-size: 0.78rem;
    color: var(--text-dim);
    display: flex;
    gap: 8px;
  }

  .insight-bullet {
    color: var(--primary);
    flex-shrink: 0;
  }

  .state-msg {
    font-size: 0.82rem;
    color: var(--text-muted);
    padding: 32px 0;
  }

  .err {
    color: var(--danger);
  }
</style>
