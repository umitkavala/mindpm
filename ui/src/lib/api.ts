import type {
  Project, Task, Note, Decision, TaskHistoryEvent, DeliveryMetrics, TaskVerification, Verifier, Resolution,
} from './types.js';

// The server embeds a per-start token in the page it serves; writes without
// it are refused, so other sites can't post to the local port.
const UI_TOKEN = document.querySelector<HTMLMetaElement>('meta[name="mindpm-token"]')?.content ?? '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Mindpm-Token': UI_TOKEN },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const api = {
  getProjects: () => request<Project[]>('/projects'),

  getProject: (id: string) => request<Project>(`/projects/${id}`),

  updateProject: (id: string, data: Partial<Pick<Project, 'name' | 'description' | 'status'>>) =>
    request<Project>(`/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // Active tasks only (everything except done/cancelled). Pass includeDone for
  // the full set — used where links to completed tasks must resolve.
  getTasks: (projectId: string, includeDone = false) =>
    request<Task[]>(`/projects/${projectId}/tasks${includeDone ? '?include_done=true' : ''}`),

  // A page of terminal-status tasks (done/cancelled), most recent first.
  getArchivedTasks: (projectId: string, status: 'done' | 'cancelled', limit: number, offset: number) =>
    request<Task[]>(`/projects/${projectId}/tasks?status=${status}&limit=${limit}&offset=${offset}`),

  createTask: (projectId: string, data: { title: string; description?: string; priority?: string; tags?: string[] }) =>
    request<Task>(`/projects/${projectId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateTask: (id: string, data: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'tags'>>) =>
    request<Task>(`/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteTask: (id: string) =>
    request<{ message: string }>(`/tasks/${id}`, { method: 'DELETE' }),

  getNotes: (projectId: string, limit = 100, offset = 0) =>
    request<Note[]>(`/projects/${projectId}/notes?limit=${limit}&offset=${offset}`),

  getDecisions: (projectId: string, limit = 100, offset = 0) =>
    request<Decision[]>(`/projects/${projectId}/decisions?limit=${limit}&offset=${offset}`),

  getTaskHistory: (taskId: string) =>
    request<TaskHistoryEvent[]>(`/tasks/${taskId}/history`),

  getMetrics: (projectId: string, days?: number) =>
    request<DeliveryMetrics>(`/projects/${projectId}/metrics${days ? `?days=${days}` : ''}`),

  // --- Verification gate (UI only) ---
  getTaskVerification: (taskId: string) => request<TaskVerification>(`/tasks/${taskId}/verification`),

  acceptTask: (taskId: string) => request<{ accepted: string[] }>(`/tasks/${taskId}/accept`, { method: 'POST' }),

  acceptTasks: (taskIds: string[]) =>
    request<{ accepted: string[]; refused: { task_id: string; reason: string }[] }>('/accept', {
      method: 'POST',
      body: JSON.stringify({ task_ids: taskIds }),
    }),

  reopenTask: (taskId: string, findings: string) =>
    request<{ status: string }>(`/tasks/${taskId}/reopen`, { method: 'POST', body: JSON.stringify({ findings }) }),

  resolveTask: (taskId: string, action: Resolution, note: string) =>
    request<{ status: string }>(`/tasks/${taskId}/resolve`, { method: 'POST', body: JSON.stringify({ action, note }) }),

  getVerifiers: () => request<Verifier[]>('/verifiers'),

  registerVerifier: (data: { name: string; kind: 'local' | 'reviewer'; project_ids: string[] }) =>
    request<{ verifier: Verifier; key: string }>('/verifiers', { method: 'POST', body: JSON.stringify(data) }),

  revokeVerifier: (id: string) => request<{ revoked: string }>(`/verifiers/${id}/revoke`, { method: 'POST' }),

  getVerifierConfig: (projectId: string) =>
    request<{ config: Record<string, unknown>; project_verification_commands: Record<string, string> }>(`/projects/${projectId}/verifier-config`),

  setVerifierConfig: (projectId: string, config: unknown) =>
    request<Record<string, unknown>>(`/projects/${projectId}/verifier-config`, { method: 'PUT', body: JSON.stringify(config) }),
};
