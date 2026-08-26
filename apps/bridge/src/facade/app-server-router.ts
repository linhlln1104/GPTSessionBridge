import {
  ModelCatalogError,
  type ModelListRequest,
  type NativeModelListContext,
  type VirtualModelCatalog,
} from "@gpt-session-bridge/core/catalog";
import { isReservedWebModelReference } from "@gpt-session-bridge/core";
import {
  ThreadRoutingError,
  WEB_MODEL_PROVIDER_ID,
  serializeDirectionalRequestId,
  type AppServerRequestId,
  type PinnedThreadRoute,
  type ThreadBoundMethod,
  type ThreadLifecycleMethod,
  type ThreadRouter,
} from "@gpt-session-bridge/core/routing";
import {
  appServerNotificationSchema,
  appServerRequestSchema,
  appServerSuccessResponseSchema,
  jsonValueSchema,
  type AppServerEnvelope,
  type AppServerErrorResponse,
  type AppServerNotification,
  type AppServerRequest,
} from "@gpt-session-bridge/protocol";

export type AppServerDispatch =
  | { readonly envelope: AppServerEnvelope; readonly kind: "forward" }
  | { readonly envelope: AppServerEnvelope; readonly kind: "reply" }
  | { readonly kind: "drop" };

export interface AppServerRouterOptions {
  readonly catalog: VirtualModelCatalog;
  readonly maxOwnedRequests?: number;
  readonly onInitializeComplete?: () => void;
  readonly threadRouter: ThreadRouter;
}

type OwnedRequest =
  | { readonly kind: "initialize" }
  | { readonly context: NativeModelListContext; readonly kind: "model-list" }
  | { readonly kind: "passthrough" }
  | { readonly kind: "thread-lifecycle" };

const DEFAULT_MAX_OWNED_REQUESTS = 512;
const CLIENT_REQUEST_DIRECTION = "client-to-server" as const;
const THREAD_LIFECYCLE_METHODS = new Set<ThreadLifecycleMethod>([
  "thread/fork",
  "thread/resume",
  "thread/start",
]);
const THREAD_BOUND_METHODS = new Set<ThreadBoundMethod>(["thread/settings/update", "turn/start"]);
const CONFIG_MUTATION_METHODS = new Set(["config/batchWrite", "config/value/write"]);
const UNSUPPORTED_WEB_METHODS = new Set(["turn/steer"]);
const REQUEST_ONLY_METHODS = new Set(["initialize", "model/list", ...THREAD_LIFECYCLE_METHODS]);
const MAX_ROUTER_SCAN_NODES = 16_384;

export class AppServerRouter {
  readonly #catalog: VirtualModelCatalog;
  readonly #maxOwnedRequests: number;
  readonly #onInitializeComplete: (() => void) | undefined;
  readonly #owned = new Map<string, OwnedRequest>();
  readonly #threadRouter: ThreadRouter;

  public constructor(options: AppServerRouterOptions) {
    const maxOwnedRequests = options.maxOwnedRequests ?? DEFAULT_MAX_OWNED_REQUESTS;
    if (!Number.isSafeInteger(maxOwnedRequests) || maxOwnedRequests < 1) {
      throw new RangeError("Invalid owned request capacity");
    }
    this.#catalog = options.catalog;
    this.#maxOwnedRequests = maxOwnedRequests;
    this.#onInitializeComplete = options.onInitializeComplete;
    this.#threadRouter = options.threadRouter;
  }

