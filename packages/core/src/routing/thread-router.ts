import { isCapabilityToken, type CapabilityToken } from "../security/capability-token.js";
import { isReservedWebModelReference } from "../model-namespace.js";
import { THREAD_ROUTING_ERROR_CODE, routingError } from "./errors.js";
import { ExactVirtualModelRegistry, type VirtualModelRouteDefinition } from "./model-registry.js";

export const WEB_MODEL_PROVIDER_ID = "gptsessionbridge_web";

export type AppServerRequestDirection = "client-to-server" | "server-to-client";
export type AppServerRequestId = number | string;
export type ThreadLifecycleMethod = "thread/fork" | "thread/resume" | "thread/start";
export type ThreadBoundMethod = "thread/settings/update" | "turn/start";
export type ThreadRouteKind = "native" | "web";

export interface PinnedThreadRoute {
  readonly catalogRevision: string | null;
  readonly kind: ThreadRouteKind;
  readonly model: string | null;
  readonly modelProvider: typeof WEB_MODEL_PROVIDER_ID | null;
  readonly providerModel: string | null;
  readonly reasoningEffort: string | null;
}

export interface ThreadRoutingOptions {
  readonly baseUrl: string;
  readonly capabilityToken: CapabilityToken;
  readonly maxPendingRequests?: number;
  readonly maxThreadRoutes?: number;
  readonly models: ExactVirtualModelRegistry | readonly VirtualModelRouteDefinition[];
}

export interface PrepareThreadLifecycleRequest {
  readonly catalogRevision?: string | null;
  readonly direction: AppServerRequestDirection;
  readonly id: AppServerRequestId;
  readonly method: ThreadLifecycleMethod;
  readonly params: unknown;
}

export interface PreparedThreadLifecycleRequest {
  readonly params: unknown;
  readonly requestKey: string;
  readonly route: ThreadRouteKind;
}

export interface SettleThreadLifecycleResponse {
  readonly requestDirection: AppServerRequestDirection;
  readonly response: unknown;
}

export type ThreadLifecycleSettlement =
  | { readonly status: "unknown" }
  | { readonly route: ThreadRouteKind; readonly status: "failed" | "invalid-result" }
  | { readonly route: PinnedThreadRoute; readonly status: "committed" };

export interface ValidateThreadBoundRequest {
  readonly method: ThreadBoundMethod;
  readonly params: unknown;
}

export interface ValidateThreadRelationRequest {
  readonly childThreadId: string;
  readonly modelProvider?: string;
  readonly parentThreadId: string;
}

interface PendingRouteDecision {
  readonly expectedForkSourceThreadId: string | null;
  readonly expectedResumeThreadId: string | null;
  readonly quarantinedThreadId: string | null;
  readonly requiresNewThreadId: boolean;
  readonly requiresForkSourceIdentity: boolean;
  readonly reservesThreadSlot: boolean;
  readonly route: PinnedThreadRoute;
}

interface ProviderConfiguration {
  readonly baseUrl: string;
  readonly capabilityToken: CapabilityToken;
  readonly maxPendingRequests: number;
  readonly maxThreadRoutes: number;
}

const DEFAULT_MAX_PENDING_REQUESTS = 256;
const DEFAULT_MAX_THREAD_ROUTES = 4_096;
const MAX_REQUEST_ID_LENGTH = 256;
const MAX_ROUTING_IDENTIFIER_LENGTH = 1_024;
const MAX_PRIVATE_MATERIAL_SCAN_NODES = 16_384;

const PROVIDER_CONFIG_PREFIX = `model_providers.${WEB_MODEL_PROVIDER_ID}`;
const MODEL_REASONING_EFFORT_CONFIG = "model_reasoning_effort";
const RESPECT_SYSTEM_PROXY_CONFIG = "features.respect_system_proxy";
const PROVIDER_CONFIG = Object.freeze({
  baseUrl: `${PROVIDER_CONFIG_PREFIX}.base_url`,
  bearerToken: `${PROVIDER_CONFIG_PREFIX}.experimental_bearer_token`,
  name: `${PROVIDER_CONFIG_PREFIX}.name`,
  requestMaxRetries: `${PROVIDER_CONFIG_PREFIX}.request_max_retries`,
  requiresOpenAiAuth: `${PROVIDER_CONFIG_PREFIX}.requires_openai_auth`,
  streamMaxRetries: `${PROVIDER_CONFIG_PREFIX}.stream_max_retries`,
  wireApi: `${PROVIDER_CONFIG_PREFIX}.wire_api`,
});

export class ThreadRouter {
  readonly #configuration: ProviderConfiguration;
  readonly #blockedThreads = new Set<string>();
  readonly #models: ExactVirtualModelRegistry;
  readonly #pending = new Map<string, PendingRouteDecision>();
  readonly #provisionalThreads = new Map<string, number>();
  readonly #threads = new Map<string, PinnedThreadRoute>();
  #pendingThreadReservations = 0;
  #routingIntegrityCompromised = false;

