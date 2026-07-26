"use client";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { ApplicationData } from "@/lib/schema";
import { ApplicationDataSchema } from "@/lib/schema";
import { isAlcoholContentRequired, isCountryOfOriginRequired } from "@/lib/ttb/required-fields";

const FIELD_CLASS =
  "w-full rounded-lg border border-input bg-card px-3.5 py-3 text-lg text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus:border-ring focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  const errorId = `${id}-error`;
  // Cloning wires aria-invalid/aria-describedby onto the actual input for every Field caller in one
  // place, so a screen-reader user re-visiting a still-invalid field hears why, not just silence.
  const control = isValidElement<React.AriaAttributes>(children)
    ? cloneElement(children, {
        "aria-invalid": error ? true : undefined,
        "aria-describedby": error ? errorId : undefined,
      })
    : children;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-base font-medium text-foreground">
        {label}
      </label>
      {control}
      {error ? (
        <p id={errorId} role="alert" className="text-base font-medium text-verdict-non-compliant">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Empty optional strings become undefined so the matcher skips them. */
function clean(v: ApplicationData): ApplicationData {
  return {
    ...v,
    alcoholContent: v.alcoholContent?.trim() ? v.alcoholContent.trim() : undefined,
    nameAndAddress: v.nameAndAddress?.trim() ? v.nameAndAddress.trim() : undefined,
    countryOfOrigin: v.countryOfOrigin?.trim() ? v.countryOfOrigin.trim() : undefined,
  };
}

export function ApplicationForm({
  onSubmit,
  busy,
  fileAttached,
  defaultValues,
}: {
  onSubmit: (app: ApplicationData) => void;
  busy: boolean;
  fileAttached: boolean;
  // Prefill (e.g. when a bundled sample is loaded). Remount via a `key` to apply new values.
  defaultValues?: ApplicationData;
}) {
  const form = useForm<ApplicationData>({
    resolver: zodResolver(ApplicationDataSchema),
    mode: "onBlur",
    defaultValues: defaultValues ?? {
      beverageType: "distilled-spirits",
      brandName: "",
      classType: "",
      alcoholContent: "",
      netContents: "",
      nameAndAddress: "",
      countryOfOrigin: "",
      isImport: false,
    },
  });
  const errors = form.formState.errors;
  // useWatch (not form.watch()) so the reactive read is compiler-safe; only the fields that drive
  // requiredness are needed to toggle the alcohol-content / country-of-origin labels.
  const [beverageType, classType, alcoholContent, isImport] = useWatch({
    control: form.control,
    name: ["beverageType", "classType", "alcoholContent", "isImport"],
  });
  const abvRequired = isAlcoholContentRequired({
    beverageType: beverageType ?? "distilled-spirits",
    brandName: "",
    classType: classType ?? "",
    alcoholContent: alcoholContent?.trim() ? alcoholContent : undefined,
    netContents: "",
  });
  const coRequired = isCountryOfOriginRequired({
    beverageType: beverageType ?? "distilled-spirits",
    brandName: "",
    classType: classType ?? "",
    netContents: "",
    isImport,
  });

  const submit = form.handleSubmit((v) => {
    const app = clean(v);
    if (!app.alcoholContent && isAlcoholContentRequired(app)) {
      form.setError("alcoholContent", { message: "Alcohol content is required for this beverage type." });
      return;
    }
    if (!app.countryOfOrigin && isCountryOfOriginRequired(app)) {
      form.setError("countryOfOrigin", { message: "Country of origin is required for imported products." });
      return;
    }
    onSubmit(app);
  });

  return (
    // id lets controls OUTSIDE this form submit it (the retry button in the result column uses
    // form="application-form"), so a retry always re-reads the fields as they are now rather than
    // replaying a stale snapshot taken at first submit.
    <form id="application-form" onSubmit={submit} className="space-y-4" aria-label="Application data">
      <Field id="beverageType" label="Beverage type">
        <select id="beverageType" className={FIELD_CLASS} {...form.register("beverageType")}>
          <option value="distilled-spirits">Distilled spirits</option>
          <option value="wine">Wine</option>
          <option value="malt-beverage">Malt beverage (beer)</option>
        </select>
      </Field>
      <Field id="brandName" label="Brand name" error={errors.brandName?.message}>
        <input
          id="brandName"
          className={FIELD_CLASS}
          placeholder="OLD TOM DISTILLERY"
          {...form.register("brandName")}
        />
      </Field>
      <Field id="classType" label="Class / type designation" error={errors.classType?.message}>
        <input
          id="classType"
          className={FIELD_CLASS}
          placeholder="Kentucky Straight Bourbon Whiskey"
          {...form.register("classType")}
        />
      </Field>
      <Field
        id="alcoholContent"
        label={abvRequired ? "Alcohol content" : "Alcohol content (optional for this type)"}
        error={errors.alcoholContent?.message}
      >
        <input
          id="alcoholContent"
          className={FIELD_CLASS}
          placeholder="45% Alc./Vol. (90 Proof)"
          {...form.register("alcoholContent")}
        />
      </Field>
      <Field id="netContents" label="Net contents" error={errors.netContents?.message}>
        <input id="netContents" className={FIELD_CLASS} placeholder="750 mL" {...form.register("netContents")} />
      </Field>
      <Field id="nameAndAddress" label="Name and address (optional)">
        <input id="nameAndAddress" className={FIELD_CLASS} {...form.register("nameAndAddress")} />
      </Field>
      <div className="flex items-center gap-3">
        <input
          id="isImport"
          type="checkbox"
          className="h-5 w-5 rounded border-input text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          {...form.register("isImport")}
        />
        <label htmlFor="isImport" className="text-base font-medium text-foreground">
          This is an imported product
        </label>
      </div>
      <Field
        id="countryOfOrigin"
        label={coRequired ? "Country of origin" : "Country of origin (optional)"}
        error={errors.countryOfOrigin?.message}
      >
        <input id="countryOfOrigin" className={FIELD_CLASS} {...form.register("countryOfOrigin")} />
      </Field>
      <button
        type="submit"
        disabled={busy || !fileAttached}
        className="w-full rounded-lg bg-primary px-4 py-3 text-lg font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
      >
        {busy ? "Checking…" : "Verify label"}
      </button>
      {!fileAttached ? (
        <p className="text-center text-sm text-muted-foreground">Add a label image to enable verification.</p>
      ) : null}
    </form>
  );
}
