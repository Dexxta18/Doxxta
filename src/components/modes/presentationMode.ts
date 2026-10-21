import { getActiveDoc, useApp } from "../../state/store";

/** Starts full-screen presentation of the active document from its current page. */
export function startPresentation() {
  if (!getActiveDoc()) return;
  useApp.setState({ presentation: true });
  document.documentElement.requestFullscreen?.().catch(() => {
    /* Presentation still works in the window. */
  });
}

export function stopPresentation() {
  useApp.setState({ presentation: false });
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
