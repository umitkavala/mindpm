<script lang="ts">
  import type { Decision, Task } from '../lib/types.js';
  import { api } from '../lib/api.js';

  interface Props {
    projectId: string;
    onOpenTask: (task: Task) => void;
  }

  let { projectId, onOpenTask }: Props = $props();

  let decisions: Decision[] = $state([]);
  let tasks: Task[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);

  $effect(() => {
    loading = true;
    error = null;
    Promise.all([
      api.getDecisions(projectId),
      api.getTasks(projectId),
    ]).then(([d, t]) => {
      decisions = d;
      tasks = t;
    }).catch((e) => {
      error = e.message;
    }).finally(() => {
      loading = false;
    });
  });

  const taskMap = $derived(new Map(tasks.map((t) => [t.id, t])));

  function parseAlts(raw: string | null): string[] {
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  function parseTags(raw: string | null): string[] {
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  function formatDate(iso: string): string {
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
</script>

<div class="view">
  {#if loading}
    <div class="state-msg"><span class="prompt">&gt;</span> loading decisions...</div>
  {:else if error}
    <div class="state-msg err">[error] {error}</div>
  {:else if decisions.length === 0}
    <div class="state-msg muted">// no decisions yet — use log_decision via MCP tools</div>
  {:else}
    <div class="list">
      {#each decisions as d (d.id)}
        {@const linkedTask = d.task_id ? taskMap.get(d.task_id) : null}
        {@const alts = parseAlts(d.alternatives)}
        {@const tags = parseTags(d.tags)}
        <div class="card">
          <div class="card-header">
            <span class="title">{d.title}</span>
            <span class="date">{formatDate(d.created_at)}</span>
          </div>
          <div class="decision-text">{d.decision}</div>
          {#if d.reasoning}
            <div class="reasoning">{d.reasoning}</div>
          {/if}
          {#if alts.length > 0}
            <div class="alts">Alternatives considered: {alts.join(', ')}</div>
          {/if}
          {#if tags.length > 0 || linkedTask}
            <div class="card-footer">
              {#if tags.length > 0}
                <div class="tags">
                  {#each tags as tag}
                    <span class="tag">{tag}</span>
                  {/each}
                </div>
              {/if}
              {#if linkedTask}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <span class="task-link" onclick={() => onOpenTask(linkedTask)}>
                  → {linkedTask.short_id ?? linkedTask.id.slice(0, 8)}: {linkedTask.title}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .view {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
  }

  .state-msg {
    color: var(--text-dim);
    font-size: 0.8rem;
    padding: 40px 0;
    text-align: center;
  }

  .state-msg.err { color: var(--danger); }
  .state-msg.muted { color: var(--text-muted); }

  .prompt { color: var(--primary); }

  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 760px;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--border-bright);
    border-radius: var(--radius);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .card-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }

  .title {
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--text);
  }

  .date {
    font-size: 0.62rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .decision-text {
    font-size: 0.78rem;
    color: var(--text-dim);
    line-height: 1.5;
  }

  .reasoning {
    font-size: 0.72rem;
    color: var(--text-muted);
    font-style: italic;
    line-height: 1.4;
  }

  .alts {
    font-size: 0.68rem;
    color: var(--text-muted);
  }

  .card-footer {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 2px;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .tag {
    font-size: 0.62rem;
    color: var(--text-muted);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 1px 6px;
  }

  .task-link {
    font-size: 0.68rem;
    color: var(--primary);
    cursor: pointer;
    border: 1px solid var(--primary-dim);
    border-radius: var(--radius-sm);
    padding: 1px 7px;
    background: var(--primary-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 300px;
  }

  .task-link:hover {
    background: rgba(57, 211, 83, 0.25);
  }
</style>
