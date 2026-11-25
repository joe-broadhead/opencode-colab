/**
 * Invented credentials for tests and fakes. The pieces are separate so no committed file carries a literal credential
 * shape; the runtime value is the same in every test. None of these values is a real credential.
 */
export const invented = (...parts: readonly string[]): string => parts.join("")

/** An invented credential with a separator between its pieces. */
export const inventedWith = (separator: string, ...parts: readonly string[]): string => parts.join(separator)
