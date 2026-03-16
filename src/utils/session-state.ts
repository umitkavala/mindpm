// Per-process set: tracks which project IDs have had a session started this run.
const autoStartedProjects = new Set<string>();

export function markSessionStarted(projectId: string): void {
  autoStartedProjects.add(projectId);
}

export function getSessionStartedProjects(): string[] {
  return [...autoStartedProjects];
}

/** Reset auto-session state. For use in tests only. */
export function resetAutoSession(): void {
  autoStartedProjects.clear();
}
