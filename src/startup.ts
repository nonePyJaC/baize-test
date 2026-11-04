import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import splashVideoUrl from "../白泽.mp4?url";
import splashLogoUrl from "./assets/logo-baize.png";

const splash = document.getElementById("startup-splash");
const video = document.getElementById("startup-video") as HTMLVideoElement | null;
const logo = document.getElementById("startup-logo") as HTMLImageElement | null;

if (splash && video && logo) {
  const fadeDurationMs = 400;
  let appReady = false;
  let videoFinished = false;
  let windowReady = !isTauri();
  let fadeStarted = false;

  const fadeWhenReady = () => {
    if (!appReady || !videoFinished || !windowReady || fadeStarted) return;
    fadeStarted = true;
    splash.classList.add("is-fading");
    window.setTimeout(() => splash.remove(), fadeDurationMs + 80);
  };

  const showFallback = () => {
    if (videoFinished) return;
    videoFinished = true;
    video.pause();
    splash.classList.add("video-failed");
    fadeWhenReady();
  };

  logo.addEventListener("load", () => splash.classList.add("logo-ready"), { once: true });
  logo.src = splashLogoUrl;
  video.muted = true;
  video.volume = 0;
  video.controls = false;
  video.loop = false;
  video.playsInline = true;
  video.addEventListener("error", showFallback, { once: true });
  video.addEventListener("ended", () => {
    video.pause();
    videoFinished = true;
    fadeWhenReady();
  }, { once: true });
  video.src = splashVideoUrl;
  void video.play().catch(showFallback);

  window.addEventListener("baize:app-ready", () => {
    appReady = true;
    fadeWhenReady();
  }, { once: true });

  if (isTauri()) {
    void (async () => {
      const currentWindow = getCurrentWindow();
      try {
        await currentWindow.show();
        await currentWindow.setFocus();
      } catch {
        windowReady = true;
        fadeWhenReady();
        return;
      }
      windowReady = true;
      fadeWhenReady();
    })();
  }
}

void import("./main").catch(() => {
  splash?.classList.add("video-failed");
});
