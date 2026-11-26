export const loose: any = 1;

export function needsReview(value: any) {
  return value;
}

// high-confidence fixable candidate
export const ready: AccountShape = { id: 1, name: 'ready' };
export interface AccountShape {
  id: number;
  name: string;
}
export const fixableAny: any = { id: 2, name: 'fix-me' };

// Placeholder id is replaced in tests via ignore-by-id fixture copy when needed.
export const suppressTarget: any = 99;
