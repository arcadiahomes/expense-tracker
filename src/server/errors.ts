/** Thrown for missing records AND for records the actor may not see, so ids don't leak. */
export class NotFoundError extends Error {
  constructor(what = "Record") {
    super(`${what} not found.`);
    this.name = "NotFoundError";
  }
}

/** The actor can see the record but their role doesn't allow this change. */
export class ForbiddenError extends Error {
  constructor(message = "You don't have permission to do that on this site.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Sign in to continue.");
    this.name = "UnauthenticatedError";
  }
}

/** Business-rule failure with optional per-field messages for forms. */
export class ValidationError extends Error {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ValidationError";
  }
}
