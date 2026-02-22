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
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }

  .dialog {
    background: var(--surface);
    border: 1px solid var(--border-bright);
    border-top: 3px solid var(--danger);
    border-radius: var(--radius);
    padding: 20px;
    width: 340px;
    max-width: 90vw;
  }

  h3 {
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--danger);
    margin-bottom: 10px;
  }

  p {
    color: var(--text-dim);
    font-size: 0.78rem;
    margin-bottom: 18px;
    line-height: 1.5;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .btn-cancel,
  .btn-confirm {
    padding: 5px 14px;
    border-radius: var(--radius-sm);
    font-weight: 700;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .btn-cancel {
    background: none;
    border: 1px solid var(--border-bright);
    color: var(--text-muted);
  }

  .btn-cancel:hover {
    color: var(--text);
    border-color: var(--text-muted);
  }

  .btn-confirm {
    background: var(--danger);
    border: 1px solid var(--danger);
    color: white;
  }

  .btn-confirm:hover {
    background: var(--danger-hover);
    border-color: var(--danger-hover);
  }
</style>
