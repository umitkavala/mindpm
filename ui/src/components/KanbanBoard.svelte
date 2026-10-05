<script lang="ts">
  import type { Project, Task, TaskStatus, TaskPriority, LaneId } from '../lib/types.js';
  import { COLUMNS, LANES } from '../lib/types.js';
  import { api } from '../lib/api.js';
  import KanbanColumn from './KanbanColumn.svelte';
  import KanbanLane from './KanbanLane.svelte';
  import TaskModal from './TaskModal.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import FilterBar from './FilterBar.svelte';

  interface Props {
    project: Project;
    triggerNewTask?: boolean;
    openTask?: Task | null;
    // A task key from the URL (?task=mndp-12), as in the session brief's links.
    openTaskKey?: string | null;
    onNewTaskTriggered?: () => void;
    onOpenTaskHandled?: () => void;
    onOpenTaskKeyHandled?: () => void;
  }

  let {
    project, triggerNewTask = false, openTask = null, openTaskKey = null, onNewTaskTriggered, onOpenTaskHandled, onOpenTaskKeyHandled,
  }: Props = $props();

  // Board view preferences, kept per browser.
  function pref<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  }
  function savePref(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  let viewMode = $state<'grouped' | 'all'>(pref('mindpm_board_view', 'grouped'));
  let doneDays = $state<number>(pref('mindpm_done_days', 7));
  let showCancelled = $state<boolean>(pref('mindpm_show_cancelled', false));
  $effect(() => savePref('mindpm_board_view', viewMode));
  $effect(() => savePref('mindpm_done_days', doneDays));
  $effect(() => savePref('mindpm_show_cancelled', showCancelled));

  // Non-fatal messages (a refused move or accept) shown above the board.
  let notice: string | null = $state(null);
  // Low-risk acceptable cards are in the batch unless unchecked.
  let batchExcluded = $state(new Set<string>());

  let tasks: Task[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);

  // Terminal columns (done/cancelled) are loaded a page at a time so a large
  // archive never has to be fetched or rendered all at once.
  const ARCHIVE_PAGE = 50;
  type TerminalStatus = 'done' | 'cancelled';
  let archiveMore = $state<Record<TerminalStatus, boolean>>({ done: false, cancelled: false });
  let archiveLoading = $state<Record<TerminalStatus, boolean>>({ done: false, cancelled: false });

  // Modal state
  let showModal = $state(false);
  let editingTask: Task | null = $state(null);
  let defaultStatus: TaskStatus = $state('ready');

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

  function withinDoneWindow(t: Task): boolean {
    if (doneDays === 0) return true;
    const at = t.completed_at ?? t.updated_at;
    if (!at) return true;
    return new Date(at.replace(' ', 'T') + 'Z').getTime() >= Date.now() - doneDays * 86_400_000;
  }

  // Done tasks loaded but outside the window, for "Show older".
  const hiddenDone = $derived(tasks.filter((t) => t.status === 'done' && !withinDoneWindow(t)).length);

  function sortTasks(list: Task[], terminal: boolean): Task[] {
    if (terminal) return list.sort((a, b) => (b.completed_at ?? b.updated_at ?? '').localeCompare(a.completed_at ?? a.updated_at ?? ''));
    return list.sort((a, b) => {
      const pd = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
      return pd !== 0 ? pd : (b.created_at ?? '').localeCompare(a.created_at ?? '');
    });
  }

  const visibleTasks = $derived(filteredTasks().filter((t) => (t.status === 'done' ? withinDoneWindow(t) : true)));

  const lanes = $derived(
    LANES.map((lane) => ({
      ...lane,
      tasks: sortTasks(visibleTasks.filter((t) => lane.statuses.includes(t.status)), lane.id === 'done'),
    })),
  );

  // With verification off, a human accepts submitted work straight from
  // needs_verification under the same risk rules as verified work.
  const verificationOff = $derived(project.verification !== 'on');
  const acceptable = (t: Task) => t.status === 'verified' || (verificationOff && t.status === 'needs_verification');

  const lowRiskBatch = $derived(
    lanes.find((l) => l.id === 'review')!.tasks.filter((t) => acceptable(t) && t.risk_level === 'low' && !batchExcluded.has(t.id)),
  );

  const keyOf = $derived(new Map(tasks.map((t) => [t.id, t.short_id ?? t.id])));
  function blockerKeys(t: Task): string[] {
    try {
      const ids = JSON.parse(t.blocked_by ?? '[]');
      return Array.isArray(ids) ? ids.map((id: string) => keyOf.get(id) ?? id) : [];
    } catch {
      return [];
    }
  }

  function cardExtras(t: Task) {
    const reviewDirect = verificationOff && t.status === 'needs_verification';
    if (acceptable(t) && t.risk_level === 'low') {
      return {
        reviewDirect,
        batch: {
          checked: !batchExcluded.has(t.id),
          onToggle: (task: Task) => {
            const next = new Set(batchExcluded);
            if (next.has(task.id)) next.delete(task.id); else next.add(task.id);
            batchExcluded = next;
          },
        },
      };
    }
    if (acceptable(t)) return { reviewDirect, onAccept: acceptOne, onReopen: openEditModal };
    if (t.status === 'needs_human') return { onResolve: openEditModal };
    if (t.status === 'blocked') return { blockerKeys: blockerKeys(t) };
    return {};
  }

  async function acceptOne(task: Task) {
    notice = null;
    try {
      await api.acceptTask(task.id);
      await loadTasks();
    } catch (e: any) {
      notice = e.message;
    }
  }

  async function acceptBatch() {
    notice = null;
    try {
      const out = await api.acceptTasks(lowRiskBatch.map((t) => t.id));
      if (out.refused.length) notice = out.refused.map((r) => `${keyOf.get(r.task_id) ?? r.task_id}: ${r.reason}`).join(' ');
      await loadTasks();
    } catch (e: any) {
      notice = e.message;
    }
  }

  // Group filtered tasks by status; done/cancelled sorted by recency, others by priority
  const tasksByStatus = $derived(
    COLUMNS.filter((col) => col.status !== 'cancelled' || showCancelled).map((col) => {
      const colTasks = visibleTasks.filter((t) => t.status === col.status);
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
      openCreateModal('ready');
    } else if (e.key === '/') {
      e.preventDefault();
      focusSearch?.();
    }
  }

  // React to triggerNewTask from command palette
  $effect(() => {
    if (triggerNewTask) {
      openCreateModal('ready');
      onNewTaskTriggered?.();
    }
  });

  // React to openTask from notes/decisions views
  $effect(() => {
    if (openTask) {
      editingTask = openTask;
      showModal = true;
      onOpenTaskHandled?.();
    }
  });

  // Open a task named in the URL once the board has loaded.
  $effect(() => {
    if (!openTaskKey || loading) return;
    const key = openTaskKey.toLowerCase();
    const match = tasks.find((t) => t.short_id?.toLowerCase() === key || t.id === openTaskKey);
    if (match) {
      editingTask = match;
      showModal = true;
    }
    onOpenTaskKeyHandled?.();
  });

  async function loadTasks(quiet = false) {
    if (!quiet) loading = true;
    error = null;
    try {
      const [active, done, cancelled] = await Promise.all([
        api.getTasks(project.id),
        api.getArchivedTasks(project.id, 'done', ARCHIVE_PAGE, 0),
        api.getArchivedTasks(project.id, 'cancelled', ARCHIVE_PAGE, 0),
      ]);
      tasks = [...active, ...done, ...cancelled];
      archiveMore = { done: done.length === ARCHIVE_PAGE, cancelled: cancelled.length === ARCHIVE_PAGE };
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function loadMoreArchive(status: TerminalStatus) {
    if (archiveLoading[status]) return;
    archiveLoading = { ...archiveLoading, [status]: true };
    try {
      const offset = tasks.filter((t) => t.status === status).length;
      const page = await api.getArchivedTasks(project.id, status, ARCHIVE_PAGE, offset);
      const existing = new Set(tasks.map((t) => t.id));
      tasks = [...tasks, ...page.filter((t) => !existing.has(t.id))];
      archiveMore = { ...archiveMore, [status]: page.length === ARCHIVE_PAGE };
    } catch (e: any) {
      notice = e.message;
    } finally {
      archiveLoading = { ...archiveLoading, [status]: false };
    }
  }

  function isTerminal(status: TaskStatus): status is TerminalStatus {
    return status === 'done' || status === 'cancelled';
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
    notice = null;

    // Optimistic update
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx !== -1) {
      tasks[idx] = { ...tasks[idx], status: newStatus };
    }

    try {
      await api.updateTask(task.id, { status: newStatus });
      if (newStatus === 'done') await loadTasks(true);
    } catch (e: any) {
      // Revert on failure; the server's transition table decides.
      if (idx !== -1) {
        tasks[idx] = { ...tasks[idx], status: oldStatus };
      }
      notice = e.message;
    }
  }

  // A lane holds several statuses, so a drop maps to the one human move the
  // lane allows: Done accepts verified work (or submitted work, with
  // verification off), Planned requeues a needs_human
  // task. Anything else goes through the card's actions.
  async function handleLaneDrop(lane: LaneId) {
    const task = draggedTask;
    draggedTask = null;
    if (!task) return;
    const from = LANES.find((l) => l.statuses.includes(task.status))?.id;
    if (from === lane) return;
    notice = null;
    try {
      if (lane === 'done' && acceptable(task)) {
        await api.acceptTask(task.id);
      } else if (lane === 'planned' && task.status === 'needs_human') {
        await api.resolveTask(task.id, 'requeue', 'Requeued from the board.');
      } else {
        notice = `${task.short_id ?? task.title}: that move isn't a single human step. Open the card for its actions.`;
        return;
      }
      await loadTasks(true);
    } catch (e: any) {
      notice = e.message;
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
      notice = e.message;
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
      notice = e.message;
    }
  }
</script>

<svelte:window onkeydown={handleBoardKeydown} />

<FilterBar
  allTags={allTags()}
  {searchQuery}
  {selectedPriorities}
  {selectedTags}
  {viewMode}
  {doneDays}
  {showCancelled}
  onSearchChange={(q) => { searchQuery = q; }}
  onPriorityToggle={togglePriority}
  onTagToggle={toggleTag}
  onClear={clearFilters}
  onViewModeChange={(m) => { viewMode = m; }}
  onDoneDaysChange={(d) => { doneDays = d; }}
  onShowCancelledChange={(v) => { showCancelled = v; }}
  bind:focusSearch
/>

{#if notice}
  <div class="notice" role="status">
    <span>{notice}</span>
    <button type="button" aria-label="Dismiss" onclick={() => { notice = null; }}>&times;</button>
  </div>
{/if}

<div class="board-wrapper" class:grouped={viewMode === 'grouped'}>
  {#if loading}
    <div class="board-message">Loading tasks...</div>
  {:else if error}
    <div class="board-message error">
      {error}
      <button onclick={() => { error = null; loadTasks(); }}>Retry</button>
    </div>
  {:else if viewMode === 'grouped'}
    <div class="lanes">
      {#each lanes as lane (lane.id)}
        <KanbanLane
          id={lane.id}
          label={lane.label}
          statuses={lane.statuses}
          sublabel={lane.id === 'done' ? (doneDays ? `last ${doneDays} days` : 'all') : undefined}
          tasks={lane.tasks}
          subtaskCounts={subtaskCounts()}
          headerAction={lane.id === 'review'
            ? { label: `Accept ${lowRiskBatch.length} low-risk`, disabled: lowRiskBatch.length === 0, onClick: acceptBatch }
            : undefined}
          footerAction={lane.id === 'done' && (hiddenDone > 0 || archiveMore.done)
            ? {
                label: archiveLoading.done ? 'Loading…' : 'Show older',
                disabled: archiveLoading.done,
                onClick: () => { if (hiddenDone > 0 && doneDays !== 0) doneDays = 0; else loadMoreArchive('done'); },
              }
            : undefined}
          {cardExtras}
          onEdit={openEditModal}
          onDelete={confirmDelete}
          onDragStart={handleDragStart}
          onDrop={handleLaneDrop}
          onAddTask={lane.id === 'planned' ? () => openCreateModal('ready') : undefined}
        />
      {/each}
    </div>
  {:else}
    <div class="board">
      {#each tasksByStatus as column (column.status)}
        {@const term = isTerminal(column.status) ? column.status : null}
        <KanbanColumn
          status={column.status}
          label={column.label}
          tasks={column.tasks}
          subtaskCounts={subtaskCounts()}
          hasMore={term ? archiveMore[term] : false}
          loadingMore={term ? archiveLoading[term] : false}
          onLoadMore={term ? () => { if (term === 'done') doneDays = 0; loadMoreArchive(term); } : undefined}
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
    allTasks={tasks}
    {defaultStatus}
    onSave={handleSave}
    onClose={() => { showModal = false; editingTask = null; }}
    onChanged={() => { showModal = false; editingTask = null; loadTasks(true); }}
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

  /* Grouped: five lanes share the width, so a laptop screen needs no
     horizontal scroll. Narrower screens fall back to scrolling. */
  .lanes {
    display: grid;
    grid-template-columns: repeat(5, minmax(200px, 1fr));
    gap: 10px;
    align-items: start;
    height: 100%;
  }

  .lanes > :global(.lane) {
    max-height: 100%;
  }

  .notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 8px 12px 0;
    padding: 6px 10px;
    font-size: 0.75rem;
    color: var(--priority-high);
    border: 1px solid color-mix(in srgb, var(--priority-high) 40%, transparent);
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--priority-high) 8%, transparent);
  }

  .notice button {
    background: none;
    border: none;
    color: inherit;
    font-size: 1rem;
    line-height: 1;
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
