import { runApiScript } from "./apiScriptRuntime";
self.onmessage = (event: MessageEvent) => {
  try {
    self.postMessage({ ok: true, result: runApiScript(event.data) });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error) });
  }
};
