import type { Project, Task, Decision, TaskHistoryEvent } from './types.js';

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

  getTasks: (projectId: string) =>
    request<Task[]>(`/projects/${projectId}/tasks?include_done=true`),

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

  getDecisions: (projectId: string) =>
    request<Decision[]>(`/projects/${projectId}/decisions`),

  getTaskHistory: (taskId: string) =>
    request<TaskHistoryEvent[]>(`/tasks/${taskId}/history`),
};
