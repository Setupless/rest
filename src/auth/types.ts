import type { DatabaseResource } from "../database/schema";
import type { RestFilter } from "../query/filter";

export type RestOperation = "select" | "insert" | "update" | "delete";

export interface RestAuthorizationContext {
  readonly request: Request;
  readonly table: string;
  readonly operation: RestOperation;
}

export type AuthorizationDecision =
  | { readonly allowed: false; readonly status?: 401 | 403 }
  | {
      readonly allowed: true;
      readonly using?: RestFilter;
      readonly check?: RestFilter;
    };

export interface RestAuthPlugin {
  authorize(
    context: RestAuthorizationContext,
  ): AuthorizationDecision | Promise<AuthorizationDecision>;
}

export type RestAuthorizationMode = "none" | "api-key" | "programmatic";

/** Inputs resolved once for one request, resource, and operation. */
export interface ResolveAuthorizationOptions {
  readonly request: Request;
  readonly resource: DatabaseResource;
  readonly operation: RestOperation;
  readonly clientFilter?: RestFilter;
}

/** Validated filters for the applicable pre-image and post-image phases. */
export interface ResolvedAuthorization {
  readonly using?: RestFilter;
  readonly check?: RestFilter;
}

/** A request-scoped, fail-closed facade around an authorization plugin. */
export interface RestAuthorizationResolver {
  readonly mode: RestAuthorizationMode;
  resolve(options: ResolveAuthorizationOptions): Promise<ResolvedAuthorization>;
}
