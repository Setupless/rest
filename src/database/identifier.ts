/** Applies SQLite's ASCII-only case folding to a resolved identifier. */
export function foldSQLiteIdentifier(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32),
  );
}
