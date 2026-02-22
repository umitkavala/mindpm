<script lang="ts">
  import type { Task, TaskStatus, TaskPriority, Decision } from '../lib/types.js';
  import { PRIORITY_ORDER } from '../lib/types.js';
  import { api } from '../lib/api.js';

  interface Props {
    task: Task | null;
    projectId: string;
    defaultStatus?: TaskStatus;
    onSave: (data: {
      title: string;
      description: string;
      priority: TaskPriority;
      status?: TaskStatus;
      tags: string[];
    }) => void;
    onClose: () => void;
  }

  let { task, projectId, defaultStatus = 'todo', onSave, onClose }: Props = $props();

  let title = $state('');
  let description = $state('');
  let priority: TaskPriority = $state('medium');
  let status: TaskStatus = $state('todo');
  let tagsStr = $state('');
  let decisions: Decision[] = $state([]);

  // Initialize form state from task prop
  $effect(() => {
    title = task?.title ?? '';
    description = task?.description ?? '';
    priority = task?.priority ?? 'medium';
    status = task?.status ?? defaultStatus;
    if (task?.tags) {
      try {
        tagsStr = JSON.parse(task.tags).join(', ');
      } catch {
        tagsStr = '';
      }
    } else {
      tagsStr = '';
    }
  });

  // Load decisions when editing a task
  $effect(() => {
    if (task !== null) {
      api.getDecisions(projectId).then((d) => { decisions = d; }).catch(() => { decisions = []; });
    } else {
      decisions = [];
    }
  });

  const isEdit = $derived(task !== null);

  function handleSubmit(e: Event) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    const tags = tagsStr
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    onSave({
      title: trimmed,
      description: description.trim(),
      priority,
      ...(isEdit ? { status } : {}),
      tags,
    });
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('modal-backdrop')) {
      onClose();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={handleBackdropClick}>
  <div class="modal">
    <div class="modal-header">
      <div class="modal-title">
        <h2>{isEdit ? 'Edit Task' : 'New Task'}</h2>
        {#if task?.short_id}
          <span class="modal-task-id">{task.short_id}</span>
        {/if}
      </div>
      <button class="close-btn" onclick={onClose}>&times;</button>
    </div>
    <form onsubmit={handleSubmit}>
      <div class="field">
        <label for="title">Title</label>
        <input id="title" type="text" bind:value={title} placeholder="Task title" autofocus required />
      </div>

      <div class="field">
        <label for="description">Description</label>
        <textarea id="description" bind:value={description} placeholder="Optional description" rows="3"></textarea>
      </div>

      <div class="row">
        <div class="field">
          <label for="priority">Priority</label>
          <select id="priority" bind:value={priority}>
            {#each PRIORITY_ORDER as p}
              <option value={p}>{p}</option>
            {/each}
          </select>
        </div>

        {#if isEdit}
          <div class="field">
            <label for="status">Status</label>
            <select id="status" bind:value={status}>
              <option value="todo">Todo</option>
              <option value="in_progress">In Progress</option>
              <option value="blocked">Blocked</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        {/if}
      </div>

      <div class="field">
        <label for="tags">Tags <span class="hint">(comma-separated)</span></label>
        <input id="tags" type="text" bind:value={tagsStr} placeholder="e.g. backend, auth, bug" />
      </div>

      <div class="actions">
        <button type="button" class="btn-cancel" onclick={onClose}>Cancel</button>
        <button type="submit" class="btn-save">{isEdit ? 'Save' : 'Create'}</button>
      </div>
    </form>

    {#if isEdit && decisions.length > 0}
      <div class="decisions-section">
        <h3 class="decisions-heading">Decisions</h3>
        <div class="decisions-list">
          {#each decisions as d (d.id)}
            <div class="decision-item">
              <div class="decision-title">{d.title}</div>
              <div class="decision-body">{d.decision}</div>
              {#if d.reasoning}
                <div class="decision-reasoning">{d.reasoning}</div>
              {/if}
              {#if d.alternatives}
                {@const alts = (() => { try { return JSON.parse(d.alternatives); } catch { return null; } })()}
                {#if alts && alts.length > 0}
                  <div class="decision-alts">Alternatives: {alts.join(', ')}</div>
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: var(--surface);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    width: 520px;
    max-width: 95vw;
    max-height: 90vh;
    overflow-y: auto;
    padding: 20px;
  }

  .modal-title {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .modal-task-id {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 18px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  .modal-header h2 {
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--primary);
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 1.2rem;
    color: var(--text-muted);
    padding: 0 4px;
    line-height: 1;
  }

  .close-btn:hover {
    color: var(--danger);
  }

  .field {
    margin-bottom: 14px;
    flex: 1;
  }

  label {
    display: block;
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 4px;
  }

  .hint {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
  }

  input,
  textarea,
  select {
    width: 100%;
    padding: 7px 9px;
    border: 1px solid var(--border-bright);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
  }

  input:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 2px var(--primary-dim);
  }

  textarea {
    resize: vertical;
  }

  .row {
    display: flex;
    gap: 12px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }

  .btn-cancel,
  .btn-save {
    padding: 6px 14px;
    border-radius: var(--radius-sm);
    font-weight: 600;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .btn-cancel {
    background: none;
    border: 1px solid var(--border-bright);
    color: var(--text-muted);
  }

  .btn-cancel:hover {
    border-color: var(--text-muted);
    color: var(--text);
  }

  .btn-save {
    background: var(--primary);
    border: 1px solid var(--primary);
    color: #0d0d0d;
    font-weight: 700;
  }

  .btn-save:hover {
    background: var(--primary-hover);
    border-color: var(--primary-hover);
  }

  .decisions-section {
    margin-top: 18px;
    border-top: 1px solid var(--border);
    padding-top: 14px;
  }

  .decisions-heading {
    font-size: 0.65rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }

  .decisions-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 240px;
    overflow-y: auto;
  }

  .decision-item {
    background: var(--bg);
    border: 1px solid var(--border);
    border-left: 3px solid var(--border-bright);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }

  .decision-title {
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 3px;
  }

  .decision-body {
    font-size: 0.75rem;
    color: var(--text-dim);
    line-height: 1.4;
  }

  .decision-reasoning {
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-top: 3px;
    line-height: 1.4;
    font-style: italic;
  }

  .decision-alts {
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-top: 3px;
  }
</style>