  constructor(options: ThreadRoutingOptions) {
    if (!isCapabilityToken(options.capabilityToken)) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
    }
    this.#configuration = Object.freeze({
      baseUrl: validateLoopbackBaseUrl(options.baseUrl),
      capabilityToken: options.capabilityToken,
      maxPendingRequests: readCapacity(options.maxPendingRequests, DEFAULT_MAX_PENDING_REQUESTS),
      maxThreadRoutes: readCapacity(options.maxThreadRoutes, DEFAULT_MAX_THREAD_ROUTES),
    });
    this.#models =
      options.models instanceof ExactVirtualModelRegistry
        ? options.models
        : new ExactVirtualModelRegistry(options.models);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get provisionalThreadCount(): number {
    return this.#provisionalThreads.size;
  }

  get blockedThreadCount(): number {
    return this.#blockedThreads.size;
  }

  get threadCount(): number {
    return this.#threads.size;
  }

  prepareThreadLifecycle(request: PrepareThreadLifecycleRequest): PreparedThreadLifecycleRequest {
    this.#assertRoutingIntegrity();
    const requestKey = serializeDirectionalRequestId(request.direction, request.id);
    if (this.#pending.has(requestKey)) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.REQUEST_ID_CONFLICT);
    }
    if (this.#pending.size >= this.#configuration.maxPendingRequests) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.PENDING_CAPACITY);
    }

    const params = readOptionalDataRecord(request.params);
    assertNoReservedProviderDefinitions(params);
    const sourceThreadId = readOptionalString(params?.["threadId"]);
    if (request.method !== "thread/start" && sourceThreadId === null) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
    }
    const sourceRoute = sourceThreadId === null ? undefined : this.#threads.get(sourceThreadId);
    const identityOverridesThreadId = lifecycleIdentityOverridesThreadId(request.method, params);
    if (!identityOverridesThreadId || sourceRoute?.kind === "web") {
      this.#assertThreadAvailable(sourceThreadId);
    }
    const routingSourceRoute =
      identityOverridesThreadId && sourceRoute?.kind !== "web" ? undefined : sourceRoute;
    const decision = this.#decideLifecycleRoute(
      request.method,
      params,
      routingSourceRoute,
      request.catalogRevision,
    );
    if (decision.kind === "web") {
      assertSupportedWebLifecycleIdentity(request.method, params);
      assertNoAmbiguousWebConfigTables(params);
    }
    const effectiveSourceThreadId =
      identityOverridesThreadId && decision.kind === "native" ? null : sourceThreadId;
    const effectiveSourceRoute = effectiveSourceThreadId === null ? undefined : sourceRoute;
    const reservesThreadSlot =
      request.method === "thread/start" ||
      request.method === "thread/fork" ||
      effectiveSourceThreadId === null ||
      effectiveSourceRoute === undefined;

    if (
      reservesThreadSlot &&
      this.#threads.size + this.#pendingThreadReservations >= this.#configuration.maxThreadRoutes
    ) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.THREAD_CAPACITY);
    }

    const preparedParams =
      decision.kind === "web" ? this.#injectWebRoute(params, decision) : request.params;

    const quarantinedThreadId =
      (request.method === "thread/resume" || request.method === "thread/fork") &&
      effectiveSourceThreadId !== null
        ? effectiveSourceThreadId
        : null;
    this.#pending.set(requestKey, {
      expectedForkSourceThreadId: request.method === "thread/fork" ? effectiveSourceThreadId : null,
      expectedResumeThreadId: request.method === "thread/resume" ? effectiveSourceThreadId : null,
      quarantinedThreadId,
      requiresForkSourceIdentity: request.method === "thread/fork",
      requiresNewThreadId: request.method === "thread/start" || request.method === "thread/fork",
      reservesThreadSlot,
      route: decision,
    });
    this.#quarantineThread(quarantinedThreadId);
    if (reservesThreadSlot) {
      this.#pendingThreadReservations += 1;
    }

    return Object.freeze({
      params: preparedParams,
      requestKey,
      route: decision.kind,
    });
  }

  settleThreadLifecycle(settlement: SettleThreadLifecycleResponse): ThreadLifecycleSettlement {
    const response = readOptionalDataRecord(settlement.response);
    if (response === undefined) {
      return Object.freeze({ status: "unknown" });
    }
    const id = response["id"];
    if (!isRequestId(id)) {
      return Object.freeze({ status: "unknown" });
    }

    const requestKey = serializeDirectionalRequestId(settlement.requestDirection, id);
    const pending = this.#pending.get(requestKey);
    if (pending === undefined) {
      return Object.freeze({ status: "unknown" });
    }

    this.#releasePending(requestKey, pending);
    if (Object.hasOwn(response, "error")) {
      return Object.freeze({ route: pending.route.kind, status: "failed" });
    }

    const unverifiedThreadId = readUnverifiedResponseThreadId(response);
    const threadId = readResponseThreadId(response, pending.route);
    const forkSourceThreadId = readUnverifiedResponseForkSourceThreadId(response);
    const invalidForkRelation =
      pending.requiresForkSourceIdentity &&
      (forkSourceThreadId === null ||
        forkSourceThreadId === threadId ||
        (pending.expectedForkSourceThreadId !== null &&
          forkSourceThreadId !== pending.expectedForkSourceThreadId));
    if (
      threadId === null ||
      (pending.expectedResumeThreadId !== null && threadId !== pending.expectedResumeThreadId) ||
      invalidForkRelation ||
      (pending.requiresNewThreadId && this.#threads.has(threadId))
    ) {
      this.#blockThread(unverifiedThreadId);
      return Object.freeze({ route: pending.route.kind, status: "invalid-result" });
    }

    this.#assertThreadAvailable(threadId);
    if (pending.requiresForkSourceIdentity) {
      this.#assertThreadAvailable(forkSourceThreadId);
    }
    const existing = this.#threads.get(threadId);
    const forkSource =
      pending.requiresForkSourceIdentity && forkSourceThreadId !== null
        ? this.#threads.get(forkSourceThreadId)
        : undefined;
    if (pending.route.kind === "native" && forkSource?.kind === "web") {
      this.#blockThread(threadId);
      return Object.freeze({ route: pending.route.kind, status: "invalid-result" });
    }
    const committedRoute =
      pending.route.kind === "native" && existing?.kind === "native"
        ? existing
        : pending.route.kind === "native" && forkSource?.kind === "native"
          ? forkSource
          : pending.route;
    if (existing !== undefined && !routesEqual(existing, committedRoute)) {
      this.#blockThread(threadId);
      throw routingError(THREAD_ROUTING_ERROR_CODE.ROUTE_CONFLICT);
    }
    if (existing === undefined && this.#threads.size >= this.#configuration.maxThreadRoutes) {
      this.#blockThread(threadId);
      throw routingError(THREAD_ROUTING_ERROR_CODE.THREAD_CAPACITY);
    }

    this.#threads.set(threadId, committedRoute);
    return Object.freeze({ route: committedRoute, status: "committed" });
  }

  validateThreadBound(request: ValidateThreadBoundRequest): unknown {
    this.#assertRoutingIntegrity();
    const params = readOptionalDataRecord(request.params);
    assertNoReservedProviderDefinitions(params);
    const threadId = readOptionalString(params?.["threadId"]);
    this.#assertThreadAvailable(threadId);
    const pinned = threadId === null ? undefined : this.#threads.get(threadId);
    const selectedModel = readOptionalString(params?.["model"]);
    const selectedProvider = readSelectedProvider(params);
    const selectedVirtual = selectedModel === null ? undefined : this.#models.get(selectedModel);
    assertAvailableWebReference(
      params?.["model"],
      selectedVirtual,
      pinned?.kind === "web" ? pinned.providerModel : null,
    );
    const collaboration = readCollaborationSelection(params);
    const collaborationVirtual =
      collaboration.model === null ? undefined : this.#models.get(collaboration.model);
    assertAvailableWebReference(
      collaboration.modelValue,
      collaborationVirtual,
      pinned?.kind === "web" ? pinned.providerModel : null,
    );

    if (pinned === undefined) {
      if (selectedVirtual !== undefined || collaborationVirtual !== undefined) {
        if (threadId === null) {
          throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
        }
        throw routingError(THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_UNKNOWN);
      }
      return request.params;
    }

    if (pinned.kind === "native") {
      if (
        selectedVirtual !== undefined ||
        collaborationVirtual !== undefined ||
        selectedProvider === WEB_MODEL_PROVIDER_ID
      ) {
        throw routingError(THREAD_ROUTING_ERROR_CODE.PROVIDER_SWITCH);
      }
      return request.params;
    }

    if (selectedProvider !== null && selectedProvider !== WEB_MODEL_PROVIDER_ID) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.PROVIDER_SWITCH);
    }
    assertPinnedModelSelection(selectedModel, selectedVirtual, pinned);
    assertPinnedModelSelection(collaboration.model, collaborationVirtual, pinned);

    const selectedEffort = readOptionalString(params?.["effort"]);
    if (
      (selectedEffort !== null && selectedEffort !== pinned.reasoningEffort) ||
      (collaboration.effort !== null && collaboration.effort !== pinned.reasoningEffort)
    ) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.PINNED_SELECTION_MISMATCH);
    }
    if (params === undefined || pinned.providerModel === null) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
    }

    const cloned = cloneDataRecord(params);
    setDataProperty(cloned, "model", pinned.providerModel);
    if (pinned.reasoningEffort !== null) {
      setDataProperty(cloned, "effort", pinned.reasoningEffort);
    }
    pinCollaborationSelection(cloned, pinned);
    return cloned;
  }

  validateReviewStart(paramsValue: unknown): unknown {
    this.#assertRoutingIntegrity();
    const params = readOptionalDataRecord(paramsValue);
    const threadId = readOptionalString(params?.["threadId"]);
    this.#assertThreadAvailable(threadId);
    const pinned = threadId === null ? undefined : this.#threads.get(threadId);
    if (pinned?.kind === "web") {
      throw routingError(THREAD_ROUTING_ERROR_CODE.WEB_REVIEW_UNSUPPORTED);
    }
    return paramsValue;
  }

  validateRealtimeStart(paramsValue: unknown): unknown {
    this.#assertRoutingIntegrity();
    const params = readOptionalDataRecord(paramsValue);
    const threadId = readOptionalString(params?.["threadId"]);
    this.#assertThreadAvailable(threadId);
    const selectedModel = readOptionalString(params?.["model"]);
    const selectedVirtual = selectedModel === null ? undefined : this.#models.get(selectedModel);
    assertAvailableWebReference(params?.["model"], selectedVirtual);
    const pinned = threadId === null ? undefined : this.#threads.get(threadId);
    if (pinned?.kind === "web") {
      throw routingError(THREAD_ROUTING_ERROR_CODE.WEB_REALTIME_UNSUPPORTED);
    }
    if (selectedVirtual !== undefined) {
      if (threadId === null) {
        throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
      }
      if (pinned === undefined) {
        throw routingError(THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_UNKNOWN);
      }
      throw routingError(THREAD_ROUTING_ERROR_CODE.PROVIDER_SWITCH);
    }
    return paramsValue;
  }

  validateThreadIdentity(paramsValue: unknown): unknown {
    this.#assertRoutingIntegrity();
    const params = readOptionalDataRecord(paramsValue);
    this.#assertReferencedThreadsAvailable(params);
    return paramsValue;
  }

  validateUnsupportedWebOperation(paramsValue: unknown): unknown {
    this.validateThreadIdentity(paramsValue);
    const params = readOptionalDataRecord(paramsValue);
    const threadId = readOptionalString(params?.["threadId"]);
    if (threadId !== null && this.#threads.get(threadId)?.kind === "web") {
      throw routingError(THREAD_ROUTING_ERROR_CODE.WEB_METHOD_UNSUPPORTED);
    }
    return paramsValue;
  }

  validateThreadRelation(request: ValidateThreadRelationRequest): boolean {
    this.#assertRoutingIntegrity();
    const parentThreadId = readOptionalString(request.parentThreadId);
    const childThreadId = readOptionalString(request.childThreadId);
    if (parentThreadId === null || childThreadId === null) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
    }
    this.#assertThreadAvailable(parentThreadId);
    this.#assertThreadAvailable(childThreadId);
    const parent = this.#threads.get(parentThreadId);
    if (parent === undefined) {
      return false;
    }
    if (parent.kind === "web" && request.modelProvider !== WEB_MODEL_PROVIDER_ID) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.PROVIDER_SWITCH);
    }
    const existing = this.#threads.get(childThreadId);
    if (existing !== undefined) {
      if (!routesEqual(existing, parent)) {
        throw routingError(THREAD_ROUTING_ERROR_CODE.ROUTE_CONFLICT);
      }
      return true;
    }
    if (parent.kind === "web") {
      throw routingError(THREAD_ROUTING_ERROR_CODE.WEB_DERIVED_THREAD_UNSUPPORTED);
    }
    return false;
  }

  getThreadRoute(threadId: string): PinnedThreadRoute | undefined {
    return this.#threads.get(threadId);
  }

  public containsPrivateProviderMaterial(value: unknown): boolean {
    const pending: unknown[] = [value];
    let inspected = 0;
    while (pending.length > 0) {
      inspected += 1;
      if (inspected > MAX_PRIVATE_MATERIAL_SCAN_NODES) {
        return true;
      }
      const current = pending.pop();
      if (typeof current === "string") {
        if (
          current.includes(this.#configuration.capabilityToken) ||
          current.includes(this.#configuration.baseUrl)
        ) {
          return true;
        }
        continue;
      }
      if (Array.isArray(current)) {
        for (const nested of current as readonly unknown[]) {
          pending.push(nested);
        }
        continue;
      }
      if (!isDataRecord(current)) {
        continue;
      }
      for (const [key, nested] of Object.entries(current)) {
        if (
          key.includes(this.#configuration.capabilityToken) ||
          key.includes(this.#configuration.baseUrl)
        ) {
          return true;
        }
        pending.push(nested);
      }
    }
    return false;
  }

  discardPending(direction: AppServerRequestDirection, id: AppServerRequestId): boolean {
    const requestKey = serializeDirectionalRequestId(direction, id);
    const pending = this.#pending.get(requestKey);
    if (pending === undefined) {
      return false;
    }
    this.#releasePending(requestKey, pending);
    return true;
  }

  clearPending(): number {
    const count = this.#pending.size;
    this.#pending.clear();
    this.#provisionalThreads.clear();
    this.#pendingThreadReservations = 0;
    return count;
  }

  forgetThread(threadId: string): boolean {
    return this.#threads.delete(threadId);
  }

  validateServerRequest(): void {
    this.#assertRoutingIntegrity();
    if (this.#provisionalThreads.size > 0) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_PENDING);
    }
  }

  #decideLifecycleRoute(
    method: ThreadLifecycleMethod,
    params: DataRecord | undefined,
    sourceRoute: PinnedThreadRoute | undefined,
    catalogRevision: string | null | undefined,
  ): PinnedThreadRoute {
    const selectedModel = readLifecycleModel(params);
    const selectedProvider = readSelectedProvider(params);
    const selectedEffort = readLifecycleReasoningEffort(params);
    const selectedVirtual = selectedModel === null ? undefined : this.#models.get(selectedModel);
    assertAvailableWebReference(
      selectedModel,
      selectedVirtual,
      sourceRoute?.kind === "web" ? sourceRoute.providerModel : null,
    );

    if (sourceRoute?.kind === "web") {
      if (selectedProvider !== null && selectedProvider !== WEB_MODEL_PROVIDER_ID) {
        throw routingError(THREAD_ROUTING_ERROR_CODE.PROVIDER_SWITCH);
      }
      assertPinnedModelSelection(selectedModel, selectedVirtual, sourceRoute);
      if (selectedEffort !== null && selectedEffort !== sourceRoute.reasoningEffort) {
        throw routingError(THREAD_ROUTING_ERROR_CODE.PINNED_SELECTION_MISMATCH);
      }
      return sourceRoute;
    }

    if (
      sourceRoute?.kind === "native" &&
      (selectedVirtual !== undefined || selectedProvider === WEB_MODEL_PROVIDER_ID)
    ) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.PROVIDER_SWITCH);
    }

    if (selectedVirtual !== undefined) {
      if (selectedProvider !== null && selectedProvider !== WEB_MODEL_PROVIDER_ID) {
        throw routingError(THREAD_ROUTING_ERROR_CODE.PROVIDER_SWITCH);
      }
      if (method !== "thread/start" && sourceRoute === undefined) {
        throw routingError(THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_UNKNOWN);
      }
      return createWebRoute(selectedVirtual, selectedEffort);
    }
    if (selectedProvider === WEB_MODEL_PROVIDER_ID) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
    }

    return createNativeRoute(
      selectedModel,
      selectedEffort,
      readOptionalCatalogRevision(catalogRevision),
      method,
      sourceRoute,
    );
  }

  #injectWebRoute(params: DataRecord | undefined, route: PinnedThreadRoute): DataRecord {
    if (params === undefined || route.providerModel === null) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
    }

    const cloned = cloneDataRecord(params);
    const originalConfig = cloned["config"];
    if (originalConfig !== undefined && originalConfig !== null && !isDataRecord(originalConfig)) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
    }
    const config =
      originalConfig === undefined || originalConfig === null
        ? createDataRecord()
        : cloneDataRecord(originalConfig);

    removeReservedProviderConfiguration(config);
    setDataProperty(config, "model", route.providerModel);
    setDataProperty(config, "model_provider", WEB_MODEL_PROVIDER_ID);
    setDataProperty(config, RESPECT_SYSTEM_PROXY_CONFIG, false);
    setDataProperty(config, PROVIDER_CONFIG.name, "GPTSessionBridge Web");
    setDataProperty(config, PROVIDER_CONFIG.baseUrl, this.#configuration.baseUrl);
    setDataProperty(config, PROVIDER_CONFIG.bearerToken, this.#configuration.capabilityToken);
    setDataProperty(config, PROVIDER_CONFIG.wireApi, "responses");
    setDataProperty(config, PROVIDER_CONFIG.requiresOpenAiAuth, false);
    setDataProperty(config, PROVIDER_CONFIG.requestMaxRetries, 0);
    setDataProperty(config, PROVIDER_CONFIG.streamMaxRetries, 0);
    if (route.reasoningEffort !== null) {
      setDataProperty(config, MODEL_REASONING_EFFORT_CONFIG, route.reasoningEffort);
    }

    setDataProperty(cloned, "config", config);
    setDataProperty(cloned, "model", route.providerModel);
    setDataProperty(cloned, "modelProvider", WEB_MODEL_PROVIDER_ID);
    setDataProperty(cloned, "allowProviderModelFallback", false);
    return cloned;
  }

  #releasePending(requestKey: string, pending: PendingRouteDecision): void {
    this.#pending.delete(requestKey);
    this.#releaseThreadQuarantine(pending.quarantinedThreadId);
    if (pending.reservesThreadSlot) {
      this.#pendingThreadReservations -= 1;
    }
  }

  #assertRoutingIntegrity(): void {
    if (this.#routingIntegrityCompromised) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_BLOCKED);
    }
  }

  #assertThreadAvailable(threadId: string | null): void {
    if (threadId !== null && this.#blockedThreads.has(threadId)) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_BLOCKED);
    }
    if (threadId !== null && this.#provisionalThreads.has(threadId)) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_PENDING);
    }
  }

  #assertReferencedThreadsAvailable(params: DataRecord | undefined): void {
    if (params === undefined) {
      return;
    }
    for (const key of [
      "ancestorThreadId",
      "beforeThreadId",
      "conversationId",
      "parentThreadId",
      "threadId",
    ]) {
      this.#assertThreadAvailable(readOptionalString(params[key]));
    }
    const threads = params["threads"];
    if (!Array.isArray(threads)) {
      return;
    }
    for (const thread of threads) {
      if (typeof thread === "string") {
        this.#assertThreadAvailable(readOptionalString(thread));
        continue;
      }
      const record = readOptionalDataRecord(thread);
      this.#assertThreadAvailable(readOptionalString(record?.["threadId"] ?? record?.["id"]));
    }
  }

  #blockThread(threadId: string | null): void {
    if (threadId === null || this.#blockedThreads.has(threadId)) {
      return;
    }
    if (this.#blockedThreads.size >= this.#configuration.maxThreadRoutes) {
      this.#routingIntegrityCompromised = true;
      return;
    }
    this.#blockedThreads.add(threadId);
  }

  #quarantineThread(threadId: string | null): void {
    if (threadId === null) {
      return;
    }
    this.#provisionalThreads.set(threadId, (this.#provisionalThreads.get(threadId) ?? 0) + 1);
  }

  #releaseThreadQuarantine(threadId: string | null): void {
    if (threadId === null) {
      return;
    }
    const count = this.#provisionalThreads.get(threadId);
    if (count === undefined || count <= 1) {
      this.#provisionalThreads.delete(threadId);
      return;
    }
    this.#provisionalThreads.set(threadId, count - 1);
  }
}

