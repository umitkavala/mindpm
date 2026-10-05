import { randomUUID } from 'node:crypto';

// Each MCP client starts its own mindpm process, so a per-process id names the
// connection a call came from. Unlike an actor id, the caller can't declare it.
let connection: string = randomUUID();

export function connectionId(): string {
  return connection;
}

/** Start a new connection id, as if another client connected. For use in tests only. */
export function newConnectionForTests(): string {
  connection = randomUUID();
  return connection;
}

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