  public handleClient(envelope: AppServerEnvelope): AppServerDispatch {
    if (!isRequest(envelope)) {
      if (isNotification(envelope)) {
        return this.#handleClientNotification(envelope);
      }
      if ("id" in envelope) {
        try {
          this.#threadRouter.validateServerRequest();
        } catch {
          return drop();
        }
      }
      return forward(envelope);
    }

    try {
      const key = requestKey(envelope.id);
      if (this.#owned.has(key)) {
        throw new FacadeRoutingError("routing.request_id_conflict");
      }
      if (envelope.method === "initialize") {
        this.#reserveOwned(key, { kind: "initialize" });
        return forward(envelope);
      }
      if (envelope.method === "model/list") {
        return this.#handleModelList(envelope, key);
      }
      if (isThreadLifecycleMethod(envelope.method)) {
        try {
          const prepared = this.#threadRouter.prepareThreadLifecycle({
            direction: CLIENT_REQUEST_DIRECTION,
            id: envelope.id,
            method: envelope.method,
            params: envelope.params,
          });
          this.#reserveOwned(key, { kind: "thread-lifecycle" });
          return forward(withParams(envelope, prepared.params));
        } catch (error) {
          this.#owned.delete(key);
          this.#threadRouter.discardPending(CLIENT_REQUEST_DIRECTION, envelope.id);
          throw error;
        }
      }
      if (isThreadBoundMethod(envelope.method)) {
        const params = this.#threadRouter.validateThreadBound({
          method: envelope.method,
          params: envelope.params,
        });
        this.#reserveOwned(key, { kind: "passthrough" });
        try {
          return forward(withParams(envelope, params));
        } catch (error) {
          this.#owned.delete(key);
          throw error;
        }
      }
      if (envelope.method === "review/start") {
        const params = this.#threadRouter.validateReviewStart(envelope.params);
        this.#reserveOwned(key, { kind: "passthrough" });
        try {
          return forward(withParams(envelope, params));
        } catch (error) {
          this.#owned.delete(key);
          throw error;
        }
      }
      if (envelope.method === "thread/realtime/start") {
        const params = this.#threadRouter.validateRealtimeStart(envelope.params);
        this.#reserveOwned(key, { kind: "passthrough" });
        try {
          return forward(withParams(envelope, params));
        } catch (error) {
          this.#owned.delete(key);
          throw error;
        }
      }
      if (CONFIG_MUTATION_METHODS.has(envelope.method)) {
        assertNoReservedConfigMutation(envelope.params);
      }
      if (UNSUPPORTED_WEB_METHODS.has(envelope.method)) {
        this.#threadRouter.validateUnsupportedWebOperation(envelope.params);
      } else {
        this.#threadRouter.validateThreadIdentity(envelope.params);
      }
      this.#reserveOwned(key, { kind: "passthrough" });
      return forward(envelope);
    } catch (error) {
      return reply(routingFailure(envelope.id, error));
    }
  }

  #handleClientNotification(notification: AppServerNotification): AppServerDispatch {
    try {
      if (REQUEST_ONLY_METHODS.has(notification.method)) {
        return drop();
      }
      if (isThreadBoundMethod(notification.method)) {
        const params = this.#threadRouter.validateThreadBound({
          method: notification.method,
          params: notification.params,
        });
        return forward(withNotificationParams(notification, params));
      }
      if (notification.method === "review/start") {
        const params = this.#threadRouter.validateReviewStart(notification.params);
        return forward(withNotificationParams(notification, params));
      }
      if (notification.method === "thread/realtime/start") {
        const params = this.#threadRouter.validateRealtimeStart(notification.params);
        return forward(withNotificationParams(notification, params));
      }
      if (CONFIG_MUTATION_METHODS.has(notification.method)) {
        assertNoReservedConfigMutation(notification.params);
      }
      if (UNSUPPORTED_WEB_METHODS.has(notification.method)) {
        this.#threadRouter.validateUnsupportedWebOperation(notification.params);
      } else {
        this.#threadRouter.validateThreadIdentity(notification.params);
      }
      return forward(notification);
    } catch {
      return drop();
    }
  }

  public handleServer(envelope: AppServerEnvelope): AppServerDispatch {
    if (isRequest(envelope)) {
      try {
        this.#threadRouter.validateServerRequest();
        return forward(envelope);
      } catch (error) {
        return reply(routingFailure(envelope.id, error));
      }
    }

    if (isResponse(envelope)) {
      let key: string;
      try {
        key = requestKey(envelope.id);
      } catch {
        return forward(envelope);
      }
      const owned = this.#owned.get(key);
      if (owned === undefined) {
        return forward(envelope);
      }
      this.#owned.delete(key);

      try {
        if (owned.kind === "initialize") {
          if ("result" in envelope) {
            this.#onInitializeComplete?.();
          }
          return forward(envelope);
        }
        if (owned.kind === "passthrough") {
          return forward(envelope);
        }
        if (owned.kind === "model-list") {
          if ("error" in envelope) {
            return forward(envelope);
          }
          const result = jsonValueSchema.parse(
            this.#catalog.mergeNativePage(owned.context, envelope.result),
          );
          return forward(appServerSuccessResponseSchema.parse({ ...envelope, result }));
        }

        let settlement;
        try {
          settlement = this.#threadRouter.settleThreadLifecycle({
            requestDirection: CLIENT_REQUEST_DIRECTION,
            response: envelope,
          });
        } catch (error) {
          throw new FacadeIntegrityError(errorCode(error));
        }
        if (settlement.status === "committed") {
          if (settlement.route.kind === "web") {
            const sanitized = sanitizeWebLifecycleResponse(envelope, settlement.route);
            if (this.#threadRouter.containsPrivateProviderMaterial(sanitized)) {
              throw new FacadeIntegrityError("routing.invalid_upstream_result");
            }
            return forward(sanitized);
          }
          return forward(envelope);
        }
        if (settlement.status === "failed") {
          return settlement.route === "web"
            ? forward(internalFailure(envelope.id, "routing.web_lifecycle_failed"))
            : forward(envelope);
        }
        throw new FacadeIntegrityError("routing.invalid_upstream_result");
      } catch (error) {
        if (error instanceof FacadeIntegrityError) {
          throw error;
        }
        return forward(internalFailure(envelope.id, errorCode(error)));
      }
    }

    if (envelope.method === "thread/started") {
      const relation = readStartedThreadRelation(envelope.params);
      if (relation !== undefined) {
        this.#threadRouter.validateThreadRelation(relation);
      }
    }
    const threadId = readNotificationThreadId(envelope.params);
    const route = threadId === undefined ? undefined : this.#threadRouter.getThreadRoute(threadId);
    if (envelope.method === "thread/deleted" && threadId !== undefined) {
      this.#threadRouter.forgetThread(threadId);
    }
    if (route?.kind !== "web" || route.providerModel === null) {
      return forward(envelope);
    }

    let sanitized = sanitizeWebTurnFailureNotification(envelope);
    if (
      envelope.method === "warning" &&
      (containsPrivateRoute(envelope, route.providerModel) ||
        this.#threadRouter.containsPrivateProviderMaterial(envelope))
    ) {
      sanitized = withNotificationParams(envelope, {
        message: "GPTSessionBridge is using compatibility metadata for the selected Web model.",
        threadId,
      });
    }
    if (
      containsPrivateRoute(sanitized, route.providerModel) ||
      this.#threadRouter.containsPrivateProviderMaterial(sanitized)
    ) {
      return drop();
    }
    return forward(sanitized);
  }

  public clearPending(): void {
    this.#owned.clear();
    this.#threadRouter.clearPending();
  }

  #handleModelList(request: AppServerRequest, key: string): AppServerDispatch {
    const modelListRequest = readModelListRequest(request.params);
    const prepared = this.#catalog.prepare(modelListRequest);
    if (prepared.kind === "return-virtual") {
      return reply(
        appServerSuccessResponseSchema.parse({
          id: request.id,
          result: jsonValueSchema.parse(prepared.page),
        }),
      );
    }

    this.#reserveOwned(key, {
      context: prepared.context,
      kind: "model-list",
    });
    if (prepared.upstreamCursor === (modelListRequest.cursor ?? null)) {
      return forward(request);
    }
    const params = isDataRecord(request.params) ? { ...request.params } : {};
    params["cursor"] = prepared.upstreamCursor;
    return forward(withParams(request, params));
  }

  #reserveOwned(key: string, value: OwnedRequest): void {
    if (this.#owned.has(key)) {
      throw new FacadeRoutingError("routing.request_id_conflict");
    }
    if (this.#owned.size >= this.#maxOwnedRequests) {
      throw new FacadeRoutingError("routing.pending_capacity");
    }
    this.#owned.set(key, value);
  }
}

