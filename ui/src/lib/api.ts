import type { Project, Task, Note, Decision, TaskHistoryEvent, DeliveryMetrics } from './types.js';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
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

  // Active tasks only (todo/in_progress/blocked/in_review). Pass includeDone for
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
};
