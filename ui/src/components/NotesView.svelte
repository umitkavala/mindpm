<script lang="ts">
  import type { Note, Task } from '../lib/types.js';
  import { api } from '../lib/api.js';

  interface Props {
    projectId: string;
    onOpenTask: (task: Task) => void;
  }

  let { projectId, onOpenTask }: Props = $props();

  let notes: Note[] = $state([]);
  let tasks: Task[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);

  $effect(() => {
    loading = true;
    error = null;
    Promise.all([
      api.getNotes(projectId),
      api.getTasks(projectId),
    ]).then(([n, t]) => {
      notes = n;
      tasks = t;
    }).catch((e) => {
      error = e.message;
    }).finally(() => {
      loading = false;
    });
  });

  const taskMap = $derived(new Map(tasks.map((t) => [t.id, t])));

  const CATEGORY_COLORS: Record<string, string> = {
    general: 'var(--text-muted)',
    architecture: '#3d98f4',
    bug: 'var(--danger)',
    idea: 'var(--priority-high)',
    research: '#a371f7',
    meeting: 'var(--text-dim)',
    review: 'var(--primary)',
  };

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
    <div class="state-msg"><span class="prompt">&gt;</span> loading notes...</div>
  {:else if error}
    <div class="state-msg err">[error] {error}</div>
  {:else if notes.length === 0}
    <div class="state-msg muted">// no notes yet — use add_note via MCP tools</div>
  {:else}
    <div class="list">
      {#each notes as note (note.id)}
        {@const linkedTask = note.task_id ? taskMap.get(note.task_id) : null}
        {@const tags = parseTags(note.tags)}
        <div class="card">
          <div class="card-header">
            <span class="category" style="color: {CATEGORY_COLORS[note.category] ?? 'var(--text-muted)'}">
              {note.category}
            </span>
            <span class="date">{formatDate(note.created_at)}</span>
          </div>
          <div class="content">{note.content}</div>
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
    border-radius: var(--radius);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .category {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
  }

  .date {
    font-size: 0.62rem;
    color: var(--text-muted);
  }

  .content {
    font-size: 0.78rem;
    color: var(--text);
    line-height: 1.55;
    white-space: pre-wrap;
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