class FacadeRoutingError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "FacadeRoutingError";
    this.code = code;
  }
}

class FacadeIntegrityError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "FacadeIntegrityError";
    this.code = code;
  }
}

function readModelListRequest(value: unknown): ModelListRequest {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isDataRecord(value)) {
    throw new FacadeRoutingError("catalog.invalid_params");
  }

  const cursor = value["cursor"];
  const includeHidden = value["includeHidden"];
  const limit = value["limit"];
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
    throw new FacadeRoutingError("catalog.invalid_cursor");
  }
  if (limit !== undefined && limit !== null && typeof limit !== "number") {
    throw new FacadeRoutingError("catalog.invalid_limit");
  }
  if (includeHidden !== undefined && includeHidden !== null && typeof includeHidden !== "boolean") {
    throw new FacadeRoutingError("catalog.invalid_params");
  }
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(typeof includeHidden === "boolean" ? { includeHidden } : {}),
    ...(limit === undefined || limit === null ? {} : { limit }),
  };
}

function assertNoReservedConfigMutation(value: unknown): void {
  const pending: unknown[] = [value];
  let inspected = 0;
  while (pending.length > 0) {
    inspected += 1;
    if (inspected > MAX_ROUTER_SCAN_NODES) {
      throw new FacadeRoutingError("routing.reserved_configuration");
    }
    const current = pending.pop();
    if (typeof current === "string") {
      if (isReservedConfigurationReference(current)) {
        throw new FacadeRoutingError("routing.reserved_configuration");
      }
      continue;
    }
    if (isUnknownArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isDataRecord(current)) {
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (isReservedConfigurationReference(key)) {
        throw new FacadeRoutingError("routing.reserved_configuration");
      }
      pending.push(nested);
    }
  }
}