export function serializeDirectionalRequestId(
  direction: AppServerRequestDirection,
  id: AppServerRequestId,
): string {
  if (!isRequestId(id) || (typeof id === "string" && id.length > MAX_REQUEST_ID_LENGTH)) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
  if (typeof id === "number") {
    const normalized = Object.is(id, -0) ? 0 : id;
    return `${direction}:number:${String(normalized)}`;
  }
  return `${direction}:string:${String(id.length)}:${id}`;
}

function createWebRoute(
  selected: VirtualModelRouteDefinition,
  selectedEffort: string | null,
): PinnedThreadRoute {
  const reasoningEffort = selectedEffort ?? selected.defaultReasoningEffort;
  if (!selected.supportedReasoningEfforts.includes(reasoningEffort)) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
  return Object.freeze({
    catalogRevision: selected.catalogRevision,
    kind: "web",
    model: selected.publicModel,
    modelProvider: WEB_MODEL_PROVIDER_ID,
    providerModel: selected.providerModel,
    reasoningEffort,
  });
}

function readLifecycleReasoningEffort(params: DataRecord | undefined): string | null {
  const directEffort = readOptionalString(params?.["effort"]);
  const config = readOptionalDataRecord(params?.["config"]);
  const configEffort = readOptionalString(config?.[MODEL_REASONING_EFFORT_CONFIG]);
  if (directEffort !== null && configEffort !== null && directEffort !== configEffort) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
  return directEffort ?? configEffort;
}

