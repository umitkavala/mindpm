<script lang="ts">
  import type { TaskPriority } from '../lib/types.js';
  import { PRIORITY_ORDER } from '../lib/types.js';

  interface Props {
    allTags: string[];
    searchQuery: string;
    selectedPriorities: Set<TaskPriority>;
    selectedTags: Set<string>;
    onSearchChange: (q: string) => void;
    onPriorityToggle: (p: TaskPriority) => void;
    onTagToggle: (t: string) => void;
    onClear: () => void;
    focusSearch?: (() => void) | null;
  }

  let {
    allTags,
    searchQuery,
    selectedPriorities,
    selectedTags,
    onSearchChange,
    onPriorityToggle,
    onTagToggle,
    onClear,
    focusSearch = $bindable(null),
  }: Props = $props();

  let searchInputEl: HTMLInputElement | null = $state(null);

  $effect(() => {
    focusSearch = () => searchInputEl?.focus();
  });

  const activeCount = $derived(
    (searchQuery.trim() ? 1 : 0) + selectedPriorities.size + selectedTags.size
  );

  const priorityColors: Record<TaskPriority, string> = {
    critical: 'var(--priority-critical)',
    high: 'var(--priority-high)',
    medium: 'var(--priority-medium)',
    low: 'var(--text-muted)',
  };
</script>

<div class="filter-bar">
  <div class="filter-search">
    <span class="search-icon">/</span>
    <input
      bind:this={searchInputEl}
      type="text"
      placeholder="search tasks..."
      value={searchQuery}
      oninput={(e) => onSearchChange((e.target as HTMLInputElement).value)}
    />
    {#if searchQuery}
      <button class="clear-input" onclick={() => onSearchChange('')}>&times;</button>
    {/if}
  </div>

  <div class="filter-section">
    <span class="filter-label">priority:</span>
    <div class="chip-group">
      {#each PRIORITY_ORDER as p}
        <button
          class="chip"
          class:active={selectedPriorities.has(p)}
          style="--chip-color: {priorityColors[p]}"
          onclick={() => onPriorityToggle(p)}
        >
          {p}
        </button>
      {/each}
    </div>
  </div>

  {#if allTags.length > 0}
    <div class="filter-section">
      <span class="filter-label">tags:</span>
      <div class="chip-group">
        {#each allTags as tag}
          <button
            class="chip tag-chip"
            class:active={selectedTags.has(tag)}
            onclick={() => onTagToggle(tag)}
          >
            #{tag}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if activeCount > 0}
    <button class="clear-all" onclick={onClear}>
      clear [{activeCount}]
    </button>
  {/if}

  <div class="shortcuts-hint">
    <span><kbd>N</kbd> new</span>
    <span><kbd>/</kbd> search</span>
    <span><kbd>Ctrl K</kbd> palette</span>
  </div>
</div>

<style>
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 6px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  .filter-search {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-icon {
    position: absolute;
    left: 8px;
    color: var(--primary);
    font-weight: 700;
    font-size: 0.85rem;
    pointer-events: none;
  }

  .filter-search input {
    background: var(--bg);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 4px 26px 4px 22px;
    width: 180px;
    font-size: 0.75rem;
  }

  .filter-search input:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 2px var(--primary-dim);
  }

  .filter-search input::placeholder {
    color: var(--text-muted);
  }

  .clear-input {
    position: absolute;
    right: 6px;
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 0.9rem;
    line-height: 1;
    padding: 0;
  }

  .clear-input:hover {
    color: var(--text);
  }

  .filter-section {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .filter-label {
    font-size: 0.65rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .chip-group {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .chip {
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 7px;
    border-radius: 2px;
    border: 1px solid var(--border-bright);
    background: none;
    color: var(--text-muted);
    transition: border-color 0.1s, color 0.1s, background 0.1s;
  }

  .chip:hover {
    border-color: var(--chip-color, var(--text-dim));
    color: var(--chip-color, var(--text));
  }

  .chip.active {
    border-color: var(--chip-color, var(--primary));
    color: var(--chip-color, var(--primary));
    background: color-mix(in srgb, var(--chip-color, var(--primary)) 12%, transparent);
  }

  .tag-chip {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 600;
  }

  .tag-chip:hover,
  .tag-chip.active {
    --chip-color: var(--primary);
  }

  .clear-all {
    background: none;
    border: none;
    color: var(--danger);
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 0;
    margin-left: auto;
  }

  .clear-all:hover {
    color: var(--danger-hover);
  }

  .shortcuts-hint {
    display: flex;
    gap: 10px;
    margin-left: auto;
  }

  .shortcuts-hint span {
    font-size: 0.6rem;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 3px;
  }

  kbd {
    font-family: var(--font-mono);
    font-size: 0.58rem;
    background: var(--surface-2);
    border: 1px solid var(--border-bright);
    border-radius: 2px;
    padding: 1px 4px;
    color: var(--text-dim);
  }
</style>
