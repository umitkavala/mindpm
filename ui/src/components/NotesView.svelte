<script lang="ts">
  import type { Note, Task } from '../lib/types.js';
  import { api } from '../lib/api.js';

  interface Props {
    projectId: string;
    onOpenTask: (task: Task) => void;
  }

  let { projectId, onOpenTask }: Props = $props();

  let notes: Note[] = $state([]);
  let tasks: Task[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let searchQuery = $state('');
  let selectedCategory = $state<string | null>(null);
  let searchInputEl: HTMLInputElement | null = $state(null);

  $effect(() => {
    loading = true;
    error = null;
    searchQuery = '';
    selectedCategory = null;
    Promise.all([
      api.getNotes(projectId),
      api.getTasks(projectId),
    ]).then(([n, t]) => {
      notes = n;
      tasks = t;
    }).catch((e) => {
      error = e.message;
    }).finally(() => {
      loading = false;
    });
  });

  const taskMap = $derived(new Map(tasks.map((t) => [t.id, t])));

  const allCategories = $derived(
    [...new Set(notes.map(n => n.category))].sort()
  );

  const filteredNotes = $derived((() => {
    const q = searchQuery.trim().toLowerCase();
    return notes.filter(n => {
      if (selectedCategory && n.category !== selectedCategory) return false;
      if (!q) return true;
      if (n.content.toLowerCase().includes(q)) return true;
      const tags = parseTags(n.tags);
      if (tags.some(t => t.toLowerCase().includes(q))) return true;
      return false;
    });
  })());

  const CATEGORY_COLORS: Record<string, string> = {
    general: 'var(--text-muted)',
    architecture: '#3d98f4',
    bug: 'var(--danger)',
    idea: 'var(--priority-high)',
    research: '#a371f7',
    meeting: 'var(--text-dim)',
    review: 'var(--primary)',
  };

  function parseTags(raw: string | null): string[] {
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  function formatDate(iso: string): string {
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function highlight(text: string, query: string): string {
    const safe = escapeHtml(text);
    if (!query.trim()) return safe;
    const pattern = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(pattern, 'gi'), m => `<mark>${m}</mark>`);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      searchQuery = '';
      selectedCategory = null;
    }
    if (e.key === '/' && document.activeElement !== searchInputEl) {
      e.preventDefault();
      searchInputEl?.focus();
    }
  }

  const hasFilter = $derived(searchQuery.trim() !== '' || selectedCategory !== null);
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="view">
  {#if !loading && !error && notes.length > 0}
    <div class="search-bar">
      <div class="search-input-wrap">
        <span class="search-icon">/</span>
        <input
          bind:this={searchInputEl}
          type="text"
          placeholder="search notes..."
          bind:value={searchQuery}
        />
        {#if searchQuery}
          <button class="clear-input" onclick={() => searchQuery = ''}>&times;</button>
        {/if}
      </div>

      {#if allCategories.length > 1}
        <div class="category-chips">
          {#each allCategories as cat}
            <button
              class="chip"
              class:active={selectedCategory === cat}
              style="--chip-color: {CATEGORY_COLORS[cat] ?? 'var(--text-muted)'}"
              onclick={() => selectedCategory = selectedCategory === cat ? null : cat}
            >
              {cat}
            </button>
          {/each}
        </div>
      {/if}

      {#if hasFilter}
        <span class="result-count">{filteredNotes.length} / {notes.length}</span>
        <button class="clear-all" onclick={() => { searchQuery = ''; selectedCategory = null; }}>
          clear
        </button>
      {/if}

      <div class="shortcuts-hint">
        <span><kbd>/</kbd> search</span>
        <span><kbd>Esc</kbd> clear</span>
      </div>
    </div>
  {/if}

  {#if loading}
    <div class="state-msg"><span class="prompt">&gt;</span> loading notes...</div>
  {:else if error}
    <div class="state-msg err">[error] {error}</div>
  {:else if notes.length === 0}
    <div class="state-msg muted">// no notes yet — use add_note via MCP tools</div>
  {:else if filteredNotes.length === 0}
    <div class="state-msg muted">// no matches</div>
  {:else}
    <div class="list">
      {#each filteredNotes as note (note.id)}
        {@const linkedTask = note.task_id ? taskMap.get(note.task_id) : null}
        {@const tags = parseTags(note.tags)}
        <div class="card">
          <div class="card-header">
            <span class="category" style="color: {CATEGORY_COLORS[note.category] ?? 'var(--text-muted)'}">
              {note.category}
            </span>
            <span class="date">{formatDate(note.created_at)}</span>
          </div>
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          <div class="content">{@html highlight(note.content, searchQuery)}</div>
          {#if tags.length > 0 || linkedTask}
            <div class="card-footer">
              {#if tags.length > 0}
                <div class="tags">
                  {#each tags as tag}
                    <button
                      class="tag"
                      class:active={searchQuery.trim().toLowerCase() === tag.toLowerCase()}
                      onclick={() => searchQuery = tag}
                    >
                      {tag}
                    </button>
                  {/each}
                </div>
              {/if}
              {#if linkedTask}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <span class="task-link" onclick={() => onOpenTask(linkedTask)}>
                  → {linkedTask.short_id ?? linkedTask.id.slice(0, 8)}: {linkedTask.title}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .view {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .search-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .search-input-wrap {
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

  .search-input-wrap input {
    background: var(--bg);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 4px 26px 4px 22px;
    width: 180px;
    font-size: 0.75rem;
    font-family: var(--font-mono);
  }

  .search-input-wrap input:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 2px var(--primary-dim);
  }

  .search-input-wrap input::placeholder {
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
    cursor: pointer;
  }

  .clear-input:hover { color: var(--text); }

  .category-chips {
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
    color: var(--text-dim);
    cursor: pointer;
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

  .result-count {
    font-size: 0.65rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
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
    cursor: pointer;
  }

  .clear-all:hover { color: var(--danger-hover, var(--danger)); }

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

  .list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px 20px;
    max-width: 760px;
  }

  .state-msg {
    color: var(--text-dim);
    font-size: 0.8rem;
    padding: 40px 20px;
    text-align: center;
  }

  .state-msg.err { color: var(--danger); }
  .state-msg.muted { color: var(--text-muted); }
  .prompt { color: var(--primary); }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .category {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
  }

  .date {
    font-size: 0.62rem;
    color: var(--text-muted);
  }

  .content {
    font-size: 0.78rem;
    color: var(--text);
    line-height: 1.55;
    white-space: pre-wrap;
  }

  :global(.content mark) {
    background: color-mix(in srgb, var(--priority-high) 30%, transparent);
    color: var(--text);
    border-radius: 2px;
    padding: 0 1px;
  }

  .card-footer {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 2px;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .tag {
    font-size: 0.62rem;
    color: var(--text-muted);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 1px 6px;
    cursor: pointer;
    transition: border-color 0.1s, color 0.1s;
  }

  .tag:hover {
    border-color: var(--primary);
    color: var(--primary);
  }

  .tag.active {
    border-color: var(--primary);
    color: var(--primary);
    background: var(--primary-dim);
  }

  .task-link {
    font-size: 0.68rem;
    color: var(--primary);
    cursor: pointer;
    border: 1px solid var(--primary-dim);
    border-radius: var(--radius-sm);
    padding: 1px 7px;
    background: var(--primary-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 300px;
  }

  .task-link:hover {
    background: rgba(57, 211, 83, 0.25);
  }
</style>
