<script lang="ts">
  import type { Project, Task, TaskStatus, TaskPriority } from '../lib/types.js';
  import { COLUMNS } from '../lib/types.js';
  import { api } from '../lib/api.js';
  import KanbanColumn from './KanbanColumn.svelte';
  import TaskModal from './TaskModal.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';

  interface Props {
    project: Project;
  }

  let { project }: Props = $props();

  let tasks: Task[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);

  // Modal state
  let showModal = $state(false);
  let editingTask: Task | null = $state(null);
  let defaultStatus: TaskStatus = $state('todo');

  // Confirm dialog state
  let showConfirm = $state(false);
  let deletingTask: Task | null = $state(null);

  // DnD state
  let draggedTask: Task | null = $state(null);

  // Group tasks by status
  const tasksByStatus = $derived(
    COLUMNS.map((col) => ({
      ...col,
      tasks: tasks.filter((t) => t.status === col.status),
    })),
  );

  async function loadTasks() {
    loading = true;
    error = null;
    try {
      tasks = await api.getTasks(project.id);
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  // Reload tasks when project changes
  $effect(() => {
    project.id;
    loadTasks();
  });

  // --- Drag and drop ---
  function handleDragStart(e: DragEvent, task: Task) {
    draggedTask = task;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', task.id);
    }
  }

  async function handleDrop(newStatus: TaskStatus) {
    if (!draggedTask || draggedTask.status === newStatus) {
      draggedTask = null;
      return;
    }

    const task = draggedTask;
    const oldStatus = task.status;
    draggedTask = null;

    // Optimistic update
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx !== -1) {
      tasks[idx] = { ...tasks[idx], status: newStatus };
    }

    try {
      await api.updateTask(task.id, { status: newStatus });
    } catch (e: any) {
      // Revert on failure
      if (idx !== -1) {
        tasks[idx] = { ...tasks[idx], status: oldStatus };
      }
      error = e.message;
    }
  }

  // --- Task CRUD ---
  function openCreateModal(status: TaskStatus) {
    editingTask = null;
    defaultStatus = status;
    showModal = true;
  }

  function openEditModal(task: Task) {
    editingTask = task;
    showModal = true;
  }

  async function handleSave(data: {
    title: string;
    description: string;
    priority: TaskPriority;
    status?: TaskStatus;
    tags: string[];
  }) {
    try {
      if (editingTask) {
        // Update
        const updated = await api.updateTask(editingTask.id, {
          title: data.title,
          description: data.description || null,
          priority: data.priority,
          status: data.status,
          tags: data.tags.length > 0 ? data.tags : null,
        });
        const idx = tasks.findIndex((t) => t.id === editingTask!.id);
        if (idx !== -1) tasks[idx] = updated;
      } else {
        // Create
        const created = await api.createTask(project.id, {
          title: data.title,
          description: data.description || undefined,
          priority: data.priority,
          tags: data.tags.length > 0 ? data.tags : undefined,
        });
        tasks = [created, ...tasks];
      }
      showModal = false;
      editingTask = null;
    } catch (e: any) {
      error = e.message;
    }
  }

  function confirmDelete(task: Task) {
    deletingTask = task;
    showConfirm = true;
  }

  async function handleDelete() {
    if (!deletingTask) return;
    try {
      await api.deleteTask(deletingTask.id);
      tasks = tasks.filter((t) => t.id !== deletingTask!.id && t.parent_task_id !== deletingTask!.id);
      showConfirm = false;
      deletingTask = null;
    } catch (e: any) {
      error = e.message;
    }
  }
</script>

<div class="board-wrapper">
  {#if loading}
    <div class="board-message">Loading tasks...</div>
  {:else if error}
    <div class="board-message error">
      {error}
      <button onclick={() => { error = null; loadTasks(); }}>Retry</button>
    </div>
  {:else}
    <div class="board">
      {#each tasksByStatus as column (column.status)}
        <KanbanColumn
          status={column.status}
          label={column.label}
          tasks={column.tasks}
          onEdit={openEditModal}
          onDelete={confirmDelete}
          onDragStart={handleDragStart}
          onDrop={handleDrop}
          onAddTask={openCreateModal}
        />
      {/each}
    </div>
  {/if}
</div>

{#if showModal}
  <TaskModal
    task={editingTask}
    {defaultStatus}
    onSave={handleSave}
    onClose={() => { showModal = false; editingTask = null; }}
  />
{/if}

{#if showConfirm && deletingTask}
  <ConfirmDialog
    title="Delete Task"
    message="Are you sure you want to delete &quot;{deletingTask.title}&quot;? This cannot be undone."
    onConfirm={handleDelete}
    onCancel={() => { showConfirm = false; deletingTask = null; }}
  />
{/if}

<style>
  .board-wrapper {
    flex: 1;
    overflow-x: auto;
    padding: 16px;
  }

  .board {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    min-height: calc(100vh - 100px);
  }

  .board-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    min-height: 200px;
    color: var(--text-muted);
    font-size: 1rem;
  }

  .board-message.error {
    color: var(--danger);
  }

  .board-message button {
    padding: 6px 16px;
    background: var(--primary);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-weight: 600;
  }
</style>
