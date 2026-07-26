import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BatchTable } from "@/components/batch-table";
import type { BatchItem } from "@/lib/csv";
import type { VerifyResponse } from "@/hooks/use-verify";

afterEach(cleanup);

const baseResult: Omit<VerifyResponse, "overall" | "fields"> = {
  warnings: [],
  processingMs: 500,
  tier: "mock",
  provider: "mock",
  beverageType: "distilled-spirits",
};

function passResult(): VerifyResponse {
  return {
    ...baseResult,
    overall: "APPROVED",
    fields: [
      {
        field: "brandName",
        applicationValue: "X",
        labelValue: "X",
        verdict: "COMPLIANT",
        reason: "Matches the application exactly.",
        confidence: 0.95,
      },
    ],
  };
}

function reviewResult(): VerifyResponse {
  return {
    ...baseResult,
    // A NEEDS_CORRECTION field now implies a NEEDS_CORRECTION overall; APPROVED here would be an
    // unreachable state.
    overall: "NEEDS_CORRECTION",
    fields: [
      {
        field: "healthWarningStatement",
        applicationValue: "GOVERNMENT WARNING: ...",
        labelValue: null,
        verdict: "NEEDS_CORRECTION",
        reason: "No health warning statement found on the label — verify by eye.",
        confidence: 0.35,
      },
    ],
  };
}

function failResult(): VerifyResponse {
  return {
    ...baseResult,
    overall: "REJECTED",
    fields: [
      {
        field: "netContents",
        applicationValue: "750 mL",
        labelValue: "700 mL",
        verdict: "NON_COMPLIANT",
        reason: "Does not match the application.",
        confidence: 0.92,
      },
    ],
  };
}

function tableRowFilenames() {
  const rows = screen.getAllByRole("row").slice(1); // drop header row
  return rows.map((r) => within(r).getAllByRole("cell")[0].textContent);
}

describe("StatusPill (via BatchTable rows)", () => {
  it("renders each status distinctly: queued, running, done/APPROVED, done/REJECTED, error", () => {
    const items: BatchItem[] = [
      { filename: "queued.png", status: "queued" },
      { filename: "running.png", status: "running" },
      { filename: "pass.png", status: "done", result: passResult() },
      { filename: "fail.png", status: "done", result: failResult() },
      { filename: "error.png", status: "error", error: "extraction failed" },
    ];
    render(<BatchTable items={items} />);

    expect(screen.getByText("queued")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("APPROVED")).toBeInTheDocument();
    expect(screen.getByText("REJECTED")).toBeInTheDocument();
    expect(screen.getByText("ERROR")).toBeInTheDocument();
    expect(screen.getByText("extraction failed")).toBeInTheDocument();
  });
});

describe("BatchTable sort-by-problems toggle (rank ordering)", () => {
  it("sorts error, then REJECTED, then NEEDS_CORRECTION-containing, then the rest first by default", () => {
    // Deliberately out-of-rank order in the items prop.
    const items: BatchItem[] = [
      { filename: "1-pass.png", status: "done", result: passResult() },
      { filename: "2-review.png", status: "done", result: reviewResult() },
      { filename: "3-fail.png", status: "done", result: failResult() },
      { filename: "4-error.png", status: "error", error: "boom" },
      { filename: "5-queued.png", status: "queued" },
    ];
    render(<BatchTable items={items} />);

    // "Show problems first" is checked by default.
    expect(screen.getByRole("checkbox", { name: /show problems first/i })).toBeChecked();
    expect(tableRowFilenames()).toEqual(["4-error.png", "3-fail.png", "2-review.png", "1-pass.png", "5-queued.png"]);
  });

  it("reverts to the original prop order when unchecked", () => {
    const items: BatchItem[] = [
      { filename: "1-pass.png", status: "done", result: passResult() },
      { filename: "2-review.png", status: "done", result: reviewResult() },
      { filename: "3-fail.png", status: "done", result: failResult() },
      { filename: "4-error.png", status: "error", error: "boom" },
    ];
    render(<BatchTable items={items} />);

    const checkbox = screen.getByRole("checkbox", { name: /show problems first/i });
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(tableRowFilenames()).toEqual(["1-pass.png", "2-review.png", "3-fail.png", "4-error.png"]);
  });
});

