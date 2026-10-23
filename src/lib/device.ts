import { useCallback, useSyncExternalStore } from "react";

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

/** How many pixels at the bottom of the window the on-screen keyboard covers. */
function keyboardInset(): number {
  const view = window.visualViewport;
  return view ? Math.max(0, Math.round(window.innerHeight - view.height - view.offsetTop)) : 0;
}

/**
 * The height of the window the on-screen keyboard covers, while `active`. iPhones (and Chrome on
 * Android) don't shrink the page for the keyboard, so what's fixed to the bottom goes under it
 * unless it's raised by this much; where the page does shrink (the Android app), it's 0.
 */
export function useKeyboardInset(active: boolean): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const view = active ? window.visualViewport : null;
      view?.addEventListener("resize", onChange);
      view?.addEventListener("scroll", onChange);
      return () => {
        view?.removeEventListener("resize", onChange);
        view?.removeEventListener("scroll", onChange);
      };
    },
    [active],
  );
  const inset = useSyncExternalStore(subscribe, keyboardInset, () => 0);
  return active ? inset : 0;
}
