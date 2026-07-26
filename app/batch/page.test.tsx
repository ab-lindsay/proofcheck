import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import BatchPage from "@/app/batch/page";
import type { VerifyResponse } from "@/hooks/use-verify";

const VERIFY_RESULT: VerifyResponse = {
  overall: "APPROVED",
  fields: [
    {
      field: "brandName",
      applicationValue: "OLD TOM DISTILLERY",
      labelValue: "OLD TOM DISTILLERY",
      verdict: "COMPLIANT",
      reason: "Matches the application exactly.",
      confidence: 0.95,
    },
  ],
  warnings: [],
  processingMs: 500,
  tier: "mock",
  provider: "mock",
  beverageType: "distilled-spirits",
};

const CSV_HEADER =
  "image_filename,beverage_type,brand_name,class_type,alcohol_content,net_contents,name_and_address,country_of_origin";

function csvFile(name: string, rows: string[]) {
  return new File([[CSV_HEADER, ...rows].join("\n")], name, { type: "text/csv" });
}

function imageFile(name: string) {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

function getCsvInput() {
  return screen.getByLabelText("Applications CSV") as HTMLInputElement;
}

function getImagesInput() {
  return screen.getByLabelText("Label images") as HTMLInputElement;
}

function runButton() {
  // Text swaps to "Verifying…" while running, so match both states.
  return screen.getByRole("button", { name: /Verify batch|Verifying/ });
}

function downloadResultsButton() {
  return screen.getByRole("button", { name: "Download results CSV" });
}

describe("BatchPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("CSV upload populates rows and shows no errors for a valid file", async () => {
    render(<BatchPage />);
    fireEvent.change(getCsvInput(), {
      target: { files: [csvFile("apps.csv", ["a.png,distilled-spirits,OLD TOM,Bourbon,45% Alc./Vol.,750 mL,,"])] },
    });

    await waitFor(() => expect(runButton()).toHaveTextContent("Verify batch (1 labels)"));
    expect(screen.queryByText("CSV problems")).not.toBeInTheDocument();
  });

  it("CSV upload with bad rows surfaces csvErrors", async () => {
    render(<BatchPage />);
    fireEvent.change(getCsvInput(), {
      target: { files: [csvFile("apps.csv", ["a.png,cider,X,Y,,750 mL,,"])] },
    });

    await waitFor(() => expect(screen.getByText("CSV problems")).toBeInTheDocument());
    // Invalid beverage_type -> no valid rows parsed.
    expect(runButton()).toHaveTextContent("Verify batch (0 labels)");
  });

  it("announces CSV errors to screen readers via role=alert, unlike the equivalent single-label error", async () => {
    render(<BatchPage />);
    fireEvent.change(getCsvInput(), {
      target: { files: [csvFile("apps.csv", ["a.png,cider,X,Y,,750 mL,,"])] },
    });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("CSV problems"));
  });

  it("wraps the results table in an aria-live region so batch progress is announced", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => VERIFY_RESULT })) as unknown as typeof fetch;

    render(<BatchPage />);
    fireEvent.change(getCsvInput(), {
      target: { files: [csvFile("apps.csv", ["a.png,distilled-spirits,OLD TOM,Bourbon,45% Alc./Vol.,750 mL,,"])] },
    });
    await waitFor(() => expect(runButton()).toHaveTextContent("Verify batch (1 labels)"));
    fireEvent.change(getImagesInput(), { target: { files: [imageFile("a.png")] } });
    await waitFor(() => expect(runButton()).toBeEnabled());
    fireEvent.click(runButton());

    await waitFor(() => expect(screen.getByText("Results (1)")).toBeInTheDocument());
    expect(screen.getByText("Results (1)").closest('[aria-live="polite"]')).not.toBeNull();
  });

  it("images multi-select populates files (reflected via the unmatched-images memo)", async () => {
    render(<BatchPage />);
    fireEvent.change(getCsvInput(), {
      target: { files: [csvFile("apps.csv", ["a.png,distilled-spirits,OLD TOM,Bourbon,45% Alc./Vol.,750 mL,,"])] },
    });
    await waitFor(() => expect(runButton()).toHaveTextContent("Verify batch (1 labels)"));

    fireEvent.change(getImagesInput(), { target: { files: [imageFile("a.png"), imageFile("stray.png")] } });

    await waitFor(() => expect(screen.getByText(/Images with no CSV row \(skipped\): stray\.png/)).toBeInTheDocument());
    // The matched image ("a.png") must not appear in the unmatched list.
    expect(screen.queryByText(/Images with no CSV row \(skipped\): a\.png/)).not.toBeInTheDocument();
  });

  it("unmatchedImages memo is empty (no warning) when every image matches a CSV row", async () => {
    render(<BatchPage />);
    fireEvent.change(getCsvInput(), {
      target: { files: [csvFile("apps.csv", ["a.png,distilled-spirits,OLD TOM,Bourbon,45% Alc./Vol.,750 mL,,"])] },
    });
    await waitFor(() => expect(runButton()).toHaveTextContent("Verify batch (1 labels)"));
    fireEvent.change(getImagesInput(), { target: { files: [imageFile("a.png")] } });

    await waitFor(() => expect(getImagesInput().files).toHaveLength(1));
    expect(screen.queryByText(/Images with no CSV row/)).not.toBeInTheDocument();
  });

  it("re-uploading the CSV resets files and clears the images file input", async () => {
    render(<BatchPage />);
    fireEvent.change(getCsvInput(), {
      target: { files: [csvFile("apps.csv", ["a.png,distilled-spirits,OLD TOM,Bourbon,45% Alc./Vol.,750 mL,,"])] },
    });
    await waitFor(() => expect(runButton()).toHaveTextContent("Verify batch (1 labels)"));
    fireEvent.change(getImagesInput(), { target: { files: [imageFile("a.png"), imageFile("stray.png")] } });
    await waitFor(() => expect(screen.getByText(/Images with no CSV row/)).toBeInTheDocument());
    expect(runButton()).toBeEnabled();

    fireEvent.change(getCsvInput(), {
      target: { files: [csvFile("apps.csv", ["a.png,distilled-spirits,OLD TOM,Bourbon,45% Alc./Vol.,750 mL,,"])] },
    });

    await waitFor(() => expect(screen.queryByText(/Images with no CSV row/)).not.toBeInTheDocument());
    expect(getImagesInput().value).toBe("");
    // files is now empty -> run button disabled again despite rows being present.
    expect(runButton()).toBeDisabled();
  });

  it("run button is disabled until both rows and files are present, and while running", async () => {
    let resolveFetch!: (v: unknown) => void;
    global.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;

    render(<BatchPage />);
    expect(runButton()).toBeDisabled(); // no rows, no files

    fireEvent.change(getCsvInput(), {
      target: { files: [csvFile("apps.csv", ["a.png,distilled-spirits,OLD TOM,Bourbon,45% Alc./Vol.,750 mL,,"])] },
    });
    await waitFor(() => expect(runButton()).toHaveTextContent("Verify batch (1 labels)"));
    expect(runButton()).toBeDisabled(); // rows present, but no files yet

    fireEvent.change(getImagesInput(), { target: { files: [imageFile("a.png")] } });
    await waitFor(() => expect(getImagesInput().files).toHaveLength(1));
    expect(runButton()).toBeEnabled(); // both rows and files present

    fireEvent.click(runButton());
    await waitFor(() => expect(runButton()).toHaveTextContent("Verifying…"));
    expect(runButton()).toBeDisabled(); // running

    resolveFetch({ ok: true, json: async () => VERIFY_RESULT });
    await waitFor(() => expect(runButton()).toHaveTextContent("Verify batch (1 labels)"));
    expect(runButton()).toBeEnabled(); // running finished, rows/files still present
  });

  it("results-CSV download button is disabled until a run produces items, then enables", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => VERIFY_RESULT })) as unknown as typeof fetch;

    render(<BatchPage />);
    expect(downloadResultsButton()).toBeDisabled(); // no items yet

    fireEvent.change(getCsvInput(), {
      target: { files: [csvFile("apps.csv", ["a.png,distilled-spirits,OLD TOM,Bourbon,45% Alc./Vol.,750 mL,,"])] },
    });
    await waitFor(() => expect(runButton()).toHaveTextContent("Verify batch (1 labels)"));
    fireEvent.change(getImagesInput(), { target: { files: [imageFile("a.png")] } });
    await waitFor(() => expect(runButton()).toBeEnabled());

    fireEvent.click(runButton());
    await waitFor(() => expect(downloadResultsButton()).toBeEnabled());
  });

  it("clicking Download results CSV downloads a blob containing the run's results", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => VERIFY_RESULT })) as unknown as typeof fetch;
    const blobs: Blob[] = [];
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:mock-url";
    });
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<BatchPage />);
    fireEvent.change(getCsvInput(), {
      target: { files: [csvFile("apps.csv", ["a.png,distilled-spirits,OLD TOM,Bourbon,45% Alc./Vol.,750 mL,,"])] },
    });
    await waitFor(() => expect(runButton()).toHaveTextContent("Verify batch (1 labels)"));
    fireEvent.change(getImagesInput(), { target: { files: [imageFile("a.png")] } });
    await waitFor(() => expect(runButton()).toBeEnabled());
    fireEvent.click(runButton());
    await waitFor(() => expect(downloadResultsButton()).toBeEnabled());

    fireEvent.click(downloadResultsButton());

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url");
    expect(blobs).toHaveLength(1);
    const text = await blobs[0].text();
    expect(text).toContain("image_filename,overall,issues,detail");
    expect(text).toContain("a.png,APPROVED,0,");
  });
});
