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
  <div class="loading">Loading projects...</div>
{:else if error}
  <div class="error">{error}</div>
{:else if projects.length === 0}
  <div class="empty">
    <h2>No projects yet</h2>
    <p>Create a project using mindpm MCP tools to get started.</p>
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
  }

  .error {
    color: var(--danger);
  }

  .empty h2 {
    font-size: 1.5rem;
    font-weight: 600;
  }

  .empty p {
    color: var(--text-muted);
  }
</style>
