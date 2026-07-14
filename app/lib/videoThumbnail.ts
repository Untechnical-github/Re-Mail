import type { VideoThumb } from "./attachmentCache";

// 動画のbase64データから最初のフレームを抜き出してサムネイル(JPEG dataURL)と
// アスペクト比を生成する。ブラウザがデコードできない形式などは null を返す。
export function generateVideoThumbnail(base64: string, mimeType: string): Promise<VideoThumb | null> {
  return new Promise((resolve) => {
    let settled = false;
    let url: string | null = null;
    let video: HTMLVideoElement | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: VideoThumb | null) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (video) {
        video.removeAttribute("src");
        video.load();
      }
      if (url) URL.revokeObjectURL(url);
      resolve(result);
    };

    try {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: mimeType });
      url = URL.createObjectURL(blob);

      video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.src = url;

      timeoutId = setTimeout(() => finish(null), 8000);

      video.addEventListener("loadedmetadata", () => {
        if (!video || !video.videoWidth || !video.videoHeight) { finish(null); return; }
        // 冒頭が真っ黒なことがあるため少しだけ進めたフレームを使う
        try {
          video.currentTime = Math.min(0.3, (video.duration || 1) / 2);
        } catch {
          finish(null);
        }
      });

      video.addEventListener("seeked", () => {
        if (!video) return;
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d");
          if (!ctx) { finish(null); return; }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          finish({ dataUrl, ratio: canvas.width / canvas.height });
        } catch {
          finish(null);
        }
      });

      video.addEventListener("error", () => finish(null));
    } catch {
      finish(null);
    }
  });
}
