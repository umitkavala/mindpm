<script lang="ts">
  import type { Task, TaskStatus, TaskPriority, TaskHistoryEvent } from '../lib/types.js';
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
  let history: TaskHistoryEvent[] = $state([]);

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

  // Load history when editing a task
  $effect(() => {
    if (task !== null) {
      api.getTaskHistory(task.id).then((h) => { history = h; }).catch(() => { history = []; });
    } else {
      history = [];
    }
  });

  const isEdit = $derived(task !== null);

  function formatHistoryEvent(event: TaskHistoryEvent): string {
    switch (event.event) {
      case 'created':
        return '<b>created</b>';
      case 'status_changed':
        return `status <b>${event.old_value}</b> → <b>${event.new_value}</b>`;
      case 'priority_changed':
        return `priority <b>${event.old_value}</b> → <b>${event.new_value}</b>`;
      case 'title_changed':
        return `title renamed`;
      default:
        return event.event.replace(/_/g, ' ');
    }
  }

  function formatTime(iso: string): string {
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

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

    {#if isEdit && history.length > 0}
      <div class="history-section">
        <h3 class="history-heading">History</h3>
        <div class="history-list">
          {#each history as event (event.id)}
            <div class="history-item">
              <span class="history-dot"></span>
              <div class="history-body">
                <span class="history-event">{@html formatHistoryEvent(event)}</span>
                <span class="history-time">{formatTime(event.created_at)}</span>
              </div>
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

  .history-section {
    margin-top: 18px;
    border-top: 1px solid var(--border);
    padding-top: 14px;
  }

  .history-heading {
    font-size: 0.65rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 10px;
  }

  .history-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    max-height: 180px;
    overflow-y: auto;
  }

  .history-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 4px 0;
    position: relative;
  }

  .history-item:not(:last-child)::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 14px;
    bottom: -4px;
    width: 1px;
    background: var(--border);
  }

  .history-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--border-bright);
    border: 1px solid var(--surface);
    flex-shrink: 0;
    margin-top: 3px;
  }

  .history-item:first-child .history-dot {
    background: var(--primary);
  }

  .history-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
  }

  .history-event {
    font-size: 0.72rem;
    color: var(--text-dim);
    line-height: 1.4;
  }

  .history-event :global(b) {
    color: var(--text);
    font-weight: 600;
  }

  .history-time {
    font-size: 0.62rem;
    color: var(--text-muted);
  }

</style>
