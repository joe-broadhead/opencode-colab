# Architecture

`src/index.ts` loads the standalone entry in `src/editing/`. It registers exactly three native tools, two read-only tools RPC methods, the status command and RPC, access rules and the two local notebook skills. The explicit local contracts do not resolve Google accounts or accept cloud references. Local notebook code handles nbformat, path validation, permissions and atomic edits. The shipped entry never constructs any provider port, even a stub.

`dist/index.js` and `dist/tui.js` are independent bundles. The first contains local workspace operations and the tools RPC transport. The second presents local status. Neither imports provider implementations. Build and pack tests enforce the graph and package shape.

The [full design](v1-design.md) documents the latent full plugin. Provider, execution and source implementations are retained for isolated unit tests but are not reachable from the package entry. A future full build would need a new surface review and live evidence.
