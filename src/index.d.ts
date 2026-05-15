// pi-frontier — minimal hand-written types.

export interface Modalities {
  input: string[];
  output: string[];
}

export interface FrontierModel {
  provider: string;
  providerClass: string;
  family: string;
  model_key: string;
  version: string | null;
  tier: string;
  release_date: string | null;
  last_updated: string | null;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  /** USD per token. Multiply by 1e6 for $/1M. */
  input_cost: number | null;
  /** USD per token. */
  output_cost: number | null;
  reasoning: boolean;
  tool_call: boolean;
  attachment: boolean;
  modalities: Modalities;
  open_weights: boolean;
  knowledge: string | null;
}

export interface Route {
  provider: string;
  /** Fully qualified key, e.g. "openrouter/z-ai/glm-5-turbo". */
  model_key: string;
  /** Raw id at the reseller, e.g. "z-ai/glm-5-turbo". */
  model_id: string;
  /** USD per 1M tokens. */
  input_cost: number | null;
  /** USD per 1M tokens. */
  output_cost: number | null;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
}

export interface RoutesByModel {
  [modelKey: string]: { frontier: FrontierModel; routes: Route[] };
}

export interface RoutesDocument {
  generated: string;
  models: RoutesByModel;
}

export interface CapabilityFilter {
  reasoning?: boolean;
  tools?: boolean;
  attachment?: boolean;
  vision?: boolean;
  audio?: boolean;
  openWeights?: boolean;
  minContext?: number;
  /** USD per 1M tokens. */
  maxInputCost?: number;
  /** USD per 1M tokens. */
  maxOutputCost?: number;
}

export function getFrontierModels(): FrontierModel[];
export function getRoutes(): RoutesDocument;
export function getGeneratedAt(): string;
export function findRoutes(name: string): Array<{ frontier: FrontierModel; routes: Route[] }>;
export function cheapestRoute(name: string): Route | null;
export function findModel(name: string): FrontierModel[];
export function filterCapability(f?: CapabilityFilter): FrontierModel[];

// kernel re-exports
export function lastSegment(modelId: string): string;
export function loadFrontier(): FrontierModel[];
export function loadRaw(): Record<string, unknown>;
export function buildRouteIndex(raw: Record<string, unknown>): Map<string, Route[]>;
export function routesForFrontier(frontier: FrontierModel, routeIndex: Map<string, Route[]>): Route[];
export function matchFrontier(frontier: FrontierModel[], pattern: string | null): FrontierModel[];
