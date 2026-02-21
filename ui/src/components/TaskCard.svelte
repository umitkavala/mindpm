<script lang="ts">
  import type { Task } from '../lib/types.js';

  interface Props {
    task: Task;
    onEdit: (task: Task) => void;
    onDelete: (task: Task) => void;
    onDragStart: (e: DragEvent, task: Task) => void;
  }

  let { task, onEdit, onDelete, onDragStart }: Props = $props();

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

  function handleDragStart(e: DragEvent) {
    dragging = true;
    onDragStart(e, task);
  }

  function handleDragEnd() {
    dragging = false;
  }
</script>

<div
  class="card"
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
    <button
      class="delete-btn"
      title="Delete task"
      onclick={(e: MouseEvent) => { e.stopPropagation(); onDelete(task); }}
    >
      &times;
    </button>
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
</div>

<style>
  .card {
    background: var(--surface);
    border-radius: var(--radius);
    padding: 10px;
    box-shadow: var(--card-shadow);
    cursor: grab;
    transition: box-shadow 0.15s;
  }

  .card:hover {
    box-shadow: var(--card-shadow-hover);
  }

  .card.dragging {
    opacity: 0.5;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .priority-badge {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 3px;
    color: white;
    letter-spacing: 0.5px;
  }

  .priority-critical { background: var(--priority-critical); }
  .priority-high { background: var(--priority-high); color: #333; }
  .priority-medium { background: var(--priority-medium); }
  .priority-low { background: var(--priority-low); color: #333; }

  .delete-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.2rem;
    line-height: 1;
    padding: 0 4px;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .card:hover .delete-btn {
    opacity: 1;
  }

  .delete-btn:hover {
    color: var(--danger);
  }

  .card-title {
    font-size: 0.9rem;
    font-weight: 500;
    word-break: break-word;
  }

  .card-desc {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-top: 4px;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
  }

  .tag {
    font-size: 0.7rem;
    background: var(--bg);
    color: var(--text-muted);
    padding: 2px 6px;
    border-radius: 3px;
  }
</style>
