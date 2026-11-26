export interface User {
  id: number;
  name: string;
}

export function useUser(user: User): string {
  return user.name;
}

// high confidence + named type match candidate
export const person: any = { id: 10, name: 'Lin' };

// usage-based: property access
export function read(input: any) {
  return input.id + input.name;
}

// ignored findings
export const ignored: any = 1; // anynot-ignore

// anynot-ignore-next-line
export const ignoredNext: any = 2;

// fix target
export const fixMe: any = { id: 1, name: 'fix' };

// implicit any (no type annotation)
export function implicitParam(x) {
  return x;
}
