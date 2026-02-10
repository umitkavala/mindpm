import { randomBytes } from 'crypto';

export function generateId(): string {
  return randomBytes(4).toString('hex');
}
