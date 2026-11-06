export class ReconciliationError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "state_changed"
      | "proposal_changed"
      | "movement_ineligible"
      | "amount_mismatch"
      | "movement_already_used",
  ) {
    super(code);
    this.name = "ReconciliationError";
  }
}
import "server-only";
