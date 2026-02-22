<script lang="ts">
  import type { Project } from '../lib/types.js';

  interface Props {
    projects: Project[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    onRenamed: (id: string, name: string) => void;
  }

  // projects and onSelect kept for compatibility but not used in this component
  let { projects: _projects, selectedId, onSelect: _onSelect, onRenamed }: Props = $props();

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
  {#if selected}
    <div class="project-area">
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
        <span class="project-name">{selected.name}</span>
        {#if selected.slug}
          <span class="project-slug">[{selected.slug}]</span>
        {/if}
        <button class="rename-btn" onclick={startEditing} title="Rename project">✎</button>
      {/if}
    </div>
  {/if}
</header>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    padding: 7px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    min-height: 37px;
  }

  .project-area {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .project-name {
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--text);
  }

  .project-slug {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .rename-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    padding: 1px 6px;
    font-size: 0.8rem;
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
