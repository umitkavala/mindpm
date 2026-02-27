<script lang="ts">
  import type { Project } from '../lib/types.js';

  interface Props {
    projects: Project[];
    selectedId: string | null;
    onSelect: (id: string) => void;
  }

  let { projects, selectedId, onSelect }: Props = $props();

  const STORAGE_KEY = 'mindpm_sidebar_collapsed';
  let collapsed = $state(localStorage.getItem(STORAGE_KEY) === 'true');

  function toggleCollapse() {
    collapsed = !collapsed;
    localStorage.setItem(STORAGE_KEY, String(collapsed));
  }

  const statusDot: Record<string, string> = {
    active: 'var(--primary)',
    paused: '#d29922',
    completed: 'var(--text-muted)',
    archived: 'var(--border-bright)',
  };
</script>

<aside class="sidebar" class:collapsed>
  <div class="sidebar-header">
    {#if !collapsed}
      <span class="brand"><span class="prompt">&gt;</span> mindpm</span>
    {/if}
    <button class="collapse-btn" onclick={toggleCollapse} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
      {collapsed ? '»' : '«'}
    </button>
  </div>

  <nav class="project-list">
    {#each projects as project (project.id)}
      <button
        class="project-item"
        class:active={project.id === selectedId}
        onclick={() => onSelect(project.id)}
        title={collapsed ? project.name : undefined}
      >
        <span class="status-dot" style="background: {statusDot[project.status] ?? 'var(--text-muted)'}"></span>
        {#if !collapsed}
          <span class="project-name">{project.name}</span>
          {#if (project.active_task_count ?? 0) > 0}
            <span class="task-count">{project.active_task_count}</span>
          {/if}
        {:else}
          {#if project.slug}
            <span class="project-slug-collapsed">{project.slug}</span>
          {/if}
        {/if}
      </button>
    {/each}
  </nav>

  {#if !collapsed}
    <div class="sidebar-footer">
      <span class="footer-hint">// {projects.length} project{projects.length !== 1 ? 's' : ''}</span>
    </div>
  {/if}
</aside>

<style>
  .sidebar {
    width: 200px;
    min-width: 200px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    transition: width 0.2s, min-width 0.2s;
    overflow: hidden;
  }

  .sidebar.collapsed {
    width: 44px;
    min-width: 44px;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 10px 10px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    gap: 8px;
  }

  .brand {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--primary);
    white-space: nowrap;
    overflow: hidden;
  }

  .prompt {
    color: var(--text-dim);
  }

  .collapse-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    font-size: 0.7rem;
    padding: 2px 6px;
    flex-shrink: 0;
    line-height: 1.4;
  }

  .collapse-btn:hover {
    border-color: var(--primary);
    color: var(--primary);
  }

  .project-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
  }

  .project-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px 6px 12px;
    background: none;
    border: none;
    border-left: 2px solid transparent;
    color: var(--text-dim);
    font-size: 0.75rem;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
    white-space: nowrap;
    overflow: hidden;
  }

  .project-item:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .project-item.active {
    border-left-color: var(--primary);
    color: var(--primary);
    background: var(--primary-dim);
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .project-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .task-count {
    font-size: 0.62rem;
    color: var(--text-muted);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 2px;
    padding: 0 4px;
    flex-shrink: 0;
    line-height: 1.6;
  }

  .project-item.active .task-count {
    border-color: var(--primary);
    color: var(--primary);
    background: none;
  }

  .project-slug-collapsed {
    font-size: 0.55rem;
    color: var(--text-muted);
    line-height: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .project-item.active .project-slug-collapsed {
    color: var(--primary);
  }

  .sidebar-footer {
    padding: 8px 12px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .footer-hint {
    font-size: 0.62rem;
    color: var(--text-muted);
  }
</style>
