export interface CheckoutPayload {
  id: number;
  name: string;
}

export function takePayload(payload: CheckoutPayload): void {
  void payload;
}

// high: literal object initializer
export const user: any = { id: 1, name: 'Ada' };

// high/medium: call-site contextual inference for parameter
export function handle(payload: any) {
  takePayload(payload);
}

// low: JSON.parse → unknown
export const parsed: any = JSON.parse('{"a":1}');

// high: return expression
export function getUser(): any {
  return { id: 2, name: 'Grace' };
}

// assertion on JSON.parse
export const forced = JSON.parse('{}') as any;