function isReservedConfigurationReference(value: string): boolean {
  const canonicalized = value.replace(/\\([\s\S])/gu, "$1");
  return (
    isReservedWebModelReference(canonicalized) ||
    canonicalized.toLowerCase().includes(WEB_MODEL_PROVIDER_ID.toLowerCase())
  );
}

function isRequest(envelope: AppServerEnvelope): envelope is AppServerRequest {
  return "method" in envelope && "id" in envelope;
}

function isNotification(envelope: AppServerEnvelope): envelope is AppServerNotification {
  return "method" in envelope && !("id" in envelope);
}

function isResponse(
  envelope: AppServerEnvelope,
): envelope is Exclude<AppServerEnvelope, AppServerRequest> & { id: AppServerRequestId } {
  return !("method" in envelope) && "id" in envelope;
}

function isThreadLifecycleMethod(method: string): method is ThreadLifecycleMethod {
  return THREAD_LIFECYCLE_METHODS.has(method as ThreadLifecycleMethod);
}

function isThreadBoundMethod(method: string): method is ThreadBoundMethod {
  return THREAD_BOUND_METHODS.has(method as ThreadBoundMethod);
}

function requestKey(id: AppServerRequestId): string {
  return serializeDirectionalRequestId(CLIENT_REQUEST_DIRECTION, id);
}

function withParams(request: AppServerRequest, params: unknown): AppServerRequest {
  const candidate: Record<string, unknown> = { ...request };
  if (params === undefined) {
    Reflect.deleteProperty(candidate, "params");
  } else {
    candidate["params"] = jsonValueSchema.parse(params);
  }
  return appServerRequestSchema.parse(candidate);
}

function withNotificationParams(
  notification: AppServerNotification,
  params: unknown,
): AppServerNotification {
  const candidate: Record<string, unknown> = { ...notification };
  if (params === undefined) {
    Reflect.deleteProperty(candidate, "params");
  } else {
    candidate["params"] = jsonValueSchema.parse(params);
  }
  return appServerNotificationSchema.parse(candidate);
}

function sanitizeWebLifecycleResponse(
  response: AppServerEnvelope,
  route: PinnedThreadRoute,
): AppServerEnvelope {
  if (
    route.kind !== "web" ||
    route.model === null ||
    route.providerModel === null ||
    !("result" in response) ||
    !isDataRecord(response.result) ||
    response.result["model"] !== route.providerModel
  ) {
    throw new FacadeIntegrityError("routing.invalid_upstream_result");
  }

  const result = jsonValueSchema.parse({ ...response.result, model: route.model });
  const sanitized = appServerSuccessResponseSchema.parse({ ...response, result });
  if (containsPrivateRoute(sanitized, route.providerModel)) {
    throw new FacadeIntegrityError("routing.invalid_upstream_result");
  }
  return sanitized;
}

