export function loadBackdropImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  return img.decode().then(() => img);
}

export async function cropViewerImage(
  src: string,
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
): Promise<string> {
  const image = await loadBackdropImage(src);
  const sx = image.naturalWidth / viewport.width;
  const sy = image.naturalHeight / viewport.height;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * sx));
  canvas.height = Math.max(1, Math.round(rect.height * sy));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(image, rect.left * sx, rect.top * sy, rect.width * sx, rect.height * sy, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

// Bake one opaque texture for both WebView2 and the native resize cover.
// The moving sharp frame is separate, so neither renderer can pick up the
// current video frame as the backdrop or resample the page during the zoom.
export function viewerBackdrop(mode: string, tone: string, page?: HTMLImageElement, media?: HTMLImageElement): string {
  const aspect = Math.max(0.5, Math.min(3, window.screen.width / Math.max(1, window.screen.height)));
  const w = 480;
  const h = Math.max(2, Math.round(w / aspect));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = mode === "solid" ? tone : "#090d16";
  ctx.fillRect(0, 0, w, h);

  if (mode !== "solid" && page) {
    ctx.save();
    ctx.filter = "blur(13px) saturate(1.24) brightness(.69)";
    ctx.globalAlpha = 0.92;
    const edge = 22;
    ctx.drawImage(page, -edge, -edge, w + edge * 2, h + edge * 2);
    ctx.restore();
  }
  if (mode === "ambient" && media) {
    ctx.save();
    ctx.globalAlpha = 0.66;
    ctx.filter = "blur(25px) saturate(1.45) brightness(.76)";
    const scale = Math.max((w + 80) / media.naturalWidth, (h + 80) / media.naturalHeight);
    const mw = media.naturalWidth * scale;
    const mh = media.naturalHeight * scale;
    ctx.drawImage(media, (w - mw) / 2, (h - mh) / 2, mw, mh);
    ctx.restore();
  }

  const glow = ctx.createRadialGradient(w / 2, h * 0.38, 0, w / 2, h * 0.38, Math.max(w, h) * 0.7);
  glow.addColorStop(0, mode === "solid" ? "rgba(255,255,255,.055)" : "rgba(8,11,19,.11)");
  glow.addColorStop(1, "rgba(4,7,14,.55)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.86);
}
