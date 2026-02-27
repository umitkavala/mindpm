<script lang="ts">
  import { api } from './lib/api.js';
  import type { Project, Task } from './lib/types.js';
  import ProjectSelector from './components/ProjectSelector.svelte';
  import ProjectSidebar from './components/ProjectSidebar.svelte';
  import KanbanBoard from './components/KanbanBoard.svelte';
  import NotesView from './components/NotesView.svelte';
  import DecisionsView from './components/DecisionsView.svelte';
  import CommandPalette from './components/CommandPalette.svelte';

  type View = 'kanban' | 'notes' | 'decisions';

  let projects: Project[] = $state([]);
  let selectedProjectId: string | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);
  let showPalette = $state(false);
  let newTaskFromPalette = $state(false);
  let activeView: View = $state('kanban');
  let openTaskFromView: Task | null = $state(null);

  const selectedProject = $derived(projects.find((p) => p.id === selectedProjectId) ?? null);

  async function loadProjects() {
    try {
      projects = await api.getProjects();
      if (projects.length > 0 && !selectedProjectId) {
        const urlParam = new URLSearchParams(window.location.search).get('project');
        const match = urlParam ? projects.find((p) => p.id === urlParam || p.name === urlParam) : null;
        selectedProjectId = match ? match.id : projects[0].id;
      }
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  function handleProjectSelect(id: string) {
    selectedProjectId = id;
    activeView = 'kanban';
    const url = new URL(window.location.href);
    url.searchParams.set('project', id);
    history.replaceState(null, '', url.toString());
  }

  async function handleProjectRenamed(id: string, newName: string) {
    try {
      await api.updateProject(id, { name: newName });
      const idx = projects.findIndex((p) => p.id === id);
      if (idx !== -1) {
        projects[idx] = { ...projects[idx], name: newName };
      }
    } catch (e: any) {
      error = e.message;
    }
  }

  $effect(() => {
    loadProjects();
  });

  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      showPalette = !showPalette;
    }
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#if showPalette}
  <CommandPalette
    {projects}
    onSelectProject={(id) => { selectedProjectId = id; }}
    onNewTask={() => { newTaskFromPalette = true; }}
    onClose={() => { showPalette = false; }}
  />
{/if}

{#if loading}
  <div class="loading"><span class="prompt">&gt;</span> loading projects...</div>
{:else if error}
  <div class="error"><span class="err-prefix">[error]</span> {error}</div>
{:else if projects.length === 0}
  <div class="empty">
    <p class="empty-prompt">&gt; no projects found</p>
    <p class="empty-hint">// create a project using mindpm MCP tools to get started</p>
  </div>
{:else}
  <div class="app-layout">
    <ProjectSidebar
      {projects}
      selectedId={selectedProjectId}
      onSelect={handleProjectSelect}
    />
    <div class="main">
      <ProjectSelector
        {projects}
        selectedId={selectedProjectId}
        onSelect={handleProjectSelect}
        onRenamed={handleProjectRenamed}
      />
      {#if selectedProject}
        <div class="tabs">
          <button class="tab" class:active={activeView === 'kanban'} onclick={() => activeView = 'kanban'}>Kanban</button>
          <button class="tab" class:active={activeView === 'notes'} onclick={() => activeView = 'notes'}>Notes</button>
          <button class="tab" class:active={activeView === 'decisions'} onclick={() => activeView = 'decisions'}>Decisions</button>
        </div>
        {#if activeView === 'kanban'}
          <KanbanBoard
            project={selectedProject}
            triggerNewTask={newTaskFromPalette}
            openTask={openTaskFromView}
            onNewTaskTriggered={() => { newTaskFromPalette = false; }}
            onOpenTaskHandled={() => { openTaskFromView = null; }}
          />
        {:else if activeView === 'notes'}
          <NotesView
            projectId={selectedProject.id}
            onOpenTask={(task) => { openTaskFromView = task; activeView = 'kanban'; }}
          />
        {:else if activeView === 'decisions'}
          <DecisionsView
            projectId={selectedProject.id}
            onOpenTask={(task) => { openTaskFromView = task; activeView = 'kanban'; }}
          />
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .app-layout {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  }

  .tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    padding: 0 16px;
    flex-shrink: 0;
  }

  .tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    padding: 8px 14px;
    margin-bottom: -1px;
    transition: color 0.1s, border-color 0.1s;
  }

  .tab:hover {
    color: var(--text-dim);
  }

  .tab.active {
    color: var(--primary);
    border-bottom-color: var(--primary);
  }

  .loading,
  .error,
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    gap: 8px;
    font-size: 0.85rem;
  }

  .prompt {
    color: var(--primary);
  }

  .loading {
    color: var(--text-dim);
  }

  .error {
    color: var(--danger);
  }

  .err-prefix {
    margin-right: 6px;
  }

  .empty-prompt {
    color: var(--text);
  }

  .empty-hint {
    color: var(--text-muted);
    font-size: 0.75rem;
  }
</style>
