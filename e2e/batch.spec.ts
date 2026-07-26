import { expect, test } from "@playwright/test";

test("batch streams APPROVED, REJECTED, and a per-row ERROR without aborting (workflows 2 + 3)", async ({ page }) => {
  await page.goto("/batch");
  await page.getByLabel("Applications CSV").setInputFiles("e2e/fixtures/batch.csv");
  await page.getByLabel("Label images").setInputFiles(["eval/samples/old-tom-clean.png", "eval/samples/wrong-abv.png"]);
  await page.getByRole("button", { name: /Verify batch/ }).click();
  await expect(page.getByRole("cell", { name: "APPROVED" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "REJECTED" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "ERROR" })).toBeVisible(); // CSV row with no uploaded image (workflow 3)
  await expect(page.getByText(/No uploaded image matches/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download results CSV" })).toBeEnabled();
});

test("batch handles real-world photos and a degraded capture without aborting", async ({ page }) => {
  await page.goto("/batch");
  await page.getByLabel("Applications CSV").setInputFiles("e2e/fixtures/real-world-batch.csv");
  await page
    .getByLabel("Label images")
    .setInputFiles([
      "eval/samples/old-tom-clean.png",
      "eval/samples/spirits-old-tub-bourbon-front.jpg",
      "eval/samples/degraded/old-tom-clean-blur.png",
    ]);
  await page.getByRole("button", { name: /Verify batch/ }).click();
  // old-tom-clean.png is a recognized mock fixture → APPROVED.
  await expect(page.getByRole("cell", { name: "APPROVED" })).toBeVisible();
  // The real photo and the degraded capture aren't in the mock tier's fixed fixture set, so each
  // becomes a per-row ERROR — the correct "ask for a better image" recovery path (workflow 3 in
  // the design spec) exercised at batch scale, not a bug in this test.
  await expect(page.getByRole("cell", { name: "ERROR" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Download results CSV" })).toBeEnabled();
});
