export const annotated: any = 1;

export function returnsAny(): any {
  return 1;
}

export function paramAny(payload: any) {
  return payload;
}

export const asserted = (0 as any);
export const angleAsserted = <any>0;

export const anyArray: any[] = [];
export const promiseAny: Promise<any> = Promise.resolve(1);
export const recordAny: Record<string, any> = {};

export function restAny(...args: any[]) {
  return args;
}

export let propertyHolder: { value: any } = { value: 1 };
