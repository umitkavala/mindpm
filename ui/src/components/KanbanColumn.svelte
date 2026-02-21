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
    <h3>{label} <span class="count">{tasks.length}</span></h3>
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
    border-radius: var(--radius);
    width: 280px;
    min-width: 280px;
    max-height: calc(100vh - 70px);
    display: flex;
    flex-direction: column;
    transition: background-color 0.15s;
  }

  .column.drag-over {
    background: #d5dbe3;
  }

  .column-header {
    padding: 10px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }

  .column-header h3 {
    font-size: 0.85rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
  }

  .count {
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 4px;
  }

  .add-btn {
    background: rgba(0, 0, 0, 0.08);
    border: none;
    border-radius: var(--radius-sm);
    width: 28px;
    height: 28px;
    font-size: 1.2rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .add-btn:hover {
    background: rgba(0, 0, 0, 0.15);
    color: var(--text);
  }

  .card-list {
    padding: 0 8px 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
    flex: 1;
  }
</style>
