// EMAIL_SIGN_IN turns email-code sign-in on or off, at the gateway and in Better Auth. It is off unless set to "on".
// Operations mail doesn't use the email-otp plugin, so it works either way.

/** Every endpoint the email-otp plugin registers, relative to Better Auth's basePath (for `disabledPaths`). */
export const EMAIL_OTP_PATHS = [
  "/email-otp/send-verification-otp",
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/sign-in/email-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
];

export function emailSignInEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = (env.EMAIL_SIGN_IN ?? "").trim();
  if (value === "" || value === "off") return false;
  if (value === "on") return true;
  throw new Error('EMAIL_SIGN_IN must be "on" or "off"');
}
