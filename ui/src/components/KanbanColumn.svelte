<script lang="ts">
  import type { Task, TaskStatus } from '../lib/types.js';
  import TaskCard from './TaskCard.svelte';

  interface Props {
    status: TaskStatus;
    label: string;
    tasks: Task[];
    onEdit: (task: Task) => void;
    onDelete: (task: Task) => void;
    onDragStart: (e: DragEvent, task: Task) => void;
    onDrop: (status: TaskStatus) => void;
    onAddTask: (status: TaskStatus) => void;
  }

  let { status, label, tasks, onEdit, onDelete, onDragStart, onDrop, onAddTask }: Props = $props();

  let dragOver = $state(false);

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
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  role="list"
>
  <div class="column-header">
    <h3><span class="chevron">▸</span> {label} <span class="count">[{tasks.length}]</span></h3>
    {#if status === 'todo'}
      <button class="add-btn" title="Add task" onclick={() => onAddTask(status)}>+</button>
    {/if}
  </div>
  <div class="card-list">
    {#each tasks as task (task.id)}
      <TaskCard {task} {onEdit} {onDelete} {onDragStart} />
    {/each}
  </div>
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
    transition: border-color 0.15s;
  }

  .column.drag-over {
    border-color: var(--primary);
    box-shadow: 0 0 0 1px var(--primary-dim);
  }

  .column-header {
    padding: 8px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
  }

  .column-header h3 {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
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

  .add-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    width: 22px;
    height: 22px;
    font-size: 1rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .add-btn:hover {
    border-color: var(--primary);
    color: var(--primary);
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
