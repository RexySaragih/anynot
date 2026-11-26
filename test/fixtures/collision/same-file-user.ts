export interface User {
  id: number;
  name: string;
}

export function useUser(user: User): string {
  return user.name;
}

// Structural match for same-file User; must not resolve to other-user.ts's User
export const person: any = { id: 1, name: 'Ada' };
