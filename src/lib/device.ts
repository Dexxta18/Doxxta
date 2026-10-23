import { useSyncExternalStore } from "react";

/** A phone, or a window as narrow as one: a narrow screen, or a short one held sideways. */
const PHONE = "(max-width: 700px), (max-height: 500px) and (pointer: coarse)";
const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(PHONE) : null;

export const isPhone = () => !!media?.matches;

/** Whether the app is laid out for a phone; follows the window as it's resized or turned. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      media?.addEventListener("change", onChange);
      return () => media?.removeEventListener("change", onChange);
    },
    isPhone,
    () => false,
  );
}
