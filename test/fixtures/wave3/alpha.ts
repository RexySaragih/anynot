export interface Account {
  id: number;
  name: string;
}

export function takePayload(payload: any): Account {
  return { id: payload.id, name: String(payload.name) };
}

export const typedOk: number = 1;
