export const config = {
  stackNames: {
    frontend: "packs-frontend",
    backend: "packs-backend",
    certificate: "packs-certificate",
  },
  regions: {
    application: "us-east-2",
    certificate: "us-east-1",
  },
  domain: "7028robotics.com",
  subdomain: "packs",
  hostedZoneId: 'Z014656337LGZWAE9JKJP',
  lambda: {
    memorySize: 512,
    timeoutSeconds: 28,
    adminOnly: false,
  },
  // Requests per second the API accepts in total (more get a 429 from API Gateway). A school's worth of players is a
  // few requests a second; this stops a script from running the bill up.
  apiThrottle: { rate: 100, burst: 200 },
  // How often the "free pack ready" notifications are checked.
  readyCheckMinutes: 5,
  // Where alarms and the budget warning are emailed. Leave empty to skip them (set it and redeploy to turn them on;
  // AWS sends a confirmation email to this address first). NOTE: Alarms have AWS cost implications
  alertEmail: "",
  monthlyBudgetUsd: 25,
} as const;

// What pages may load. Keep identical to CONTENT_SECURITY_POLICY in server/src/lib.rs (cdk/test/stacks.test.ts checks).
export const contentSecurityPolicy =
  "default-src 'self'; script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
  "img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; " +
  "worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export const fqdn = `${config.subdomain}.${config.domain}`;
