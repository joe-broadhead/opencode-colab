/**
 * The in-memory, single-use plan store (design §6, §7.2; gws's model). A plan is bound to the session, agent and
 * account that created it, to its category, and expires after `planTtlSeconds` (300). It is consumed by exactly one
 * commit attempt; a failed commit does not resurrect it. A used or expired plan stays until its TTL, so a second
 * commit hears that it was used, not that it never existed.
 */
import { randomBytes } from "node:crypto"
import type { PlanCategory } from "./actions.js"
import { ColabError } from "./errors.js"
import type { PlanBinding, PlanStorePort, StoredPlan } from "../ports.js"

const MAX_PLANS = 512

export class PlanStore implements PlanStorePort {
  private readonly plans = new Map<string, StoredPlan>()

  constructor(
    private readonly ttlSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: Omit<StoredPlan, "id" | "state" | "createdAt" | "expiresAt">): StoredPlan {
    this.sweep()
    const now = this.now()
    const plan: StoredPlan = { ...input, id: `plan_${randomBytes(18).toString("base64url")}`, state: "ready", createdAt: now, expiresAt: now + this.ttlSeconds * 1000 }
    this.plans.set(plan.id, plan)
    while (this.plans.size > MAX_PLANS) {
      const oldest = this.plans.keys().next().value
      if (oldest === undefined) break
      const evicted = this.plans.get(oldest)
      if (evicted) this.expire(evicted)
      this.plans.delete(oldest)
    }
    return plan
  }

  get(id: string): StoredPlan | undefined {
    const plan = this.plans.get(id)
    if (plan?.state === "ready" && this.now() >= plan.expiresAt) this.expire(plan)
    return plan
  }

  /** Checks a commit's binding without consuming the plan. */
  check(id: string, binding: PlanBinding & { readonly category: PlanCategory }): StoredPlan {
    const plan = this.get(id)
    if (!plan) throw new ColabError("PLAN_NOT_FOUND")
    if (plan.state === "consumed") throw new ColabError("PLAN_ALREADY_USED", "This plan was already committed.")
    if (plan.state === "committing") throw new ColabError("PLAN_ALREADY_USED", "This plan's commit is running.", { next: "Wait for the running commit to finish; do not commit this plan again." })
    if (plan.state === "expired" || this.now() >= plan.expiresAt) throw new ColabError("PLAN_EXPIRED")
    if (plan.sessionId !== binding.sessionId || plan.agentId !== binding.agentId) throw new ColabError("PLAN_CALLER_MISMATCH")
    if (plan.category !== binding.category) {
      throw new ColabError("CATEGORY_MISMATCH", `This is a ${plan.category} plan.`, { next: `Commit it with colab_${plan.category}, passing only {planId}.` })
    }
    return plan
  }

  /** Checks, then marks the plan committing: no second commit can start. */
  acquire(id: string, binding: PlanBinding & { readonly category: PlanCategory }): StoredPlan {
    const plan = this.check(id, binding)
    plan.state = "committing"
    return plan
  }

  complete(id: string): void {
    const plan = this.plans.get(id)
    if (plan?.state === "committing") plan.state = "consumed"
  }

  /** A failed commit: the plan expires, and a new plan is needed. */
  release(id: string): void {
    const plan = this.plans.get(id)
    if (plan?.state === "committing") this.expire(plan)
  }

  private expire(plan: StoredPlan): void {
    if (plan.state === "ready" || plan.state === "committing") plan.state = "expired"
  }

  private sweep(): void {
    const now = this.now()
    for (const [id, plan] of this.plans) if (now >= plan.expiresAt && plan.state !== "committing") this.plans.delete(id)
  }
}
