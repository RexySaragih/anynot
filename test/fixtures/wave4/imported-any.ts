import { Config as UntypedConfig } from 'untyped-dep';

void UntypedConfig;

/** Local re-export shaped as explicit any because the dep is untyped. */
export type Config = any;
