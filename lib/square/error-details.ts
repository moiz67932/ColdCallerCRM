export type SquareErrorDetail = {
  category?: string;
  code?: string;
  detail?: string;
  field?: string;
};

export function extractSquareErrors(errorBody: unknown): SquareErrorDetail[] {
  if (!isRecord(errorBody)) return [];
  const errors = errorBody.errors;

  if (!Array.isArray(errors)) return [];

  return errors.flatMap((error) => {
    if (!isRecord(error)) return [];

    return {
      category: stringOrUndefined(error.category),
      code: stringOrUndefined(error.code),
      detail: stringOrUndefined(error.detail),
      field: stringOrUndefined(error.field),
    };
  });
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
