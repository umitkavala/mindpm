<script lang="ts">
  import type { Task } from '../lib/types.js';
  import { STATUS_CHIP } from '../lib/types.js';

  interface Props {
    task: Task;
    subtaskCount?: number;
    // Grouped board: a lane holds several statuses, so the card names its own.
    showChip?: boolean;
    // Review lane: low-risk verified cards join the batch accept.
    batch?: { checked: boolean; onToggle: (task: Task) => void };
    onAccept?: (task: Task) => void;
    onReopen?: (task: Task) => void;
    onResolve?: (task: Task) => void;
    blockerKeys?: string[];
    onEdit: (task: Task) => void;
    onDelete: (task: Task) => void;
    onDragStart: (e: DragEvent, task: Task) => void;
  }

  let {
    task, subtaskCount = 0, showChip = false, batch, onAccept, onReopen, onResolve, blockerKeys = [], onEdit, onDelete, onDragStart,
  }: Props = $props();

  const question = $derived.by(() => {
    if (!task.escalation) return null;
    try {
      return (JSON.parse(task.escalation) as { question?: string }).question ?? null;
    } catch {
      return null;
    }
  });
  const meta = $derived([task.spec_key, task.spec_key ? `${task.risk_level} risk` : null].filter(Boolean).join(' · '));

  let dragging = $state(false);

  function parseTags(tags: string | null): string[] {
    if (!tags) return [];
    try {
      return JSON.parse(tags);
    } catch {
      return [];
    }
  }

  const tags = $derived(parseTags(task.tags));
  const priorityClass = $derived(`priority-${task.priority}`);

  const blockerCount = $derived(() => {
    if (!task.blocked_by) return 0;
    try {
      const ids = JSON.parse(task.blocked_by);
      return Array.isArray(ids) ? ids.length : 0;
    } catch {
      return 0;
    }
  });

  function handleDragStart(e: DragEvent) {
    dragging = true;
    onDragStart(e, task);
  }

  function handleDragEnd() {
    dragging = false;
  }
</script>

<div
  class="card {priorityClass}"
  class:dragging
  draggable="true"
  ondragstart={handleDragStart}
  ondragend={handleDragEnd}
  role="button"
  tabindex="0"
  onclick={() => onEdit(task)}
  onkeydown={(e) => { if (e.key === 'Enter') onEdit(task); }}
