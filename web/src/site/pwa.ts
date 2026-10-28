// Installing FRC Packs as an app, and push notifications (free pack ready, trade offers, trades accepted).
// - Install: Chrome and Edge offer a prompt the page can trigger. iPhone and iPad Safari don't (Share, Add to Home Screen).
// - Notifications: on iPhone they only work once FRC Packs is on the home screen (Apple's rule).
import { api } from "../api";
import { store } from "../lib/store";

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
export const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
const canPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

let reg: ServiceWorkerRegistration | null = null;
let prompt: InstallPrompt | null = null;

export type PushState = "on" | "off" | "blocked" | "unsupported" | "ios-home";
export const push = store<PushState>("off");
export const canInstall = store(false);

const b64 = (buf: ArrayBuffer | null) => (buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "");
function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const sub = () => (reg ? reg.pushManager.getSubscription() : Promise.resolve(null));

async function check() {
  if (ios && !standalone()) return push.set("ios-home");
  if (!canPush() || !reg) return push.set("unsupported");
  if (Notification.permission === "denied") return push.set("blocked");
  push.set((await sub()) && Notification.permission === "granted" ? "on" : "off");
}

export async function togglePush() {
  if (await sub()) {
    const s = (await sub())!;
    await api.pushUnsubscribe(s.endpoint).catch(() => {});
    await s.unsubscribe();
  } else {
    const { key } = await api.pushKey();
    if (!key || !reg) throw new Error("push unavailable");
    if ((await Notification.requestPermission()) === "granted") {
      const s = (await sub()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64(key) }));
      await api.pushSubscribe({ endpoint: s.endpoint, keys: { p256dh: b64(s.getKey("p256dh")), auth: b64(s.getKey("auth")) } });
    }
  }
  await check();
}

export async function install() {
  if (!prompt) return;
  await prompt.prompt();
  await prompt.userChoice.catch(() => null);
  prompt = null;
  canInstall.set(false);
}

export function setupPwa() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").then((r) => { reg = r; check(); }, () => check());
  else check();
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); prompt = e as InstallPrompt; canInstall.set(true); });
  addEventListener("appinstalled", () => { prompt = null; canInstall.set(false); });
}
