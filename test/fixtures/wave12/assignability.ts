export interface StrictUser {
  id: number;
  name: string;
  email: string;
}

export function needsEmail(user: StrictUser): void {
  void user.email;
}

// Speculative structural suggestion that may fail StrictUser assignability
export function handleLoose(payload: any): void {
  void payload.id;
  void payload.name;
  needsEmail(payload);
}

// High-confidence fixable annotation
export const ready: any = { id: 1, name: 'Ada', email: 'a@b.c' };
