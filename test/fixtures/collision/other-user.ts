/**
 * Same interface name as same-file-user.ts, different shape.
 * Alphabetically first so a naive first-match lookup would pick this.
 */
export interface User {
  email: string;
  role: string;
}

export function describeUser(user: User): string {
  return `${user.email}:${user.role}`;
}
