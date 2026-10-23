import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The Android and iOS apps: the web build (dist/) in a native shell, with the phone's file
 * sharing, "Open with" and Back button (src/lib/mobile.ts). `npm run mobile:sync` copies a new
 * build into android/ and ios/; see README → Phone apps.
 */
const config: CapacitorConfig = {
  appId: "app.doxxta.mobile",
  appName: "Doxxta",
  webDir: "dist",
  ios: {
    // The page is drawn under the status bar and home indicator, and keeps clear of them itself (phone.css).
    contentInset: "never",
  },
};

export default config;
