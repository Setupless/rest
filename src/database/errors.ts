import { SQLiteError } from "bun:sqlite";
import { RestError } from "../http/errors";

/** Maps SQLite availability errors without exposing engine diagnostics. */
export function mapDatabaseAvailabilityError(
  error: unknown,
): RestError<"SLREST502" | "SLREST503"> | undefined {
  if (!(error instanceof SQLiteError)) return undefined;
  if (
    error.code?.startsWith("SQLITE_BUSY") ||
    error.code?.startsWith("SQLITE_LOCKED")
  ) {
    return new RestError("SLREST502", {
      hint: "Retry the request after the indicated delay.",
    });
  }
  return new RestError("SLREST503", {
    hint: "Check the database and contact the operator with the request ID.",
  });
}
