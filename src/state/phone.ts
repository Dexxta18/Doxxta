import { create } from "zustand";
import type { RightPanelId } from "./types";

/** What covers the screen on a phone: the menus, the tools, or one of the side panels. */
export type PhoneSheet = "menu" | "tools" | RightPanelId;

export const usePhoneSheet = create<{ sheet: PhoneSheet | null }>(() => ({ sheet: null }));

export const showSheet = (sheet: PhoneSheet | null) => usePhoneSheet.setState({ sheet });
