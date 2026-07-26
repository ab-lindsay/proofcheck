import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Home from "@/app/page";
import { setDevMode } from "@/hooks/use-dev-mode";

const VERIFY_RESULT = {
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

/** Fakes both fetches the page makes: `/samples/*.png` (loadSample) and `/api/verify` (useVerify). */
function makeFetchMock({ sampleOk = true, sampleStatus = 200 } = {}) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/samples/")) {
      if (!sampleOk) return { ok: false, status: sampleStatus } as Response;
      return {
        ok: true,
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      } as unknown as Response;
    }
    if (url === "/api/verify") {
      return { ok: true, json: async () => VERIFY_RESULT } as unknown as Response;
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

function verifyCalls(fetchMock: ReturnType<typeof makeFetchMock>) {
  return fetchMock.mock.calls.filter(([url]) => url === "/api/verify");
}

describe("Home (single-label verify page)", () => {
  beforeEach(() => {
    // UploadZone creates/revokes an object URL on real file selection; jsdom has neither.
    URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setDevMode(false);
  });

  it("renders a sample button for every non-advanced (brand-named, clean) sample by default", () => {
    global.fetch = makeFetchMock();
    render(<Home />);
    expect(screen.getByRole("button", { name: /Old Tom Distillery/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ridge Creek/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Harbor Point/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Kirkbride Cellars/ })).toBeInTheDocument();
    // "Advanced" samples (named after the defect they demonstrate, e.g. "Title-case warning") read
    // as confusing to a first-time, non-technical user — a usability test confirmed it — so they're
    // hidden from the default gallery and only surface once Dev mode is on.
    expect(screen.queryByRole("button", { name: /Title-case warning/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Bad photo \(glare\)/ })).not.toBeInTheDocument();
  });

  it("reveals the advanced (defect-demonstrating) samples once Dev mode is on", () => {
    setDevMode(true);
    global.fetch = makeFetchMock();
    render(<Home />);
    expect(screen.getByRole("button", { name: /Title-case warning/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Wrong class\/type/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bad photo \(glare\)/ })).toBeInTheDocument();
    // The everyday clean samples stay visible too — Dev mode adds, it doesn't replace.
    expect(screen.getByRole("button", { name: /Old Tom Distillery/ })).toBeInTheDocument();
  });

  it("loadSample success: loads the file, prefills the form (remounted, not merely defaulted), and enables submit", async () => {
    global.fetch = makeFetchMock();
    render(<Home />);

    // Dirty the brand name field first — if the sample only changed `defaultValues` without a `key`
    // bump, react-hook-form would leave this manual edit in place instead of overwriting it.
    fireEvent.change(screen.getByLabelText("Brand name"), { target: { value: "SOMETHING ELSE" } });

    fireEvent.click(screen.getByRole("button", { name: /Old Tom Distillery/ }));

    await waitFor(() => expect(screen.getByLabelText("Brand name")).toHaveValue("OLD TOM DISTILLERY"));
    expect(screen.getByLabelText("Class / type designation")).toHaveValue("Kentucky Straight Bourbon Whiskey");
    expect(screen.getByLabelText("Alcohol content")).toHaveValue("45% Alc./Vol. (90 Proof)");
    expect(screen.getByRole("button", { name: "Verify label" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("loadSample failure: shows sampleError and leaves no file attached", async () => {
    global.fetch = makeFetchMock({ sampleOk: false, sampleStatus: 500 });
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: /Ridge Creek/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to load sample (HTTP 500)."));
    expect(screen.getByRole("button", { name: "Verify label" })).toBeDisabled();
    expect(screen.getByText("Add a label image to enable verification.")).toBeInTheDocument();
  });

  it("onUpload clears a prior verdict and stops treating the request as a sample", async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: /Old Tom Distillery/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Verify label" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    await waitFor(() => expect(screen.getByText("APPROVED")).toBeInTheDocument());

    // Uploading a real file should drop the sample's verdict immediately, before any re-verify.
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array([9, 9, 9])], "my-label.png", { type: "image/png" })] },
    });

    expect(screen.queryByText("APPROVED")).not.toBeInTheDocument();
    expect(screen.getByText(/a plain-English reason for every field will appear here/)).toBeInTheDocument();

    // The form still holds the sample's prefilled values (no formKey bump on upload), so it can be
    // resubmitted as a real upload — proving `isSample` was reset, not just the file.
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    await waitFor(() => expect(verifyCalls(fetchMock)).toHaveLength(2));
    const secondCall = verifyCalls(fetchMock)[1];
    const secondCallBody = secondCall[1]?.body as FormData;
    expect(secondCallBody.get("source")).toBe("upload");
  });

  it("a `real: true` sample (bad photo) verifies as a real upload, never as a mock-tier sample", async () => {
    setDevMode(true); // this sample is `advanced`, hidden from the default gallery
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: /Bad photo \(glare\)/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Verify label" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));

    await waitFor(() => expect(verifyCalls(fetchMock)).toHaveLength(1));
    const body = verifyCalls(fetchMock)[0][1]?.body as FormData;
    // The whole point of this sample is to exercise the LIVE extraction pipeline — flagging it as
    // a sample would route it to the deterministic mock tier and fabricate the result.
    expect(body.get("source")).toBe("upload");
  });

  it("onSubmit calls verify only when a file is attached", async () => {
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;
    render(<Home />);

    // A fully valid application, but no image attached yet.
    fireEvent.change(screen.getByLabelText("Brand name"), { target: { value: "OLD TOM DISTILLERY" } });
    fireEvent.change(screen.getByLabelText("Class / type designation"), {
      target: { value: "Kentucky Straight Bourbon Whiskey" },
    });
    fireEvent.change(screen.getByLabelText("Alcohol content"), { target: { value: "45% Alc./Vol." } });
    fireEvent.change(screen.getByLabelText("Net contents"), { target: { value: "750 mL" } });

    expect(screen.getByRole("button", { name: "Verify label" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    expect(verifyCalls(fetchMock)).toHaveLength(0);

    // Attaching a sample image remounts the form (new button instance) and enables it; submitting
    // now calls verify.
    fireEvent.click(screen.getByRole("button", { name: /Old Tom Distillery/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Verify label" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    await waitFor(() => expect(verifyCalls(fetchMock)).toHaveLength(1));
  });

  it("retry verifies the application data as edited after the failure, not the snapshot that failed", async () => {
    // The form stays mounted and editable in the left column while the error card shows on the
    // right. A retry that replayed the payload captured at first submit would compute a verdict from
    // values the user has already corrected on screen.
    let failNext = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/samples/")) {
        return {
          ok: true,
          blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
        } as unknown as Response;
      }
      if (url === "/api/verify") {
        if (failNext) {
          failNext = false;
          return { ok: false, json: async () => ({ error: "Server error" }) } as unknown as Response;
        }
        return { ok: true, json: async () => VERIFY_RESULT } as unknown as Response;
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: /Old Tom Distillery/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Verify label" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    await waitFor(() => expect(screen.getByText("Verification failed")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Brand name"), { target: { value: "CORRECTED BRAND" } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/verify")).toHaveLength(2));
    const retryBody = fetchMock.mock.calls.filter(([url]) => url === "/api/verify")[1][1]?.body as FormData;
    const sentApp = JSON.parse(retryBody.get("application") as string);
    expect(sentApp.brandName).toBe("CORRECTED BRAND");
  });

  it("gives each verification its own feedback state", async () => {
    // VerdictCard holds per-field feedback in local state. Without a key that changes per run, React
    // keeps the same instance across results and label B inherits marks the user only gave label A.
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: /Old Tom Distillery/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Verify label" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    await waitFor(() => expect(screen.getByText("APPROVED")).toBeInTheDocument());

    const helpful = screen.getAllByRole("button", { name: /^Mark the .+ explanation as helpful$/ })[0];
    fireEvent.click(helpful);
    expect(helpful).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    await waitFor(() => expect(verifyCalls(fetchMock)).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^Mark the .+ explanation as helpful$/ })[0]).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
  });
});
