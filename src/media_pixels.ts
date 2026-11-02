export interface RgbFrame {
  rgb: Uint8Array;
  width: number;
  height: number;
}
export function rgbaRgb(
  pixels: Uint8Array,
  width: number,
  height: number,
): RgbFrame {
  if (
    !Number.isInteger(width) || !Number.isInteger(height) || width < 1 ||
    height < 1 || width * height > 16_000_000 ||
    pixels.length !== width * height * 4
  ) throw new Error("媒体尺寸无效或超过1600万像素");
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    for (let c = 0; c < 3; c++) {
      rgb[j++] = Math.round(
        (pixels[i + c] * alpha + 255 * (255 - alpha)) / 255,
      );
    }
  }
  return { rgb, width, height };
}

/** EXIF orthogonal transforms, preserving the prior decoder's autorotation. */
export function orientRgb(frame: RgbFrame, orientation: number): RgbFrame {
  if (!Number.isInteger(orientation) || orientation < 2 || orientation > 8) {
    return frame;
  }
  const { width: w, height: h, rgb } = frame;
  const width = orientation >= 5 ? h : w, height = orientation >= 5 ? w : h;
  const output = new Uint8Array(rgb.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx = x, dy = y;
      if (orientation === 2) dx = w - 1 - x;
      if (orientation === 3) {
        dx = w - 1 - x;
        dy = h - 1 - y;
      }
      if (orientation === 4) dy = h - 1 - y;
      if (orientation === 5) {
        dx = y;
        dy = x;
      }
      if (orientation === 6) {
        dx = h - 1 - y;
        dy = x;
      }
      if (orientation === 7) {
        dx = h - 1 - y;
        dy = w - 1 - x;
      }
      if (orientation === 8) {
        dx = y;
        dy = w - 1 - x;
      }
      output.set(
        rgb.subarray((y * w + x) * 3, (y * w + x) * 3 + 3),
        (dy * width + dx) * 3,
      );
    }
  }
  return { rgb: output, width, height };
}
