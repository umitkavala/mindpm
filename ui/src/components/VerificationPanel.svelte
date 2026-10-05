<script lang="ts">
  import type { Task, TaskVerification, VerificationRun, Resolution } from '../lib/types.js';
  import { api } from '../lib/api.js';

  interface Props {
    task: Task;
    onChanged: () => void;
  }

  let { task, onChanged }: Props = $props();

  let data = $state<TaskVerification | null>(null);
  let loadError: string | null = $state(null);
  let actionError: string | null = $state(null);
  let busy = $state(false);
  let findings = $state('');
  let showReopen = $state(false);
  let note = $state('');
  let openTails = $state(new Set<string>());

  $effect(() => {
    task.id;
    data = null;
    loadError = null;
    api.getTaskVerification(task.id).then((d) => { data = d; }).catch((e) => { loadError = e.message; });
  });

  const latest = $derived(data?.runs.find((r) => r.status !== 'superseded') ?? data?.runs[0] ?? null);
  const older = $derived(data ? data.runs.filter((r) => r !== latest) : []);
  const legacy = $derived(task.status === 'needs_verification' && data !== null && !data.submission?.head_sha);
  const escalation = $derived.by(() => {
    if (!task.escalation) return null;
    try {
      return JSON.parse(task.escalation) as { question: string; options?: string[] };
    } catch {
      return null;
    }
  });

  async function act(fn: () => Promise<unknown>) {
    busy = true;
    actionError = null;
    try {
      await fn();
      onChanged();
    } catch (e: any) {
      actionError = e.message;
    } finally {
      busy = false;
    }
  }

  const accept = () => act(() => api.acceptTask(task.id));
  const reopen = () => act(() => api.reopenTask(task.id, findings.trim()));
  const resolve = (action: Resolution) => act(() => api.resolveTask(task.id, action, note.trim()));

  function toggleTail(key: string) {
    const next = new Set(openTails);
    if (next.has(key)) next.delete(key); else next.add(key);
    openTails = next;
  }

  const short = (sha: string | null) => (sha ? sha.slice(0, 9) : '—');
  const ms = (n: number | null) => (n === null ? '' : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
  const runLabel = (r: VerificationRun) => `${r.status} · attempt ${r.attempt_no} · ${short(r.head_sha)} · ${r.verifier}`;
</script>

<section class="panel" aria-label="Verification">
  <h3 class="section-heading">Verification</h3>

  {#if loadError}
    <p class="err">{loadError}</p>
  {:else if !data}
    <p class="muted">loading…</p>
  {:else}
    {#if data.submission}
      <div class="submission">
        <div><span class="k">submitted</span> attempt {data.submission.attempt_no} by {data.submission.actor}</div>
        <div><span class="k">commit</span> {short(data.submission.head_sha)}{data.submission.branch ? ` on ${data.submission.branch}` : ''}</div>
        <div><span class="k">risk</span> {data.risk_level}</div>
        {#if data.submission.self_report_mismatch}
          <div class="warn">The executor reported criteria as passing that the verifier found failing.</div>
        {/if}
      </div>
    {:else if legacy}
      <p class="muted">Submitted before the verification gate: no commit to verify. You can accept it directly.</p>
    {/if}

    {#if latest}
      <div class="run run-{latest.status}">
        <div class="run-head">{runLabel(latest)}</div>
        {#if latest.error_reason}<div class="run-reason">{latest.error_reason}</div>{/if}
        {#if latest.checks.length}
          <table>
            <thead><tr><th>check</th><th>exit</th><th>time</th><th>tests</th></tr></thead>
            <tbody>
              {#each latest.checks as c (c.name)}
                <tr class:bad={c.exit_code !== 0}>
                  <td>
                    {#if c.output_tail}
                      <button type="button" class="link" aria-expanded={openTails.has(c.name)} onclick={() => toggleTail(c.name)}>{c.name}</button>
                    {:else}{c.name}{/if}
                  </td>
                  <td>{c.exit_code ?? '—'}</td>
                  <td>{ms(c.duration_ms)}</td>
                  <td>{c.report ? `${c.report.passed}/${c.report.total}` : ''}</td>
                </tr>
                {#if openTails.has(c.name) && c.output_tail}
                  <tr><td colspan="4"><pre>{c.output_tail}</pre></td></tr>
                {/if}
              {/each}
            </tbody>
          </table>
        {/if}
        {#if latest.criteria.length}
          <ul class="criteria">
            {#each latest.criteria as c (c.criterion_id)}
              <li class="crit crit-{c.result}">
                <span class="crit-key">{c.key}</span>
                <span class="crit-result">{c.result.toUpperCase()}</span>
                <span class="crit-source">{c.source}</span>
                {#if c.statement}<div class="crit-statement">{c.statement}</div>{/if}
                <div class="crit-evidence">{c.evidence}</div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {:else if data.submission?.head_sha && task.status === 'needs_verification'}
      <p class="muted">Waiting for a verifier. Run <code>mindpm verify</code> with a verifier key.</p>
    {/if}

    {#if older.length}
      <details class="older">
        <summary>{older.length} earlier run{older.length > 1 ? 's' : ''}</summary>
        <ul>
          {#each older as r (r.id)}
            <li>{runLabel(r)}{r.error_reason ? ` — ${r.error_reason}` : ''}</li>
          {/each}
        </ul>
      </details>
    {/if}

    {#if task.status === 'verified' || legacy}
      <div class="actions">
        <button type="button" class="btn-primary" disabled={busy} onclick={accept}>Accept</button>
        {#if task.status === 'verified'}
          <button type="button" class="btn-ghost" disabled={busy} onclick={() => { showReopen = !showReopen; }} aria-expanded={showReopen}>Reopen</button>
        {/if}
      </div>
      {#if showReopen}
        <div class="reopen">
          <label for="reopen-findings">Findings for the next attempt <span class="muted">(uses an attempt)</span></label>
          <textarea id="reopen-findings" rows="3" maxlength="1500" bind:value={findings} placeholder="What is wrong and what to change"></textarea>
          <button type="button" class="btn-danger" disabled={busy || !findings.trim()} onclick={reopen}>Send back to ready</button>
        </div>
      {/if}
    {/if}
  {/if}

  {#if task.status === 'needs_human'}
    <div class="resolve">
      {#if escalation}
        <div class="question"><span class="k">question</span> {escalation.question}</div>
        {#if escalation.options?.length}
          <ul class="options">{#each escalation.options as o}<li>{o}</li>{/each}</ul>
        {/if}
      {/if}
      <label for="resolve-note">Answer or reason</label>
      <textarea id="resolve-note" rows="2" maxlength="1500" bind:value={note}></textarea>
      <div class="actions">
        <button type="button" class="btn-primary" disabled={busy || !note.trim()} onclick={() => resolve('requeue')}>Requeue</button>
        {#if data?.submission?.head_sha && !data.submission.verification_outcome}
          <button type="button" class="btn-ghost" disabled={busy || !note.trim()} onclick={() => resolve('reverify')}>Verify again</button>
        {/if}
        {#if task.spec_key}
          <button type="button" class="btn-ghost" disabled={busy || !note.trim()} onclick={() => resolve('revise_spec')}>Revise spec</button>
        {/if}
        <button type="button" class="btn-danger" disabled={busy || !note.trim()} onclick={() => resolve('cancel')}>Cancel task</button>
      </div>
    </div>
  {/if}

  {#if actionError}<p class="err" role="alert">{actionError}</p>{/if}
</section>

<style>
  .panel { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
  .section-heading { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--text-dim); }
  .muted { color: var(--text-dim); font-size: 0.75rem; }
  .err { color: var(--danger); font-size: 0.75rem; }
  .warn { color: var(--priority-high); font-size: 0.72rem; margin-top: 4px; }
  .k { color: var(--text-dim); display: inline-block; min-width: 76px; }
  .submission { font-size: 0.75rem; display: flex; flex-direction: column; gap: 2px; }
  .run { border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; display: flex; flex-direction: column; gap: 8px; }
  .run-passed { border-color: color-mix(in srgb, var(--status-verified) 50%, transparent); }
  .run-failed { border-color: color-mix(in srgb, var(--danger) 50%, transparent); }
  .run-error { border-color: color-mix(in srgb, var(--priority-high) 50%, transparent); }
  .run-head { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text); }
  .run-reason { color: var(--priority-high); font-size: 0.72rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.72rem; }
  th { text-align: left; color: var(--text-dim); font-weight: 400; padding: 2px 4px; }
  td { padding: 3px 4px; border-top: 1px solid var(--border); vertical-align: top; }
  tr.bad td { color: var(--danger); }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 0.68rem; color: var(--text-dim); max-height: 220px; overflow: auto; background: var(--bg); padding: 6px; border-radius: var(--radius-sm); }
  .link { background: none; border: none; color: inherit; text-decoration: underline dotted; padding: 0; }
  .criteria { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .crit { font-size: 0.72rem; border-left: 2px solid var(--border-bright); padding-left: 8px; }
  .crit-pass { border-left-color: var(--status-verified); }
  .crit-fail { border-left-color: var(--danger); }
  .crit-missing { border-left-color: var(--priority-high); }
  .crit-key { font-weight: 700; margin-right: 6px; }
  .crit-result { font-size: 0.62rem; letter-spacing: 0.5px; margin-right: 6px; }
  .crit-pass .crit-result { color: var(--status-verified); }
  .crit-fail .crit-result { color: var(--danger); }
  .crit-missing .crit-result { color: var(--priority-high); }
  .crit-source { color: var(--text-dim); font-size: 0.62rem; }
  .crit-statement { color: var(--text-dim); }
  .crit-evidence { white-space: pre-wrap; word-break: break-word; }
  .older summary { font-size: 0.7rem; color: var(--text-dim); cursor: pointer; }
  .older ul { list-style: none; font-size: 0.7rem; color: var(--text-dim); margin-top: 4px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .reopen, .resolve { display: flex; flex-direction: column; gap: 6px; }
  .reopen label, .resolve label { font-size: 0.7rem; color: var(--text-dim); }
  textarea { background: var(--bg); color: var(--text); border: 1px solid var(--border-bright); border-radius: var(--radius-sm); padding: 6px; resize: vertical; }
  .question { font-size: 0.75rem; background: var(--surface-2); padding: 8px; border-radius: var(--radius-sm); }
  .options { font-size: 0.72rem; color: var(--text-dim); padding-left: 18px; }
  .btn-primary, .btn-ghost, .btn-danger { min-height: 36px; padding: 6px 14px; border-radius: var(--radius-sm); font-weight: 700; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.5px; }
  .btn-primary { background: var(--primary); color: var(--bg); border: 1px solid var(--primary); }
  .btn-ghost { background: none; color: var(--text); border: 1px solid var(--border-bright); }
  .btn-danger { background: none; color: var(--danger); border: 1px solid var(--danger); }
  button:disabled { opacity: 0.5; cursor: default; }
</style>
