import type { Page } from 'playwright';

const HOSTED_UI_URL = /\.amazoncognito\.com\/(login|oauth2\/authorize)/;

/**
 * Signs in on the classic Cognito hosted UI exactly as a person would: the SPA has already
 * redirected to `/oauth2/authorize` (code + PKCE), Cognito shows its login page, and we type the
 * e-mail and password into the visible form and press "Sign in". The classic page renders the
 * form twice (mobile and desktop layouts); only one of them is visible at a time.
 *
 * `beforeSubmit` runs with the form filled in (used for the screenshot of the hosted UI).
 */
export async function signInWithHostedUi(
  page: Page,
  email: string,
  password: string,
  options: { typeDelayMs?: number; beforeSubmit?: () => Promise<void> } = {},
): Promise<void> {
  await page.waitForURL(HOSTED_UI_URL, { timeout: 30_000 });
  const form = page.locator('form[name="cognitoSignInForm"]:visible');
  const username = form.locator('input[name="username"]');
  await username.waitFor({ state: 'visible', timeout: 30_000 });
  const delay = options.typeDelayMs ?? 0;
  await username.pressSequentially(email, { delay });
  await form.locator('input[name="password"]').pressSequentially(password, { delay });
  await options.beforeSubmit?.();
  await form.locator('input[name="signInSubmitButton"]').click();
}

export function isHostedUiUrl(url: string): boolean {
  return HOSTED_UI_URL.test(url);
}