function createNativeRoute(
  selectedModel: string | null,
  selectedEffort: string | null,
  catalogRevision: string | null,
  method: ThreadLifecycleMethod,
  sourceRoute: PinnedThreadRoute | undefined,
): PinnedThreadRoute {
  if (method !== "thread/start" && sourceRoute?.kind === "native") {
    return sourceRoute;
  }
  return Object.freeze({
    catalogRevision,
    kind: "native",
    model: selectedModel,
    modelProvider: null,
    providerModel: selectedModel,
    reasoningEffort: selectedEffort,
  });
}

function virtualMatchesPinned(
  selected: VirtualModelRouteDefinition,
  pinned: PinnedThreadRoute,
): boolean {
  return (
    pinned.kind === "web" &&
    selected.publicModel === pinned.model &&
    selected.providerModel === pinned.providerModel &&
    selected.catalogRevision === pinned.catalogRevision
  );
}

function routesEqual(left: PinnedThreadRoute, right: PinnedThreadRoute): boolean {
  return (
    left.catalogRevision === right.catalogRevision &&
    left.kind === right.kind &&
    left.model === right.model &&
    left.modelProvider === right.modelProvider &&
    left.providerModel === right.providerModel &&
    left.reasoningEffort === right.reasoningEffort
  );
}

