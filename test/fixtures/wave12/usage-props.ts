export interface Account {
  id: number;
  name: string;
}

export function takeId(id: number): void {
  void id;
}

export function takeName(name: string): void {
  void name;
}

// Property types from assignment + methods + arg expected types
export function enrich(account: any): void {
  account.id = 42;
  account.name = account.name.split(' ')[0]!;
  takeId(account.id);
  takeName(account.name);
}

// Destructuring parameter
export function readPair({ id, name }: any): string {
  return `${id}:${name}`;
}

// Array map callback
export function mapNames(rows: Account[]): string[] {
  return rows.map((row: any) => row.name);
}

// Class field assigned in constructor
export class Holder {
  value: any;

  constructor(seed: number) {
    this.value = seed;
  }
}
