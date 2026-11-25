/**
 * The one seam between this package and OpenCode's integration directory.
 *
 * `createDeps` builds the `Auth` port before the plugin's `setup` has a host context, and the host owns the credential
 * store; so the port reaches the host through a bridge keyed by the exact `Options` object both calls were given
 * (`plugin.ts` passes the same object to `createDeps` and `registerAuth`). A second plugin instance in one process gets
 * its own key, and disposing one registration does not detach another.
 *
 * The types are structural twins of `@opencode/plugin`'s integration connection API, so this module imports no host
 * package and is testable with a fake.
 */
import { ColabError } from "../../domain/errors.js"

/** OpenCode's `ConnectionInfo`, reduced to what auth reads. */
export interface HostConnection {
  readonly id?: string
  readonly type?: string
  readonly [key: string]: unknown
}

/** OpenCode's `Credential.Value`, reduced to an OAuth credential. */
export interface HostCredential {
  readonly type: string
  readonly methodID?: string
  readonly refresh?: string
  readonly access?: string
  readonly expires?: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface AuthHost {
  readonly active: (integrationID: string) => Promise<HostConnection | undefined>
  readonly resolve: (connection: HostConnection) => Promise<HostCredential | undefined>
  /** Marks the connection as needing a sign-in, so the host shows it natively; best effort. */
  readonly report?: (integrationID: string, connection: HostConnection, message: string) => Promise<void>
}

const bridges = new WeakMap<object, AuthHost>()

/** Attach the host's credential store to one plugin instance's options; returns the dispose that detaches it. */
export function attachHost(options: object, host: AuthHost): () => void {
  bridges.set(options, host)
  return () => {
    if (bridges.get(options) === host) bridges.delete(options)
  }
}

export function hostFor(options: object): AuthHost | undefined {
  return bridges.get(options)
}

/** The OAuth credential of one integration id, or undefined when there is no active connection or it is not OAuth. */
export async function activeCredential(host: AuthHost, integrationID: string): Promise<{ connection: HostConnection; credential: HostCredential } | undefined> {
  let connection: HostConnection | undefined
  try {
    connection = await host.active(integrationID)
  } catch {
    return undefined
  }
  if (!connection) return undefined
  let credential: HostCredential | undefined
  try {
    credential = await host.resolve(connection)
  } catch {
    await reportNeedsSignIn(host, integrationID, connection, "OpenCode could not read the stored Google credential.")
    return undefined
  }
  if (!credential || credential.type !== "oauth" || !credential.access) return undefined
  return { connection, credential }
}

export async function reportNeedsSignIn(host: AuthHost, integrationID: string, connection: HostConnection, message: string): Promise<void> {
  if (!host.report) return
  try {
    await host.report(integrationID, connection, message)
  } catch {
    // Reporting is best effort; it must never change the call's result.
  }
}

/** A ColabError for a sign-in that is missing or expired, in the one family form. */
export function signInRequired(alias: string, name: string, reason?: string): ColabError {
  return new ColabError("AUTH_REQUIRED", `No usable Google sign-in for ${alias}.`, {
    ...(reason !== undefined ? { reason } : {}),
    next: `Run /connect and choose ${name}, or opencode auth login ${alias === "default" ? "colab" : `colab-${alias}`}.`,
  })
}
