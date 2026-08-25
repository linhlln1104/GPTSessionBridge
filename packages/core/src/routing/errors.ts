export const THREAD_ROUTING_ERROR_CODE = Object.freeze({
  INVALID_CONFIGURATION: "routing.invalid_configuration",
  INVALID_PARAMS: "routing.invalid_params",
  PENDING_CAPACITY: "routing.pending_capacity",
  PINNED_SELECTION_MISMATCH: "routing.pinned_selection_mismatch",
  PROVIDER_SWITCH: "routing.provider_switch",
  REQUEST_ID_CONFLICT: "routing.request_id_conflict",
  ROUTE_CONFLICT: "routing.route_conflict",
  THREAD_CAPACITY: "routing.thread_capacity",
  THREAD_ROUTE_BLOCKED: "routing.thread_route_blocked",
  THREAD_ROUTE_PENDING: "routing.thread_route_pending",
  THREAD_ROUTE_UNKNOWN: "routing.thread_route_unknown",
  WEB_DERIVED_THREAD_UNSUPPORTED: "routing.web_derived_thread_unsupported",
  WEB_METHOD_UNSUPPORTED: "routing.web_method_unsupported",
  WEB_MODEL_UNAVAILABLE: "routing.web_model_unavailable",
  WEB_REALTIME_UNSUPPORTED: "routing.web_realtime_unsupported",
  WEB_REVIEW_UNSUPPORTED: "routing.web_review_unsupported",
} as const);

export type ThreadRoutingErrorCode =
  (typeof THREAD_ROUTING_ERROR_CODE)[keyof typeof THREAD_ROUTING_ERROR_CODE];

const ERROR_MESSAGES: Readonly<Record<ThreadRoutingErrorCode, string>> = Object.freeze({
  [THREAD_ROUTING_ERROR_CODE.INVALID_CONFIGURATION]: "The routing configuration is invalid.",
  [THREAD_ROUTING_ERROR_CODE.INVALID_PARAMS]: "The routing request parameters are invalid.",
  [THREAD_ROUTING_ERROR_CODE.PENDING_CAPACITY]:
    "The pending routing request capacity has been reached.",
  [THREAD_ROUTING_ERROR_CODE.PINNED_SELECTION_MISMATCH]:
    "The selected model or reasoning effort differs from the thread's pinned selection. Start a new thread to change it.",
  [THREAD_ROUTING_ERROR_CODE.PROVIDER_SWITCH]:
    "The selected model uses a different provider than the thread. Start a new thread to switch providers.",
  [THREAD_ROUTING_ERROR_CODE.REQUEST_ID_CONFLICT]:
    "A pending routing request already uses this identifier and direction.",
  [THREAD_ROUTING_ERROR_CODE.ROUTE_CONFLICT]:
    "The completed thread conflicts with an existing pinned route.",
  [THREAD_ROUTING_ERROR_CODE.THREAD_CAPACITY]: "The pinned thread route capacity has been reached.",
  [THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_BLOCKED]:
    "The thread route was blocked after an upstream identity check failed.",
  [THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_PENDING]:
    "The thread route is awaiting lifecycle identity validation.",
  [THREAD_ROUTING_ERROR_CODE.THREAD_ROUTE_UNKNOWN]:
    "The thread does not have a pinned provider route. Start a new thread to use a Web model.",
  [THREAD_ROUTING_ERROR_CODE.WEB_DERIVED_THREAD_UNSUPPORTED]:
    "Derived threads are not supported for Web-backed threads in this release.",
  [THREAD_ROUTING_ERROR_CODE.WEB_METHOD_UNSUPPORTED]:
    "This operation is not supported for Web-backed threads in this release.",
  [THREAD_ROUTING_ERROR_CODE.WEB_MODEL_UNAVAILABLE]:
    "The selected Web model is not available. Refresh the model catalog and select an available Web model.",
  [THREAD_ROUTING_ERROR_CODE.WEB_REALTIME_UNSUPPORTED]:
    "Realtime sessions are not supported for Web-backed threads in this release.",
  [THREAD_ROUTING_ERROR_CODE.WEB_REVIEW_UNSUPPORTED]:
    "Reviews are not supported for Web-backed threads in this release.",
});

export class ThreadRoutingError extends Error {
  readonly code: ThreadRoutingErrorCode;

  constructor(code: ThreadRoutingErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ThreadRoutingError";
    this.code = code;
  }
}

export function routingError(code: ThreadRoutingErrorCode): ThreadRoutingError {
  return new ThreadRoutingError(code);
}
