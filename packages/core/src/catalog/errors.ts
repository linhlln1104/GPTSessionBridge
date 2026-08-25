export type ModelCatalogErrorCode =
  | "cursor_expired"
  | "cursor_generation_failed"
  | "invalid_configuration"
  | "invalid_cursor"
  | "invalid_limit"
  | "invalid_model"
  | "invalid_model_page"
  | "model_collision";

export class ModelCatalogError extends Error {
  public readonly code: ModelCatalogErrorCode;

  public constructor(code: ModelCatalogErrorCode, message: string) {
    super(message);
    this.name = "ModelCatalogError";
    this.code = code;
  }
}
