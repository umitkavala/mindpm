<script lang="ts">
  import type { Task, TaskStatus, TaskPriority } from '../lib/types.js';
  import { PRIORITY_ORDER } from '../lib/types.js';

  interface Props {
    task: Task | null;
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

  let { task, defaultStatus = 'todo', onSave, onClose }: Props = $props();

  let title = $state('');
  let description = $state('');
  let priority: TaskPriority = $state('medium');
  let status: TaskStatus = $state('todo');
  let tagsStr = $state('');

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
      <h2>{isEdit ? 'Edit Task' : 'New Task'}</h2>
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
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: var(--surface);
    border-radius: var(--radius);
    width: 460px;
    max-width: 95vw;
    max-height: 90vh;
    overflow-y: auto;
    padding: 24px;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  .modal-header h2 {
    font-size: 1.2rem;
    font-weight: 600;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 1.5rem;
    color: var(--text-muted);
    padding: 0 4px;
  }

  .close-btn:hover {
    color: var(--text);
  }

  .field {
    margin-bottom: 16px;
    flex: 1;
  }

  label {
    display: block;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
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
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
  }

  input:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 2px rgba(0, 121, 191, 0.2);
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
    margin-top: 20px;
  }

  .btn-cancel,
  .btn-save {
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    font-weight: 600;
    border: none;
  }

  .btn-cancel {
    background: var(--bg);
    color: var(--text-muted);
  }

  .btn-cancel:hover {
    background: var(--border);
  }

  .btn-save {
    background: var(--primary);
    color: white;
  }

  .btn-save:hover {
    background: var(--primary-hover);
  }
</style>