function readCapacity(value: number | undefined, fallback: number): number {
  const capacity = value ?? fallback;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
  }
  return capacity;
}

function validateLoopbackBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
  }

  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.pathname !== "/v1" && url.pathname !== "/v1/")
  ) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION);
  }
  return url.toString().replace(/\/$/u, "");
}

function removeReservedProviderConfiguration(config: DataRecord): void {
  for (const key of Object.keys(config)) {
    if (key === PROVIDER_CONFIG_PREFIX || key.startsWith(`${PROVIDER_CONFIG_PREFIX}.`)) {
      deleteDataProperty(config, key);
    }
  }

  const nestedProviders = config["model_providers"];
  if (isDataRecord(nestedProviders) && Object.hasOwn(nestedProviders, WEB_MODEL_PROVIDER_ID)) {
    const sanitizedProviders = cloneDataRecord(nestedProviders);
    deleteDataProperty(sanitizedProviders, WEB_MODEL_PROVIDER_ID);
    setDataProperty(config, "model_providers", sanitizedProviders);
  }
}

function assertNoReservedProviderDefinitions(params: DataRecord | undefined): void {
  const config = readOptionalDataRecord(params?.["config"]);
  if (config === undefined) {
    return;
  }
  for (const key of Object.keys(config)) {
    if (key === PROVIDER_CONFIG_PREFIX || key.startsWith(`${PROVIDER_CONFIG_PREFIX}.`)) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
    }
  }
  const nestedProviders = config["model_providers"];
  if (isDataRecord(nestedProviders) && Object.hasOwn(nestedProviders, WEB_MODEL_PROVIDER_ID)) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
}