function sanitizeWebTurnFailureNotification(
  notification: AppServerNotification,
): AppServerNotification {
  if (notification.method === "error" && isDataRecord(notification.params)) {
    return withNotificationParams(notification, {
      ...notification.params,
      error: contentFreeWebTurnError(),
    });
  }
  if (notification.method !== "turn/completed" || !isDataRecord(notification.params)) {
    return notification;
  }
  const turn = notification.params["turn"];
  if (!isDataRecord(turn) || turn["status"] !== "failed") {
    return notification;
  }
  return withNotificationParams(notification, {
    ...notification.params,
    turn: {
      ...turn,
      error: contentFreeWebTurnError(),
    },
  });
}

function contentFreeWebTurnError(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    additionalDetails: null,
    codexErrorInfo: "other",
    message: "GPTSessionBridge Web turn failed.",
  });
}

function containsPrivateRoute(value: unknown, providerModel: string): boolean {
  const pending: unknown[] = [value];
  let inspected = 0;
  while (pending.length > 0) {
    inspected += 1;
    if (inspected > MAX_ROUTER_SCAN_NODES) {
      throw new FacadeIntegrityError("routing.invalid_upstream_result");
    }
    const current = pending.pop();
    if (typeof current === "string") {
      if (current.includes(providerModel)) {
        return true;
      }
      continue;
    }
    if (isUnknownArray(current)) {
      pending.push(...current);
      continue;
    }
    if (isDataRecord(current)) {
      for (const [key, nested] of Object.entries(current)) {
        if (key.includes(providerModel)) {
          return true;
        }
        pending.push(nested);
      }
    }
  }
  return false;
}

function routingFailure(id: AppServerRequestId, error: unknown): AppServerErrorResponse {
  const code = errorCode(error);
  const message =
    error instanceof ThreadRoutingError
      ? error.message
      : "GPTSessionBridge rejected the request parameters.";
  return {
    error: {
      code: -32602,
      data: { bridgeCode: code },
      message,
    },
    id,
  };
}

function internalFailure(id: AppServerRequestId, code: string): AppServerErrorResponse {
  return {
    error: {
      code: -32603,
      data: { bridgeCode: code },
      message: "GPTSessionBridge could not validate the upstream response.",
    },
    id,
  };
}

function errorCode(error: unknown): string {
  if (
    error instanceof ThreadRoutingError ||
    error instanceof ModelCatalogError ||
    error instanceof FacadeRoutingError
  ) {
    return error.code;
  }
  return "bridge.internal";
}

function readNotificationThreadId(value: unknown): string | undefined {
  if (!isDataRecord(value)) {
    return undefined;
  }
  if (typeof value["threadId"] === "string") {
    return value["threadId"];
  }
  const thread = value["thread"];
  return isDataRecord(thread) && typeof thread["id"] === "string" ? thread["id"] : undefined;
}

function readStartedThreadRelation(value: unknown):
  | {
      readonly childThreadId: string;
      readonly modelProvider?: string;
      readonly parentThreadId: string;
    }
  | undefined {
  if (!isDataRecord(value) || !isDataRecord(value["thread"])) {
    return undefined;
  }
  const thread = value["thread"];
  const childThreadId = thread["id"];
  const parentThreadId = thread["parentThreadId"] ?? thread["forkedFromId"];
  const modelProvider = thread["modelProvider"];
  if (typeof childThreadId !== "string" || typeof parentThreadId !== "string") {
    return undefined;
  }
  return {
    childThreadId,
    ...(typeof modelProvider === "string" ? { modelProvider } : {}),
    parentThreadId,
  };
}

function isDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function forward(envelope: AppServerEnvelope): AppServerDispatch {
  return Object.freeze({ envelope, kind: "forward" });
}

function reply(envelope: AppServerEnvelope): AppServerDispatch {
  return Object.freeze({ envelope, kind: "reply" });
}

function drop(): AppServerDispatch {
  return Object.freeze({ kind: "drop" });
}
