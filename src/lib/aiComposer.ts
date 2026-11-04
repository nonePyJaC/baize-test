export type ComposerKeyAction = "send" | "newline" | "block" | "native";

export interface ComposerKeyState {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  keyCode?: number;
  hasText: boolean;
}

export function composerKeyAction(state: ComposerKeyState): ComposerKeyAction {
  if (state.key !== "Enter" || state.isComposing || state.keyCode === 229) return "native";
  if (state.ctrlKey || state.metaKey) return "newline";
  if (state.shiftKey) return "native";
  return state.hasText ? "send" : "block";
}

export function insertLineBreak(value: string, start: number, end: number): { value: string; caret: number } {
  return { value: `${value.slice(0, start)}\n${value.slice(end)}`, caret: start + 1 };
}