function assertNoAmbiguousWebConfigTables(params: DataRecord | undefined): void {
  const config = readOptionalDataRecord(params?.["config"]);
  if (config === undefined) {
    return;
  }
  for (const key of Object.keys(config)) {
    if (key === "features" || key === "model_providers" || key.startsWith("model_providers.")) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
    }
  }
}

function readSelectedProvider(params: DataRecord | undefined): string | null {
  const direct = readOptionalString(params?.["modelProvider"]);
  const config = readOptionalDataRecord(params?.["config"]);
  const configured = readOptionalString(config?.["model_provider"]);
  if (direct !== null && configured !== null && direct !== configured) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
  return direct ?? configured;
}

function readLifecycleModel(params: DataRecord | undefined): string | null {
  const direct = readOptionalRoutingString(params?.["model"]);
  const config = readOptionalDataRecord(params?.["config"]);
  const configured = readOptionalRoutingString(config?.["model"]);
  if (direct !== null && configured !== null && direct !== configured) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
  return direct ?? configured;
}

function assertSupportedWebLifecycleIdentity(
  method: ThreadLifecycleMethod,
  params: DataRecord | undefined,
): void {
  if (params === undefined) {
    return;
  }
  if (method === "thread/resume" && params["history"] !== undefined && params["history"] !== null) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
  const path = params["path"];
  if (
    (method === "thread/resume" || method === "thread/fork") &&
    path !== undefined &&
    path !== null &&
    path !== ""
  ) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
}

