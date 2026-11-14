import { expect, type Page } from "@playwright/test";

/** #846 PROFILE-01: the learning profile form lives on My account only. */
export async function openLearningProfile(page: Page) {
  await page.goto(new URL("/account#profile", page.url()).href);
}

/** Saves the profile form, then returns to the learning path it changes. */
export async function saveLearningProfile(page: Page) {
  await page
    .getByRole("button", { name: "Save my profile", exact: true })
    .click();
  await expect(page).toHaveURL(/\/account#profile$/);
  await page.goto(new URL("/learn", page.url()).href);
}
