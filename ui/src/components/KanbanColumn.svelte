<script lang="ts">
  import type { Task, TaskStatus } from '../lib/types.js';
  import TaskCard from './TaskCard.svelte';

  const WIP_LIMIT = 5;
  const STORAGE_KEY = 'mindpm_collapsed_cols';

  interface Props {
    status: TaskStatus;
    label: string;
    tasks: Task[];
    subtaskCounts: Map<string, number>;
    onEdit: (task: Task) => void;
    onDelete: (task: Task) => void;
    onDragStart: (e: DragEvent, task: Task) => void;
    onDrop: (status: TaskStatus) => void;
    onAddTask: (status: TaskStatus) => void;
  }

  let { status, label, tasks, subtaskCounts, onEdit, onDelete, onDragStart, onDrop, onAddTask }: Props = $props();

  let dragOver = $state(false);

  // Collapse state persisted per column status
  function loadCollapsed(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const set: string[] = raw ? JSON.parse(raw) : [];
      return set.includes(status);
    } catch { return false; }
  }

  function saveCollapsed(collapsed: boolean) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const set: string[] = raw ? JSON.parse(raw) : [];
      const next = collapsed ? [...new Set([...set, status])] : set.filter(s => s !== status);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  }

  let collapsed = $state(loadCollapsed());

  function toggleCollapse() {
    collapsed = !collapsed;
    saveCollapsed(collapsed);
  }

  const wipWarning = $derived(status === 'in_progress' && tasks.length > WIP_LIMIT);

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    onDrop(status);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="column"
  class:drag-over={dragOver}
  class:collapsed
  class:wip-warning={wipWarning}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  role="list"
>
  {#if collapsed}
    <div class="column-collapsed">
      <button class="expand-btn" onclick={toggleCollapse} title="Expand column">»</button>
      <div class="collapsed-label">
        <span class="collapsed-count" class:wip={wipWarning}>[{tasks.length}]</span>
        <span class="collapsed-text">{label}</span>
      </div>
    </div>
  {:else}
    <div class="column-header">
      <h3>
        <span class="chevron">▸</span>
        {label}
        <span class="count" class:wip={wipWarning}>[{tasks.length}{wipWarning ? ' ⚠' : ''}]</span>
      </h3>
      <div class="header-actions">
        {#if status === 'todo'}
          <button class="add-btn" title="Add task" onclick={() => onAddTask(status)}>+</button>
        {/if}
        <button class="collapse-btn" title="Collapse column" onclick={toggleCollapse}>«</button>
      </div>
    </div>

    {#if wipWarning}
      <div class="wip-banner">WIP limit exceeded ({tasks.length}/{WIP_LIMIT})</div>
    {/if}

    <div class="card-list">
      {#each tasks as task (task.id)}
        <TaskCard {task} subtaskCount={subtaskCounts.get(task.id) ?? 0} {onEdit} {onDelete} {onDragStart} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .column {
    background: var(--column-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    width: 270px;
    min-width: 270px;
    max-height: calc(100vh - 60px);
    display: flex;
    flex-direction: column;
    transition: border-color 0.15s, width 0.2s, min-width 0.2s;
    flex-shrink: 0;
  }

  .column.collapsed {
    width: 40px;
    min-width: 40px;
  }

  .column.drag-over {
    border-color: var(--primary);
    box-shadow: 0 0 0 1px var(--primary-dim);
  }

  .column.wip-warning {
    border-color: var(--priority-high);
  }

  /* ── Collapsed state ── */

  .column-collapsed {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px 0 12px;
    gap: 10px;
    flex: 1;
    overflow: hidden;
  }

  .expand-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 0.65rem;
    padding: 2px 5px;
    line-height: 1.4;
  }

  .expand-btn:hover {
    border-color: var(--primary);
    color: var(--primary);
  }

  .collapsed-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    flex: 1;
    justify-content: center;
  }

  .collapsed-count {
    font-size: 0.6rem;
    color: var(--text-muted);
    font-weight: 700;
  }

  .collapsed-count.wip {
    color: var(--priority-high);
  }

  .collapsed-text {
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  /* ── Expanded state ── */

  .column-header {
    padding: 8px 8px 8px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    gap: 6px;
  }

  .column-header h3 {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
  }

  .chevron {
    color: var(--primary);
    margin-right: 4px;
  }

  .count {
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 4px;
    font-size: 0.68rem;
  }

  .count.wip {
    color: var(--priority-high);
    font-weight: 700;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .add-btn,
  .collapse-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    width: 22px;
    height: 22px;
    font-size: 0.75rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .add-btn:hover,
  .collapse-btn:hover {
    border-color: var(--primary);
    color: var(--primary);
  }

  .wip-banner {
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--priority-high);
    background: color-mix(in srgb, var(--priority-high) 10%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--priority-high) 25%, transparent);
    padding: 3px 10px;
    flex-shrink: 0;
  }

  .card-list {
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
    flex: 1;
  }
</style>
