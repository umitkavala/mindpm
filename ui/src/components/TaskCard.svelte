<script lang="ts">
  import type { Task } from '../lib/types.js';

  interface Props {
    task: Task;
    subtaskCount?: number;
    onEdit: (task: Task) => void;
    onDelete: (task: Task) => void;
    onDragStart: (e: DragEvent, task: Task) => void;
  }

  let { task, subtaskCount = 0, onEdit, onDelete, onDragStart }: Props = $props();

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
    <span class="priority-badge {priorityClass}">{task.priority}</span>
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
  {#if task.description}
    <div class="card-desc">{task.description}</div>
  {/if}
  {#if tags.length > 0}
    <div class="card-tags">
      {#each tags as tag}
        <span class="tag">{tag}</span>
      {/each}
    </div>
  {/if}
  {#if blockerCount() > 0 || subtaskCount > 0}
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
