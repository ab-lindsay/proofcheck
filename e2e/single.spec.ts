import { expect, test } from "@playwright/test";

async function fillApplication(page: import("@playwright/test").Page) {
  await page.getByLabel("Brand name").fill("OLD TOM DISTILLERY");
  await page.getByLabel("Class / type designation").fill("Kentucky Straight Bourbon Whiskey");
  await page.getByLabel("Alcohol content").fill("45% Alc./Vol. (90 Proof)");
  await page.getByLabel("Net contents").fill("750 mL");
}

test("clean sample label PASSes (workflow 1)", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Label image").setInputFiles("eval/samples/old-tom-clean.png");
  await fillApplication(page);
  await page.getByRole("button", { name: "Verify label" }).click();
  await expect(page.getByText("APPROVED", { exact: true })).toBeVisible();
  await expect(page.getByText(/word-for-word/)).toBeVisible();
});

test("title-case health warning FAILs with a caps reason", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Label image").setInputFiles("eval/samples/title-case-warning.png");
  await fillApplication(page);
  await page.getByRole("button", { name: "Verify label" }).click();
  await expect(page.getByText("REJECTED", { exact: true })).toBeVisible();
  await expect(page.getByText(/capital letters/)).toBeVisible();
});
