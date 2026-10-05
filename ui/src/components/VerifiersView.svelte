<script lang="ts">
  import type { Project, Verifier, VerificationSetup } from '../lib/types.js';
  import { api } from '../lib/api.js';
  import ConfirmDialog from './ConfirmDialog.svelte';

  interface Props {
    project: Project;
    projects: Project[];
    // The project's verification was turned on or off: the board reloads.
    onVerificationChanged?: () => void;
  }

  let { project, projects, onVerificationChanged }: Props = $props();

  let setup: VerificationSetup | null = $state(null);
  let setupError: string | null = $state(null);
  let switching = $state(false);

  async function loadSetup() {
    try {
      setup = await api.getVerificationSetup(project.id);
    } catch (e: any) {
      setupError = e.message;
    }
  }

  async function setMode(mode: 'on' | 'off') {
    setupError = null;
    switching = true;
    try {
      setup = await api.setVerificationMode(project.id, mode);
      onVerificationChanged?.();
    } catch (e: any) {
      setupError = e.message;
      await loadSetup();
    } finally {
      switching = false;
    }
  }

  let verifiers: Verifier[] = $state([]);
  let error: string | null = $state(null);

  let name = $state('');
  let kind: 'local' | 'reviewer' = $state('local');
  let scope: 'project' | 'all' = $state('project');
  let issued: { name: string; kind: string; key: string } | null = $state(null);
  let copied = $state(false);
  let revoking: Verifier | null = $state(null);

  let configText = $state('');
  let configStatus: string | null = $state(null);
  // The project's verification commands: agent-editable, so never run as is.
  let projectCommands: Record<string, string> = $state({});

  const EXAMPLE = JSON.stringify({
    check_timeout_minutes: 15,
    checks: {
      build: { command: 'npm run build' },
      unit: { command: 'npm test -- --reporter=junit --outputFile=reports/junit.xml', report: { path: 'reports/junit.xml', format: 'junit' } },
    },
    reviewer: { command: 'claude -p', base_branch: 'main' },
  }, null, 2);

  function fromProjectCommands(): string {
    const checks = Object.fromEntries(Object.entries(projectCommands).map(([name, command]) => [name, { command }]));
    return JSON.stringify({ check_timeout_minutes: 15, checks, reviewer: { command: 'claude -p', base_branch: 'main' } }, null, 2);
  }

  async function load() {
    try {
      verifiers = await api.getVerifiers();
    } catch (e: any) {
      error = e.message;
    }
  }

  async function loadConfig() {
    configStatus = null;
    try {
      const { config: c, project_verification_commands } = await api.getVerifierConfig(project.id);
      projectCommands = project_verification_commands;
      configText = Object.keys(c).length ? JSON.stringify(c, null, 2) : '';
    } catch (e: any) {
      configStatus = e.message;
    }
  }

  $effect(() => {
    load();
  });

  $effect(() => {
    project.id;
    setupError = null;
    loadConfig();
    loadSetup();
  });

  const projectName = (id: string) => (id === '*' ? 'all projects' : projects.find((p) => p.id === id)?.name ?? id);
  const fmt = (iso: string | null) => (iso ? new Date(iso.replace(' ', 'T') + 'Z').toLocaleString() : 'never');

  async function register(e: Event) {
    e.preventDefault();
    error = null;
    copied = false;
    try {
      const out = await api.registerVerifier({ name: name.trim(), kind, project_ids: scope === 'all' ? ['*'] : [project.id] });
      issued = { name: out.verifier.name, kind: out.verifier.kind, key: out.key };
      name = '';
      await load();
      await loadSetup();
    } catch (err: any) {
      error = err.message;
    }
  }

  async function copyKey() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.key);
      copied = true;
    } catch {
      copied = false;
    }
  }

  async function revoke() {
    if (!revoking) return;
    try {
      await api.revokeVerifier(revoking.id);
      revoking = null;
      await load();
      await loadSetup();
    } catch (e: any) {
      error = e.message;
      revoking = null;
    }
  }

  async function saveConfig() {
    configStatus = null;
    let parsed: unknown;
    try {
      parsed = configText.trim() ? JSON.parse(configText) : {};
    } catch {
      configStatus = 'Not valid JSON.';
      return;
    }
    try {
      await api.setVerifierConfig(project.id, parsed);
      configStatus = 'Saved.';
      await loadSetup();
    } catch (e: any) {
      configStatus = e.message;
    }
  }
