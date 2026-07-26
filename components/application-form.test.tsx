import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApplicationForm } from "@/components/application-form";

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("ApplicationForm", () => {
  it("blocks submit and shows an error when brand name is empty", async () => {
    const onSubmit = vi.fn();
    render(<ApplicationForm onSubmit={onSubmit} busy={false} fileAttached={true} />);
    fill("Class / type designation", "Vodka");
    fill("Alcohol content", "40% Alc./Vol.");
    fill("Net contents", "750 mL");
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    await waitFor(() => expect(screen.getByText(/brand name is required/i)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("requires alcohol content for distilled spirits", async () => {
    const onSubmit = vi.fn();
    render(<ApplicationForm onSubmit={onSubmit} busy={false} fileAttached={true} />);
    fill("Brand name", "X");
    fill("Class / type designation", "Vodka");
    fill("Net contents", "750 mL");
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    await waitFor(() => expect(screen.getByText(/required for this beverage type/i)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("allows omitting alcohol content for malt beverages", async () => {
    const onSubmit = vi.fn();
    render(<ApplicationForm onSubmit={onSubmit} busy={false} fileAttached={true} />);
    fireEvent.change(screen.getByLabelText("Beverage type"), { target: { value: "malt-beverage" } });
    fill("Brand name", "HARBOR POINT");
    fill("Class / type designation", "Lager");
    fill("Net contents", "12 FL OZ");
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].alcoholContent).toBeUndefined();
  });

  it("labels alcohol content as required (no suffix) for distilled spirits, the default beverage type", () => {
    render(<ApplicationForm onSubmit={vi.fn()} busy={false} fileAttached={true} />);
    expect(screen.getByText("Alcohol content", { selector: "label" })).toBeInTheDocument();
    expect(screen.queryByText(/Alcohol content \(optional/)).not.toBeInTheDocument();
  });

  it("labels alcohol content as optional when beverage type is switched to malt beverage", () => {
    render(<ApplicationForm onSubmit={vi.fn()} busy={false} fileAttached={true} />);
    fireEvent.change(screen.getByLabelText("Beverage type"), { target: { value: "malt-beverage" } });
    expect(screen.getByText("Alcohol content (optional for this type)")).toBeInTheDocument();
  });

  it("submits with cleaned values: trims whitespace and turns blank optional fields into undefined", async () => {
    const onSubmit = vi.fn();
    render(<ApplicationForm onSubmit={onSubmit} busy={false} fileAttached={true} />);
    fill("Brand name", "OLD TOM DISTILLERY");
    fill("Class / type designation", "Vodka");
    fill("Alcohol content", "  40% Alc./Vol.  ");
    fill("Net contents", "750 mL");
    fill("Name and address (optional)", "   ");
    fill("Country of origin (optional)", "   ");
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith({
      beverageType: "distilled-spirits",
      brandName: "OLD TOM DISTILLERY",
      classType: "Vodka",
      alcoholContent: "40% Alc./Vol.",
      netContents: "750 mL",
      nameAndAddress: undefined,
      countryOfOrigin: undefined,
      isImport: false,
    });
  });

  it("labels country of origin as optional by default, required once 'imported product' is checked", () => {
    render(<ApplicationForm onSubmit={vi.fn()} busy={false} fileAttached={true} />);
    expect(screen.getByText("Country of origin (optional)")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("This is an imported product"));
    expect(screen.getByText("Country of origin", { selector: "label" })).toBeInTheDocument();
    expect(screen.queryByText("Country of origin (optional)")).not.toBeInTheDocument();
  });

  it("blocks submit and shows an error when an imported product has no country of origin", async () => {
    const onSubmit = vi.fn();
    render(<ApplicationForm onSubmit={onSubmit} busy={false} fileAttached={true} />);
    fill("Brand name", "KIRKBRIDE");
    fill("Class / type designation", "Red Wine");
    fill("Alcohol content", "13% Alc./Vol.");
    fill("Net contents", "750 mL");
    fireEvent.click(screen.getByLabelText("This is an imported product"));
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    await waitFor(() => expect(screen.getByText(/required for imported products/i)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits successfully for an imported product once country of origin is filled in", async () => {
    const onSubmit = vi.fn();
    render(<ApplicationForm onSubmit={onSubmit} busy={false} fileAttached={true} />);
    fill("Brand name", "KIRKBRIDE");
    fill("Class / type designation", "Red Wine");
    fill("Alcohol content", "13% Alc./Vol.");
    fill("Net contents", "750 mL");
    fireEvent.click(screen.getByLabelText("This is an imported product"));
    fill("Country of origin", "France");
    fireEvent.click(screen.getByRole("button", { name: "Verify label" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].countryOfOrigin).toBe("France");
    expect(onSubmit.mock.calls[0][0].isImport).toBe(true);
  });

  it("disables the submit button when no file is attached", () => {
    render(<ApplicationForm onSubmit={vi.fn()} busy={false} fileAttached={false} />);
    expect(screen.getByRole("button", { name: "Verify label" })).toBeDisabled();
    expect(screen.getByText(/Add a label image to enable verification/i)).toBeInTheDocument();
  });

  it("enables the submit button once a file is attached", () => {
    render(<ApplicationForm onSubmit={vi.fn()} busy={false} fileAttached={true} />);
    expect(screen.getByRole("button", { name: "Verify label" })).toBeEnabled();
    expect(screen.queryByText(/Add a label image to enable verification/i)).not.toBeInTheDocument();
  });

  it("prefills form fields from defaultValues", () => {
    render(
      <ApplicationForm
        onSubmit={vi.fn()}
        busy={false}
        fileAttached={true}
        defaultValues={{
          beverageType: "wine",
          brandName: "SUNSET RIDGE",
          classType: "Table Wine",
          alcoholContent: "12% Alc./Vol.",
          netContents: "750 mL",
          nameAndAddress: "Sunset Ridge Winery, Napa, CA",
          countryOfOrigin: "USA",
        }}
      />,
    );
    expect(screen.getByLabelText("Beverage type")).toHaveValue("wine");
    expect(screen.getByLabelText("Brand name")).toHaveValue("SUNSET RIDGE");
    expect(screen.getByLabelText("Class / type designation")).toHaveValue("Table Wine");
    // "Table Wine" makes alcohol content optional (27 CFR 4.36), so its accessible name carries the
    // "(optional for this type)" suffix — this only reads correctly now that the input's own static
    // aria-label (which used to override the conditional <label> text) has been removed.
    expect(screen.getByLabelText("Alcohol content (optional for this type)")).toHaveValue("12% Alc./Vol.");
    expect(screen.getByLabelText("Net contents")).toHaveValue("750 mL");
    expect(screen.getByLabelText("Name and address (optional)")).toHaveValue("Sunset Ridge Winery, Napa, CA");
    expect(screen.getByLabelText("Country of origin (optional)")).toHaveValue("USA");
  });
});