>
  <div class="card-header">
    {#if showChip}
      <span class="chip chip-{task.status}">{STATUS_CHIP[task.status]}</span>
    {:else}
      <span class="priority-badge {priorityClass}">{task.priority}</span>
    {/if}
    <div class="card-header-right">
      {#if task.short_id}
        <span class="task-id">{task.short_id}</span>
      {/if}
      <button
        class="delete-btn"
        title="Delete task"
        onclick={(e: MouseEvent) => { e.stopPropagation(); onDelete(task); }}
      >
        &times;
      </button>
    </div>
  </div>
  <div class="card-title">{task.title}</div>
  {#if showChip}
    <div class="card-meta">
      <span class="priority-badge {priorityClass}">{task.priority}</span>{meta ? ` · ${meta}` : ''}
    </div>
  {/if}
  {#if !showChip && task.description}
    <div class="card-desc">{task.description}</div>
  {/if}
  {#if task.status === 'claimed' && task.claimed_by}
    <div class="card-extra">{task.claimed_by}{task.attempt_no ? ` · attempt ${task.attempt_no} of ${task.max_attempts ?? 3}` : ''}</div>
  {:else if task.status === 'needs_verification'}
    <div class="card-extra">{task.running_verifier ? `${task.running_verifier} running` : 'waiting for a verifier'}</div>
  {:else if task.status === 'blocked' && blockerKeys.length}
    <div class="card-extra">waiting on {blockerKeys.join(', ')}</div>
  {:else if task.status === 'needs_human' && question}
    <div class="card-question">{question}</div>
  {/if}
  {#if tags.length > 0}
    <div class="card-tags">
      {#each tags as tag}
        <span class="tag">{tag}</span>
      {/each}
    </div>
  {/if}
  {#if batch}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <label class="batch" onclick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={batch.checked} onchange={() => batch.onToggle(task)} /> in low-risk batch
    </label>
  {/if}
  {#if onAccept || onReopen || onResolve}
    <div class="card-actions">
      {#if onAccept}
        <button type="button" class="act act-primary" onclick={(e) => { e.stopPropagation(); onAccept(task); }}>Accept</button>
      {/if}
      {#if onReopen}
        <button type="button" class="act" onclick={(e) => { e.stopPropagation(); onReopen(task); }}>Reopen</button>
      {/if}
      {#if onResolve}
        <button type="button" class="act act-resolve" onclick={(e) => { e.stopPropagation(); onResolve(task); }}>Resolve</button>
      {/if}
    </div>
  {/if}
  {#if !showChip && (blockerCount() > 0 || subtaskCount > 0)}
    <div class="card-footer">
      {#if blockerCount() > 0}
        <span class="badge badge-blocked">⊘ blocked by {blockerCount()}</span>
      {/if}
      {#if subtaskCount > 0}
        <span class="badge badge-subtasks">⑂ {subtaskCount}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left-width: 3px;
    border-radius: var(--radius);
    padding: 8px 10px;
    cursor: grab;
    transition: border-color 0.15s, background 0.15s;
    position: relative;
  }

  .card.priority-critical { border-left-color: var(--priority-critical); }
  .card.priority-high     { border-left-color: var(--priority-high); }
  .card.priority-medium   { border-left-color: var(--priority-medium); }
  .card.priority-low      { border-left-color: var(--border-bright); }

  .card:hover {
    background: var(--surface-2);
    border-color: var(--border-bright);
    border-left-color: inherit;
  }

  .card.dragging {
    opacity: 0.4;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 5px;
  }

  .card-header-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .task-id {
    font-size: 0.65rem;
    color: var(--text-muted);
  }

  .priority-badge {
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-muted);
  }

  .priority-badge.priority-critical { color: var(--priority-critical); }
  .priority-badge.priority-high     { color: var(--priority-high); }
  .priority-badge.priority-medium   { color: var(--priority-medium); }
  .priority-badge.priority-low      { color: var(--text-muted); }

  .delete-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1rem;
    line-height: 1;
    padding: 0 2px;
    opacity: 0;
    transition: opacity 0.1s;
  }

  .card:hover .delete-btn {
    opacity: 1;
  }

  .delete-btn:hover {
    color: var(--danger);
  }

  .card-title {
    font-size: 0.8rem;
    font-weight: 500;
    word-break: break-word;
    color: var(--text);
    line-height: 1.4;
  }

  .card-desc {
    font-size: 0.72rem;
    color: var(--text-muted);
    margin-top: 4px;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-height: 1.4;
  }

  .chip {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.6px;
    padding: 1px 6px;
    border: 1px solid currentColor;
    border-radius: var(--radius-sm);
  }
  .chip-backlog { color: var(--status-backlog); }
  .chip-ready { color: var(--status-ready); }
  .chip-claimed { color: var(--status-claimed); }
  .chip-needs_verification { color: var(--status-verifying); }
  .chip-verified { color: var(--status-verified); }
  .chip-needs_human { color: var(--status-needs-human); }
  .chip-blocked { color: var(--status-blocked); }
  .chip-done, .chip-cancelled { color: var(--status-done); }

  .card-meta, .card-extra {
    font-size: 0.68rem;
    color: var(--text-dim);
    margin-top: 4px;
  }
  .card-meta .priority-badge { font-size: 0.62rem; }

  .card-question {
    font-size: 0.7rem;
    color: var(--text);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    padding: 6px;
    margin-top: 6px;
    line-height: 1.4;
  }

  .batch {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.68rem;
    color: var(--text-dim);
    margin-top: 6px;
    cursor: pointer;
  }

  .card-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  .act {
    flex: 1;
    min-height: 32px;
    background: none;
    color: var(--text);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius-sm);
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .act-primary { background: var(--primary); color: var(--bg); border-color: var(--primary); }
  .act-resolve { color: var(--status-needs-human); border-color: currentColor; }

  .card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }

  .tag {
    font-size: 0.62rem;
    background: var(--bg);
    color: var(--text-muted);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: 2px;
  }

  .card-footer {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    flex-wrap: wrap;
  }

  .badge {
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 1px 5px;
    border-radius: 2px;
    border: 1px solid;
  }

  .badge-blocked {
    color: var(--priority-critical);
    border-color: var(--priority-critical);
    background: color-mix(in srgb, var(--priority-critical) 10%, transparent);
  }

  .badge-subtasks {
    color: var(--text-muted);
    border-color: var(--border-bright);
    background: none;
  }
</style>
