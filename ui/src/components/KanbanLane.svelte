<script lang="ts">
  import type { Task, LaneId, TaskStatus } from '../lib/types.js';
  import TaskCard from './TaskCard.svelte';

  type CardExtras = Partial<Pick<import('svelte').ComponentProps<typeof TaskCard>, 'batch' | 'onAccept' | 'onReopen' | 'onResolve' | 'reviewDirect' | 'blockerKeys'>>;

  interface Props {
    id: LaneId;
    label: string;
    statuses: TaskStatus[];
    sublabel?: string;
    tasks: Task[];
    subtaskCounts: Map<string, number>;
    headerAction?: { label: string; disabled?: boolean; onClick: () => void };
    footerAction?: { label: string; disabled?: boolean; onClick: () => void };
    cardExtras?: (task: Task) => CardExtras;
    onEdit: (task: Task) => void;
    onDelete: (task: Task) => void;
    onDragStart: (e: DragEvent, task: Task) => void;
    onDrop: (lane: LaneId) => void;
    onAddTask?: () => void;
  }

  let {
    id, label, statuses, sublabel, tasks, subtaskCounts, headerAction, footerAction, cardExtras, onEdit, onDelete, onDragStart, onDrop, onAddTask,
  }: Props = $props();

  let dragOver = $state(false);
</script>

<section
  class="lane lane-{id}"
  class:drag-over={dragOver}
  aria-label={label}
  ondragover={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; dragOver = true; }}
  ondragleave={() => { dragOver = false; }}
  ondrop={(e) => { e.preventDefault(); dragOver = false; onDrop(id); }}
>
  <div class="lane-header">
    <div class="lane-title">
      <h2>{label} <span class="count">[{tasks.length}]</span></h2>
      {#if onAddTask}
        <button type="button" class="add-btn" aria-label="Add task" title="Add task" onclick={onAddTask}>+</button>
      {/if}
    </div>
    <p class="sublabel">{sublabel ?? statuses.join(' · ')}</p>
    {#if headerAction}
      <button type="button" class="header-action" disabled={headerAction.disabled} onclick={headerAction.onClick}>{headerAction.label}</button>
    {/if}
  </div>
  <div class="card-list">
    {#each tasks as task (task.id)}
      <TaskCard
        {task}
        showChip
        subtaskCount={subtaskCounts.get(task.id) ?? 0}
        {...(cardExtras?.(task) ?? {})}
        {onEdit}
        {onDelete}
        {onDragStart}
      />
    {:else}
      <p class="empty">nothing here</p>
    {/each}
    {#if footerAction}
      <button type="button" class="footer-action" disabled={footerAction.disabled} onclick={footerAction.onClick}>{footerAction.label}</button>
    {/if}
  </div>
</section>

<style>
  .lane {
    background: var(--column-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-height: 100%;
    transition: border-color 0.15s;
  }
  .lane-attention { border-color: var(--attention); }
  .lane-attention h2 { color: var(--status-verifying); }
  .lane.drag-over { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary-dim); }

  .lane-header {
    padding: 10px 10px 8px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
  }
  .lane-title { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  h2 {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text);
  }
  .count { color: var(--text-dim); font-weight: 400; }
  .sublabel { font-size: 0.65rem; color: var(--text-dim); }

  .add-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    width: 24px;
    height: 24px;
    color: var(--text-dim);
  }
  .add-btn:hover { border-color: var(--primary); color: var(--primary); }

  .header-action {
    margin-top: 4px;
    min-height: 36px;
    background: var(--primary-dim);
    color: var(--primary);
    border: 1px solid color-mix(in srgb, var(--primary) 45%, transparent);
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    font-weight: 700;
    text-align: left;
    padding: 6px 10px;
  }
  .header-action:disabled { opacity: 0.45; cursor: default; }

  .card-list {
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .empty { font-size: 0.68rem; color: var(--text-muted); padding: 6px 4px; }

  .footer-action {
    min-height: 36px;
    background: none;
    border: 1px dashed var(--border-bright);
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .footer-action:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
</style>
