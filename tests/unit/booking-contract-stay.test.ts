import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { parseContractStay } from "@/modules/booking/services/contracts";

describe("parseContractStay", () => {
  it("reads the stay the quoting writes into the estimate description", () => {
    expect(parseContractStay("27/11/26 - 29/11/26 - 40 persones PC")).toEqual({
      startDate: "2026-11-27",
      endDate: "2026-11-29",
      headcount: 40,
      boardType: "FULL_BOARD",
    });
  });

  it("recognises self-catering", () => {
    expect(parseContractStay("01/06/27 - 03/06/27 - 35 persones DC").boardType).toBe(
      "SELF_CATERING",
    );
  });

  it("leaves out whatever the description does not name", () => {
    expect(parseContractStay("27/11/26 - 29/11/26")).toEqual({
      startDate: "2026-11-27",
      endDate: "2026-11-29",
      headcount: null,
      boardType: null,
    });
    expect(parseContractStay(null)).toEqual({
      startDate: null,
      endDate: null,
      headcount: null,
      boardType: null,
    });
  });

  it("ignores dates that do not exist", () => {
    expect(parseContractStay("31/02/27 - 03/03/27").startDate).toBeNull();
  });
});