function lifecycleIdentityOverridesThreadId(
  method: ThreadLifecycleMethod,
  params: DataRecord | undefined,
): boolean {
  if (
    method === "thread/resume" &&
    params?.["history"] !== undefined &&
    params["history"] !== null
  ) {
    return true;
  }
  const path = params?.["path"];
  return (
    (method === "thread/resume" || method === "thread/fork") &&
    typeof path === "string" &&
    path.length > 0
  );
}

function readResponseThreadId(response: DataRecord, route: PinnedThreadRoute): string | null {
  const result = readOptionalDataRecord(response["result"]);
  const thread = readOptionalDataRecord(result?.["thread"]);
  const threadId = readOptionalString(thread?.["id"]);
  if (threadId === null) {
    return null;
  }
  if (route.kind === "web") {
    if (
      result?.["model"] !== route.providerModel ||
      result["modelProvider"] !== WEB_MODEL_PROVIDER_ID ||
      result["reasoningEffort"] !== route.reasoningEffort ||
      thread?.["modelProvider"] !== WEB_MODEL_PROVIDER_ID
    ) {
      return null;
    }
  } else {
    const model = readOptionalString(result?.["model"]);
    const modelProvider = readOptionalString(result?.["modelProvider"]);
    const threadModelProvider = readOptionalString(thread?.["modelProvider"]);
    if (
      model === null ||
      modelProvider === null ||
      threadModelProvider === null ||
      modelProvider !== threadModelProvider ||
      modelProvider === WEB_MODEL_PROVIDER_ID ||
      isReservedWebModelReference(model)
    ) {
      return null;
    }
  }
  return threadId;
}

