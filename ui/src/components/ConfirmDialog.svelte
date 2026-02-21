<script lang="ts">
  interface Props {
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }

  let { title, message, confirmLabel = 'Delete', onConfirm, onCancel }: Props = $props();

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains('modal-backdrop')) {
      onCancel();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onCancel();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={handleBackdropClick}>
  <div class="dialog">
    <h3>{title}</h3>
    <p>{message}</p>
    <div class="actions">
      <button class="btn-cancel" onclick={onCancel}>Cancel</button>
      <button class="btn-confirm" onclick={onConfirm}>{confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }

  .dialog {
    background: var(--surface);
    border-radius: var(--radius);
    padding: 24px;
    width: 360px;
    max-width: 90vw;
  }

  h3 {
    font-size: 1.1rem;
    margin-bottom: 8px;
  }

  p {
    color: var(--text-muted);
    font-size: 0.9rem;
    margin-bottom: 20px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .btn-cancel,
  .btn-confirm {
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    font-weight: 600;
    border: none;
  }

  .btn-cancel {
    background: var(--bg);
    color: var(--text-muted);
  }

  .btn-cancel:hover {
    background: var(--border);
  }

  .btn-confirm {
    background: var(--danger);
    color: white;
  }

  .btn-confirm:hover {
    background: var(--danger-hover);
  }
</style>
