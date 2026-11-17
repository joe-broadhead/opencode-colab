/**
 * The resources each tool asserts its action on (design §10): reads on `<account>`; changes on `<account>:<operation>`,
 * and runtime-scoped calls also on `<account>:runtime:<id>`, so a person's rule (`deny colab.run on work:runtime:*`)
 * fences. colab_write and colab_delete assert on the plan's `<account>:<operation>` themselves (src/plans/route.ts).
 */
import { accountResource, OPERATIONS, operationResource, runResources, runtimeResource, toolEntry } from "../domain/actions.js"
import type { ToolName } from "../domain/contract.js"
import type { Ledger } from "../ports.js"

type Input = Readonly<Record<string, unknown>>
const text = (value: unknown) => (typeof value === "string" ? value : undefined)

export async function resourcesFor(name: ToolName, input: Input, account: string, ledger: Pick<Ledger, "getRun">): Promise<string[]> {
  if (toolEntry(name).class === "read") return [accountResource(account)]
  const op = (operation: string) => operationResource(account, operation)
  switch (name) {
    case "edit":
      return [op(OPERATIONS.localEdit)]
    case "run":
      return runResources(account, String(input.runtime))
    case "cancel": {
      if (input.job !== undefined) return [op(OPERATIONS.jobOperationsCancel)]
      const runtime = await ledger.getRun(String(input.runId)).then((run) => run?.runtime, () => undefined)
      return runtime ? [op(OPERATIONS.kernelsInterrupt), runtimeResource(account, runtime)] : [op(OPERATIONS.kernelsInterrupt)]
    }
    case "upload":
      return [op(OPERATIONS.contentsSave), runtimeResource(account, String(input.runtime))]
    case "download": {
      const runtime = text(input.runtime)
      if (runtime !== undefined) return [op(OPERATIONS.contentsGet), runtimeResource(account, runtime)]
      return [op(input.drive !== undefined ? OPERATIONS.driveFilesGet : OPERATIONS.storageObjectsGet)]
    }
    case "pause":
      return [op(OPERATIONS.schedulesPause)]
    default:
      throw new Error(`${name} asserts on its plan's resource, not here`)
  }
}
