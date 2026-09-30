/**
 * An error whose message is safe and useful to show to the Discord user
 * (validation failures, permission denials, stale state). Anything else is
 * treated as an internal error and only logged.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

export class PermissionDeniedError extends UserError {
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class NotFoundError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
