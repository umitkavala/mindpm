<script lang="ts">
  import type { Project } from '../lib/types.js';

  interface Props {
    projects: Project[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    onRenamed: (id: string, name: string) => void;
  }

  let { projects, selectedId, onSelect, onRenamed }: Props = $props();

  let editing = $state(false);
  let editName = $state('');

  const selected = $derived(projects.find((p) => p.id === selectedId));

  function startEditing() {
    if (!selected) return;
    editName = selected.name;
    editing = true;
  }

  function finishEditing() {
    if (!selected || !editing) return;
    const trimmed = editName.trim();
    if (trimmed && trimmed !== selected.name) {
      onRenamed(selected.id, trimmed);
    }
    editing = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') finishEditing();
    if (e.key === 'Escape') { editing = false; }
  }
</script>

<header class="toolbar">
  <div class="brand"><span class="prompt">&gt;</span> mindpm</div>

  <div class="project-area">
    <span class="project-label">project:</span>
    <select
      value={selectedId ?? ''}
      onchange={(e) => onSelect((e.target as HTMLSelectElement).value)}
    >
      {#each projects as project}
        <option value={project.id}>{project.name}</option>
      {/each}
    </select>

    {#if selected}
      {#if selected.slug}
        <span class="project-slug">[{selected.slug}]</span>
      {/if}
      {#if editing}
        <input
          class="rename-input"
          type="text"
          bind:value={editName}
          onblur={finishEditing}
          onkeydown={handleKeydown}
          autofocus
        />
      {:else}
        <button class="rename-btn" onclick={startEditing} title="Rename project">
          ✎
        </button>
      {/if}
    {/if}
  </div>
</header>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 8px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .brand {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--primary);
    letter-spacing: 0.5px;
    white-space: nowrap;
  }

  .prompt {
    color: var(--text-dim);
  }

  .project-area {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .project-label {
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .project-slug {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  select {
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-bright);
    background: var(--surface-2);
    color: var(--text);
    appearance: auto;
  }

  select option {
    background: var(--surface-2);
    color: var(--text);
  }

  .rename-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    padding: 2px 7px;
    font-size: 0.85rem;
    line-height: 1.5;
  }

  .rename-btn:hover {
    border-color: var(--primary);
    color: var(--primary);
  }

  .rename-input {
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--primary);
    background: var(--surface-2);
    color: var(--text);
    width: 180px;
    outline: none;
    box-shadow: 0 0 0 2px var(--primary-dim);
  }
</style>
