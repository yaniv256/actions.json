export interface ActionCall {
  call_id?: string;
  primitive?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface ActionResult {
  type: "action_call_output" | "action_error";
  call_id: string;
  output?: unknown;
  error?: Record<string, unknown>;
  runtime_id?: string;
  from_receipt?: boolean;
}

export interface ProviderRegistrationOptions {
  provider?: string | null;
  providerRevision?: `sha256:${string}` | null;
}

export interface HandlerContext {
  callId: string;
  runtimeId: string;
  resolved: Record<string, unknown>;
}

export class PrimitiveRegistry {
  register(
    name: string,
    handler: (arguments_: Record<string, unknown>, context: HandlerContext) => unknown | Promise<unknown>,
    options?: ProviderRegistrationOptions,
  ): this;
  has(name: string, provider?: string | null): boolean;
  get(name: string, provider?: string | null): ((arguments_: Record<string, unknown>, context: HandlerContext) => unknown) | null;
  names(): string[];
  snapshot(): PrimitiveRegistry;
  readonly frozen: boolean;
  fingerprint(): string;
}

export interface EmbedHostOptions {
  dictionary: CanonicalDictionary;
  hostState: Record<string, unknown> & { host: "embed" };
  registry?: PrimitiveRegistry;
  send: (item: unknown) => unknown | Promise<unknown>;
  callContext?: Record<string, unknown>;
  runtimeId?: string;
  signalManifest?: Array<Record<string, unknown>>;
  ledger?: unknown;
  scope?: Record<string, unknown>;
}

export class EmbedHost {
  constructor(options: EmbedHostOptions);
  readonly registry: PrimitiveRegistry;
  readonly runtimeId: string;
  catalog(): Record<string, unknown> & { advertised: string[] };
  handleActionCall(call: ActionCall): Promise<ActionResult>;
  withScope(scope: Record<string, unknown>): EmbedHost;
  handleItem(item: unknown): Promise<unknown>;
  emitSignal(name: string, payload?: Record<string, unknown>): Record<string, unknown>;
  formatCatalogFor(catalog: unknown, host: string): unknown;
}

export class RealtimeAgentAdapter {
  constructor(options: {
    host: Pick<EmbedHost, "catalog" | "handleActionCall">;
    dictionary: CanonicalDictionary;
    send: (event: unknown) => unknown | Promise<unknown>;
    continueResponse?: boolean;
    onToolEvent?: (event: {
      eventType: "tool.call" | "tool.result";
      outcome: "success" | "failure";
      payload: Record<string, unknown>;
    }) => void;
  });
  tools(): Array<Record<string, unknown> & { type: "function"; name: string }>;
  sessionUpdate(instructions: string): Record<string, unknown>;
  handleEvent(event: unknown): Promise<{ handled: boolean; calls: number }>;
}

export interface CanonicalDictionary {
  version: number;
  stage?: number;
  primitives: Array<Record<string, unknown> & { name: string }>;
}

export const canonicalDictionary: CanonicalDictionary;
export const ReceiptLedger: new (...args: unknown[]) => unknown;
export const DurableReceiptStore: new (...args: unknown[]) => unknown;
export function authorityKey(scope: Record<string, unknown>): string;
export function effectiveHostRevision(installationRevision: string, registry: PrimitiveRegistry): string;
export function requestDigest(request: Record<string, unknown>): string;
export function resolveCapability(input: Record<string, unknown>): Record<string, unknown>;
export function resolveCatalog(input: Record<string, unknown>): Record<string, unknown>;
export const DOCUMENT_KIND: Readonly<Record<string, string>>;
export const LAYER: Readonly<Record<string, string>>;
export const REASON: Readonly<Record<string, string>>;
export const REMEDIATION_FOR_REASON: Readonly<Record<string, string>>;