</script>

<div class="view">
  <section class="block">
    <h2>Verification · {project.name}</h2>
    <div class="toggle" role="radiogroup" aria-label="Verification">
      <button type="button" role="radio" aria-checked={setup?.mode === 'off'} class:on={setup?.mode === 'off'}
        disabled={switching || !setup} onclick={() => setMode('off')}>Off</button>
      <button type="button" role="radio" aria-checked={setup?.mode === 'on'} class:on={setup?.mode === 'on'}
        disabled={switching || !setup} onclick={() => setMode('on')}>On</button>
    </div>
    <p class="hint">Off: you accept submitted work directly. On: a verifier must rebuild and test it first.</p>
    {#if setupError}<p class="err" role="alert">{setupError}</p>{/if}
    {#if setup?.warning}<p class="warn" role="alert">{setup.warning}</p>{/if}
    {#if setup?.mode === 'off' && setup.missing.length && !setupError}
      <p class="hint">To turn it on, this project needs {setup.missing.join(' and ')}. Set them up below.</p>
    {/if}
  </section>

  {#if setup?.mode === 'on'}
    {@render verifierSetup()}
  {:else if setup}
    <details class="setup">
      <summary>Set up verification</summary>
      <div class="setup-body">{@render verifierSetup()}</div>
    </details>
  {/if}
</div>

{#snippet verifierSetup()}
  <section class="block">
    <h2>Verifiers</h2>
    <p class="hint">
      A verifier reruns a task's checks from a clean checkout of the submitted commit and is the only way to <b>verified</b>.
      It proves who it is with a key issued here. Run <code>mindpm verify</code> with <code>MINDPM_VERIFIER_KEY</code> (local) and,
      for review criteria, <code>MINDPM_REVIEWER_KEY</code>. Never put either key in the environment an agent runs in.
    </p>

    {#if issued}
      <div class="issued" role="status">
        <p><b>Key for verifier:{issued.name}</b>. It is shown once and only its hash is stored.</p>
        <div class="key-row">
          <code class="key">{issued.key}</code>
          <button type="button" onclick={copyKey}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <pre>export {issued.kind === 'local' ? 'MINDPM_VERIFIER_KEY' : 'MINDPM_REVIEWER_KEY'}=&lt;the key&gt;
npx mindpm verify</pre>
        <button type="button" class="ghost" onclick={() => { issued = null; }}>I saved it</button>
      </div>
    {/if}

    <form class="register" onsubmit={register}>
      <label>
        <span>name</span>
        <input type="text" bind:value={name} placeholder="local-laptop" pattern="[A-Za-z0-9._-]+" maxlength="64" required />
      </label>
      <label>
        <span>kind</span>
        <select bind:value={kind}>
          <option value="local">local: runs checks, starts and finishes runs</option>
          <option value="reviewer">reviewer: judges review criteria only</option>
        </select>
      </label>
      <label>
        <span>covers</span>
        <select bind:value={scope}>
          <option value="project">{project.name}</option>
          <option value="all">all projects</option>
        </select>
      </label>
      <button type="submit" class="primary">Register</button>
    </form>

    {#if error}<p class="err" role="alert">{error}</p>{/if}

    <table>
      <thead>
        <tr><th>verifier</th><th>kind</th><th>covers</th><th>last used</th><th></th></tr>
      </thead>
      <tbody>
        {#each verifiers as v (v.id)}
          <tr class:revoked={v.revoked_at}>
            <td>{v.actor}</td>
            <td>{v.kind}</td>
            <td>{v.project_ids.map(projectName).join(', ')}</td>
            <td>{fmt(v.last_used_at)}</td>
            <td>
              {#if v.revoked_at}
                <span class="muted">revoked {fmt(v.revoked_at)}</span>
              {:else}
                <button type="button" class="danger" onclick={() => { revoking = v; }}>Revoke</button>
              {/if}
            </td>
          </tr>
        {:else}
          <tr><td colspan="5" class="muted">No verifiers yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </section>

  <section class="block">
    <h2>Verifier config · {project.name}</h2>
    <p class="hint">
      Every command the verifier runs: each check's <code>command</code>, where it writes its test report (<code>junit</code> or <code>json</code>),
      its timeout (default 15 minutes), and the reviewer command for review criteria (default <code>claude -p</code>).
      Only editable here, so an agent can't weaken its own verification. The project's verification commands, which agents can change,
      are hints for the executor's brief and are never run by the verifier.
    </p>
    {#if !configText.trim() && Object.keys(projectCommands).length}
      <p class="hint">No checks yet: the verifier will run nothing but the task's criteria. Review the project's commands before copying them; an agent may have set them.</p>
    {/if}
    <textarea rows="12" bind:value={configText} placeholder={EXAMPLE} spellcheck="false" aria-label="Verifier config JSON"></textarea>
    <div class="row">
      <button type="button" class="primary" onclick={saveConfig}>Save config</button>
      {#if !configText.trim()}
        {#if Object.keys(projectCommands).length}
          <button type="button" class="ghost" onclick={() => { configText = fromProjectCommands(); }}>Start from project commands</button>
        {/if}
        <button type="button" class="ghost" onclick={() => { configText = EXAMPLE; }}>Start from example</button>
      {/if}
      {#if configStatus}<span class="status">{configStatus}</span>{/if}
    </div>
  </section>
{/snippet}

{#if revoking}
  <ConfirmDialog
    title="Revoke verifier"
    message="Revoke {revoking.actor}? Its key stops working at once and any run in progress under it ends as an error."
    onConfirm={revoke}
    onCancel={() => { revoking = null; }}
  />
{/if}

<style>
  .view { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 24px; max-width: 980px; }
  .block { display: flex; flex-direction: column; gap: 10px; }
  h2 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 1px; color: var(--text); }
  .hint { font-size: 0.75rem; color: var(--text-dim); line-height: 1.6; }
  code { color: var(--primary); }
  .register { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
  .register label { display: flex; flex-direction: column; gap: 3px; font-size: 0.68rem; color: var(--text-dim); }
  input, select, textarea {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
  }
  textarea { width: 100%; font-size: 0.75rem; resize: vertical; }
  button { min-height: 34px; padding: 6px 14px; border-radius: var(--radius-sm); font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; background: none; border: 1px solid var(--border-bright); color: var(--text); }
  .primary { background: var(--primary); border-color: var(--primary); color: var(--bg); }
  .danger { color: var(--danger); border-color: var(--danger); min-height: 28px; padding: 3px 10px; }
  .ghost { color: var(--text-dim); }
  .err { color: var(--danger); font-size: 0.75rem; }
  .muted { color: var(--text-dim); }
  .status { font-size: 0.72rem; color: var(--text-dim); }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  table { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
  th { text-align: left; color: var(--text-dim); font-weight: 400; padding: 4px 6px; }
  td { padding: 6px; border-top: 1px solid var(--border); }
  tr.revoked td { color: var(--text-muted); }
  .issued { border: 1px solid var(--primary); background: var(--primary-dim); border-radius: var(--radius); padding: 12px; display: flex; flex-direction: column; gap: 8px; font-size: 0.75rem; }
  .key-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .key { word-break: break-all; background: var(--bg); padding: 6px 8px; border-radius: var(--radius-sm); flex: 1; min-width: 0; }
  .toggle { display: inline-flex; align-self: flex-start; border: 1px solid var(--border-bright); border-radius: var(--radius-sm); overflow: hidden; }
  .toggle button { border: none; border-radius: 0; min-width: 64px; color: var(--text-dim); }
  .toggle button.on { background: var(--primary); color: var(--bg); }
  .warn { color: var(--status-verifying, var(--danger)); font-size: 0.75rem; }
  .setup summary { cursor: pointer; font-size: 0.75rem; color: var(--text-dim); }
  .setup-body { display: flex; flex-direction: column; gap: 24px; margin-top: 12px; }
  .issued pre { background: var(--bg); padding: 6px 8px; border-radius: var(--radius-sm); color: var(--text-dim); font-size: 0.7rem; }
</style>
