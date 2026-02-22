<script lang="ts">
  import type { Project } from '../lib/types.js';

  interface Command {
    id: string;
    label: string;
    hint: string;
    action: () => void;
  }

  interface Props {
    projects: Project[];
    onSelectProject: (id: string) => void;
    onNewTask: () => void;
    onClose: () => void;
  }

  let { projects, onSelectProject, onNewTask, onClose }: Props = $props();

  let query = $state('');
  let activeIndex = $state(0);
  let inputEl: HTMLInputElement | null = $state(null);

  const allCommands = $derived<Command[]>([
    {
      id: 'new-task',
      label: 'new task',
      hint: 'create',
      action: () => { onClose(); onNewTask(); },
    },
    ...projects.map((p) => ({
      id: `project-${p.id}`,
      label: p.name,
      hint: p.slug ? `switch → ${p.slug}` : 'switch',
      action: () => { onClose(); onSelectProject(p.id); },
    })),
  ]);

  const filtered = $derived(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allCommands;
    return allCommands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q),
    );
  });

  // Reset active index when filtered list changes
  $effect(() => {
    filtered();
    activeIndex = 0;
  });

  function handleKeydown(e: KeyboardEvent) {
    const items = filtered();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[activeIndex]?.action();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('palette-backdrop')) {
      onClose();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="palette-backdrop" onclick={handleBackdropClick}>
  <div class="palette">
    <div class="palette-input-row">
      <span class="palette-prompt">&gt;</span>
      <input
        bind:this={inputEl}
        bind:value={query}
        onkeydown={handleKeydown}
        placeholder="type a command..."
        autofocus
      />
    </div>

    <div class="palette-list">
      {#each filtered() as cmd, i (cmd.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="palette-item"
          class:active={i === activeIndex}
          onmouseenter={() => { activeIndex = i; }}
          onclick={() => cmd.action()}
        >
          <span class="item-label">{cmd.label}</span>
          <span class="item-hint">{cmd.hint}</span>
        </div>
      {:else}
        <div class="palette-empty">no commands match</div>
      {/each}
    </div>

    <div class="palette-footer">
      <span><kbd>↑↓</kbd> navigate</span>
      <span><kbd>↵</kbd> select</span>
      <span><kbd>esc</kbd> close</span>
    </div>
  </div>
</div>

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 15vh;
    z-index: 300;
  }

  .palette {
    background: var(--surface);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius);
    width: 480px;
    max-width: 95vw;
    overflow: hidden;
  }

  .palette-input-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }

  .palette-prompt {
    color: var(--primary);
    font-weight: 700;
    font-size: 0.9rem;
    flex-shrink: 0;
  }

  .palette-input-row input {
    flex: 1;
    background: none;
    border: none;
    color: var(--text);
    font-size: 0.85rem;
    outline: none;
  }

  .palette-input-row input::placeholder {
    color: var(--text-muted);
  }

  .palette-list {
    max-height: 260px;
    overflow-y: auto;
  }

  .palette-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 14px;
    cursor: pointer;
    gap: 12px;
  }

  .palette-item.active {
    background: var(--surface-2);
    border-left: 2px solid var(--primary);
    padding-left: 12px;
  }

  .item-label {
    font-size: 0.8rem;
    color: var(--text);
  }

  .item-hint {
    font-size: 0.68rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .palette-empty {
    padding: 16px 14px;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .palette-footer {
    display: flex;
    gap: 16px;
    padding: 6px 14px;
    border-top: 1px solid var(--border);
    background: var(--bg);
  }

  .palette-footer span {
    font-size: 0.62rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 4px;
  }

  kbd {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    background: var(--surface-2);
    border: 1px solid var(--border-bright);
    border-radius: 2px;
    padding: 1px 4px;
    color: var(--text-dim);
  }
</style>