function readUnverifiedResponseThreadId(response: DataRecord): string | null {
  const result = readOptionalDataRecord(response["result"]);
  const thread = readOptionalDataRecord(result?.["thread"]);
  return readOptionalString(thread?.["id"]);
}

function readUnverifiedResponseForkSourceThreadId(response: DataRecord): string | null {
  const result = readOptionalDataRecord(response["result"]);
  const thread = readOptionalDataRecord(result?.["thread"]);
  return readOptionalString(thread?.["forkedFromId"]);
}

function readOptionalRoutingString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = readOptionalString(value);
  if (parsed === null) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
  return parsed;
}

interface CollaborationSelection {
  readonly effort: string | null;
  readonly model: string | null;
  readonly modelValue: unknown;
  readonly present: boolean;
}

function readCollaborationSelection(params: DataRecord | undefined): CollaborationSelection {
  const value = params?.["collaborationMode"];
  if (value === undefined || value === null) {
    return Object.freeze({ effort: null, model: null, modelValue: undefined, present: false });
  }
  const collaboration = readOptionalDataRecord(value);
  const settings = readOptionalDataRecord(collaboration?.["settings"]);
  if (collaboration === undefined || settings === undefined) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
  return Object.freeze({
    effort: readOptionalRoutingString(settings["reasoning_effort"]),
    model: readOptionalRoutingString(settings["model"]),
    modelValue: settings["model"],
    present: true,
  });
}

function pinCollaborationSelection(params: DataRecord, route: PinnedThreadRoute): void {
  const collaboration = readOptionalDataRecord(params["collaborationMode"]);
  if (collaboration === undefined || route.providerModel === null) {
    return;
  }
  const settings = readOptionalDataRecord(collaboration["settings"]);
  if (settings === undefined) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
  setDataProperty(settings, "model", route.providerModel);
  if (route.reasoningEffort !== null) {
    setDataProperty(settings, "reasoning_effort", route.reasoningEffort);
  }
}

function assertAvailableWebReference(
  modelValue: unknown,
  selected: VirtualModelRouteDefinition | undefined,
  permittedProviderModel: string | null = null,
): void {
  if (
    selected === undefined &&
    modelValue !== permittedProviderModel &&
    isReservedWebModelReference(modelValue)
  ) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.WEB_MODEL_UNAVAILABLE);
  }
}

function assertPinnedModelSelection(
  selectedModel: string | null,
  selectedVirtual: VirtualModelRouteDefinition | undefined,
  pinned: PinnedThreadRoute,
): void {
  if (selectedModel === null || selectedModel === pinned.providerModel) {
    return;
  }
  if (selectedVirtual === undefined) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.PROVIDER_SWITCH);
  }
  if (!virtualMatchesPinned(selectedVirtual, pinned)) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.PINNED_SELECTION_MISMATCH);
  }
}

function readOptionalCatalogRevision(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value.length < 1) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
  return value;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ROUTING_IDENTIFIER_LENGTH
    ? value
    : null;
}

function isRequestId(value: unknown): value is AppServerRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

type DataRecord = Record<string, unknown>;

function readOptionalDataRecord(value: unknown): DataRecord | undefined {
  return isDataRecord(value) ? value : undefined;
}

function isDataRecord(value: unknown): value is DataRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createDataRecord(): DataRecord {
  return {};
}

function cloneDataRecord(value: DataRecord): DataRecord {
  return cloneDataValue(value, new WeakSet<object>()) as DataRecord;
}

function cloneDataValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }

  if (typeof value !== "object") {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
  if (ancestors.has(value)) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => cloneDataValue(item, ancestors));
    }
    if (!isDataRecord(value)) {
      throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
    }

    const cloned = createDataRecord();
    for (const [key, item] of Object.entries(value)) {
      setDataProperty(cloned, key, cloneDataValue(item, ancestors));
    }
    return cloned;
  } finally {
    ancestors.delete(value);
  }
}

function setDataProperty(record: DataRecord, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function deleteDataProperty(record: DataRecord, key: string): void {
  if (!Reflect.deleteProperty(record, key)) {
    throw routingError(THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS);
  }
}
