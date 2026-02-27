<script lang="ts">
  import type { Project, Task, TaskStatus, TaskPriority } from '../lib/types.js';
  import { COLUMNS } from '../lib/types.js';
  import { api } from '../lib/api.js';
  import KanbanColumn from './KanbanColumn.svelte';
  import TaskModal from './TaskModal.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import FilterBar from './FilterBar.svelte';

  interface Props {
    project: Project;
    triggerNewTask?: boolean;
    onNewTaskTriggered?: () => void;
  }

  let { project, triggerNewTask = false, onNewTaskTriggered }: Props = $props();

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

  // Filter state
  let searchQuery = $state('');
  let selectedPriorities = $state(new Set<TaskPriority>());
  let selectedTags = $state(new Set<string>());

  // Sub-task counts: parent task id → number of children
  const subtaskCounts = $derived(() => {
    const map = new Map<string, number>();
    for (const task of tasks) {
      if (task.parent_task_id) {
        map.set(task.parent_task_id, (map.get(task.parent_task_id) ?? 0) + 1);
      }
    }
    return map;
  });

  // All unique tags across loaded tasks
  const allTags = $derived(() => {
    const tagSet = new Set<string>();
    for (const task of tasks) {
      if (!task.tags) continue;
      try {
        for (const tag of JSON.parse(task.tags)) tagSet.add(tag);
      } catch {}
    }
    return [...tagSet].sort();
  });

  // Filtered tasks (applied before grouping by status)
  const filteredTasks = $derived(() => {
    let result = tasks;
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.description ?? '').toLowerCase().includes(q) ||
          (t.short_id ?? '').toLowerCase().includes(q),
      );
    }
    if (selectedPriorities.size > 0) {
      result = result.filter((t) => selectedPriorities.has(t.priority));
    }
    if (selectedTags.size > 0) {
      result = result.filter((t) => {
        if (!t.tags) return false;
        try {
          const tags: string[] = JSON.parse(t.tags);
          return tags.some((tag) => selectedTags.has(tag));
        } catch {
          return false;
        }
      });
    }
    return result;
  });

  const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

  // Group filtered tasks by status; done/cancelled sorted by updated_at desc, others by priority
  const tasksByStatus = $derived(
    COLUMNS.map((col) => {
      const colTasks = filteredTasks().filter((t) => t.status === col.status);
      if (col.status === 'done' || col.status === 'cancelled') {
        colTasks.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
      } else {
        colTasks.sort((a, b) => {
          const pd = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
          return pd !== 0 ? pd : (b.created_at ?? '').localeCompare(a.created_at ?? '');
        });
      }
      return { ...col, tasks: colTasks };
    }),
  );

  function togglePriority(p: TaskPriority) {
    const next = new Set(selectedPriorities);
    if (next.has(p)) next.delete(p); else next.add(p);
    selectedPriorities = next;
  }

  function toggleTag(t: string) {
    const next = new Set(selectedTags);
    if (next.has(t)) next.delete(t); else next.add(t);
    selectedTags = next;
  }

  function clearFilters() {
    searchQuery = '';
    selectedPriorities = new Set();
    selectedTags = new Set();
  }

  // Expose search focus for keyboard shortcut
  let focusSearch: (() => void) | null = $state(null);

  // Global keyboard shortcuts
  function handleBoardKeydown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (inInput || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      openCreateModal('todo');
    } else if (e.key === '/') {
      e.preventDefault();
      focusSearch?.();
    }
  }

  // React to triggerNewTask from command palette
  $effect(() => {
    if (triggerNewTask) {
      openCreateModal('todo');
      onNewTaskTriggered?.();
    }
  });

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
          tags: data.tags.length > 0 ? data.tags.join(',') : null,
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

<svelte:window onkeydown={handleBoardKeydown} />

<FilterBar
  allTags={allTags()}
  {searchQuery}
  {selectedPriorities}
  {selectedTags}
  onSearchChange={(q) => { searchQuery = q; }}
  onPriorityToggle={togglePriority}
  onTagToggle={toggleTag}
  onClear={clearFilters}
  bind:focusSearch
/>

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
          subtaskCounts={subtaskCounts()}
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
    projectId={project.id}
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
    overflow-y: hidden;
    padding: 12px;
    min-height: 0;
  }

  .board {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    height: 100%;
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
    padding: 5px 14px;
    background: none;
    color: var(--primary);
    border: 1px solid var(--primary);
    border-radius: var(--radius-sm);
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .board-message button:hover {
    background: var(--primary-dim);
  }
</style>
