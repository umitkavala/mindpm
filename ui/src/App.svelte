<script lang="ts">
  import { api } from './lib/api.js';
  import type { Project } from './lib/types.js';
  import ProjectSelector from './components/ProjectSelector.svelte';
  import KanbanBoard from './components/KanbanBoard.svelte';

  let projects: Project[] = $state([]);
  let selectedProjectId: string | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);

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
</script>

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
  <ProjectSelector
    {projects}
    selectedId={selectedProjectId}
    onSelect={handleProjectSelect}
    onRenamed={handleProjectRenamed}
  />
  {#if selectedProject}
    <KanbanBoard project={selectedProject} />
  {/if}
{/if}

<style>
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