describe("BatchTable row expand/collapse", () => {
  it("toggles aria-expanded and reveals/hides the VerdictCard detail on click", () => {
    const items: BatchItem[] = [{ filename: "fail.png", status: "done", result: failResult() }];
    render(<BatchTable items={items} />);

    const toggle = screen.getByRole("button", { name: /view details for fail\.png \(1 issue\)/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const detailsId = toggle.getAttribute("aria-controls");
    expect(detailsId).toBeTruthy();
    expect(screen.queryByText("Does not match the application.")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    const hideButton = screen.getByRole("button", { name: /hide details/i });
    expect(hideButton).toHaveAttribute("aria-expanded", "true");
    expect(hideButton.getAttribute("aria-controls")).toBe(detailsId);
    expect(screen.getByText("Does not match the application.")).toBeInTheDocument();

    fireEvent.click(hideButton);
    expect(screen.getByRole("button", { name: /view details for fail\.png \(1 issue\)/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("Does not match the application.")).not.toBeInTheDocument();
  });

  it("keeps only one row open at a time (single openRow state)", () => {
    const items: BatchItem[] = [
      { filename: "fail.png", status: "done", result: failResult() },
      { filename: "review.png", status: "done", result: reviewResult() },
    ];
    render(<BatchTable items={items} />);

    const rows = screen.getAllByRole("row").slice(1);
    const [failRow, reviewRow] = rows;

    fireEvent.click(within(failRow).getByRole("button", { name: /view details/i }));
    expect(within(failRow).getByRole("button", { name: /hide details/i })).toBeInTheDocument();

    // Opening the second row's details closes the first.
    fireEvent.click(within(reviewRow).getByRole("button", { name: /view details/i }));
    expect(within(reviewRow).getByRole("button", { name: /hide details/i })).toBeInTheDocument();
    expect(within(failRow).getByRole("button", { name: /view details/i })).toBeInTheDocument();
    expect(within(failRow).queryByRole("button", { name: /hide details/i })).not.toBeInTheDocument();
  });

  it("shows nothing to expand for rows without a done result (error row)", () => {
    const items: BatchItem[] = [{ filename: "error.png", status: "error", error: "extraction failed" }];
    render(<BatchTable items={items} />);
    expect(screen.queryByRole("button", { name: /view details/i })).not.toBeInTheDocument();
    expect(screen.getByText("extraction failed")).toBeInTheDocument();
  });
});

describe("BatchTable issue-count grammar", () => {
  it("uses singular 'issue' for exactly one problem, plural for zero or more than one", () => {
    const twoIssues = failResult();
    twoIssues.fields.push({ ...twoIssues.fields[0], field: "brandName" });
    const items: BatchItem[] = [
      { filename: "one.png", status: "done", result: failResult() },
      { filename: "two.png", status: "done", result: twoIssues },
      { filename: "zero.png", status: "done", result: passResult() },
    ];
    render(<BatchTable items={items} />);

    expect(screen.getByRole("button", { name: /view details for one\.png \(1 issue\)/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /view details for two\.png \(2 issues\)/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /view details for zero\.png \(0 issues\)/i })).toBeInTheDocument();
  });
});

describe("BatchTable rank() edge cases", () => {
  it("does not throw when a done item has no result", () => {
    const items: BatchItem[] = [{ filename: "empty-done.png", status: "done" }];
    expect(() => render(<BatchTable items={items} />)).not.toThrow();
    expect(screen.getByText("empty-done.png")).toBeInTheDocument();
  });
});

describe("BatchTable accessibility", () => {
  // Queried by ROLE, not by label text. An aria-label on a bare <span> (implicit role=generic) is
  // prohibited by ARIA and dropped by several browser/AT pairings, but getByLabelText reads the DOM
  // attribute and would pass anyway — the assertion has to prove the pill exposes an accessible
  // name through a role that permits one.
  it("exposes the done pill as a named image role", () => {
    const items: BatchItem[] = [
      {
        filename: "test-label.png",
        status: "done",
        result: {
          ...baseResult,
          overall: "APPROVED",
          fields: [],
        },
      },
    ];
    render(<BatchTable items={items} />);
    expect(screen.getByRole("img", { name: "Result for test-label.png: APPROVED" })).toBeInTheDocument();
  });

  it("exposes the error pill as a named image role", () => {
    const items: BatchItem[] = [
      {
        filename: "bad-label.png",
        status: "error",
        error: "File not found",
      },
    ];
    render(<BatchTable items={items} />);
    expect(screen.getByRole("img", { name: "Error for bad-label.png: File not found" })).toBeInTheDocument();
  });

  it("names a done item with no result 'unknown' rather than announcing undefined", () => {
    // BatchItem.result is optional, so a done row without one is representable. It previously
    // rendered an empty pill labelled "Result for x.png: undefined".
    const items: BatchItem[] = [{ filename: "resultless.png", status: "done" }];
    render(<BatchTable items={items} />);
    expect(screen.getByRole("img", { name: "Result for resultless.png: unknown" })).toBeInTheDocument();
  });
});

describe("BatchTable label image viewer", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  });
  afterEach(() => vi.restoreAllMocks());

  it("threads the matching file into the expanded row's VerdictCard", () => {
    const items: BatchItem[] = [{ filename: "a.png", status: "done", result: passResult() }];
    const files = new Map([["a.png", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" })]]);
    render(<BatchTable items={items} files={files} />);
    fireEvent.click(screen.getByRole("button", { name: /view details/i }));
    expect(screen.getByRole("button", { name: "View label image" })).toBeInTheDocument();
  });

  it("shows no viewer trigger when files is omitted", () => {
    const items: BatchItem[] = [{ filename: "a.png", status: "done", result: passResult() }];
    render(<BatchTable items={items} />);
    fireEvent.click(screen.getByRole("button", { name: /view details/i }));
    expect(screen.queryByRole("button", { name: "View label image" })).not.toBeInTheDocument();
  });
});
