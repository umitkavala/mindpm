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
  <div class="brand">mindpm</div>

  <div class="project-area">
    <select
      value={selectedId ?? ''}
      onchange={(e) => onSelect((e.target as HTMLSelectElement).value)}
    >
      {#each projects as project}
        <option value={project.id}>{project.name}</option>
      {/each}
    </select>

    {#if selected}
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
          &#9998;
        </button>
      {/if}
    {/if}
  </div>
</header>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 20px;
    background: var(--primary);
    color: white;
    flex-shrink: 0;
  }

  .brand {
    font-weight: 700;
    font-size: 1.2rem;
    letter-spacing: -0.5px;
  }

  .project-area {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  select {
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    border: none;
    background: rgba(255, 255, 255, 0.2);
    color: white;
    font-weight: 600;
    appearance: auto;
  }

  select option {
    color: var(--text);
    background: white;
  }

  .rename-btn {
    background: rgba(255, 255, 255, 0.2);
    border: none;
    color: white;
    border-radius: var(--radius-sm);
    padding: 4px 8px;
    font-size: 0.9rem;
  }

  .rename-btn:hover {
    background: rgba(255, 255, 255, 0.35);
  }

  .rename-input {
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    border: 2px solid white;
    background: rgba(255, 255, 255, 0.9);
    color: var(--text);
    font-weight: 600;
    width: 200px;
  }
</style>
