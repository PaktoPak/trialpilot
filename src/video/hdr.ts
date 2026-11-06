import fs from "node:fs/promises";
import type { VideoInfo } from "../ffmpeg.js";

/**
 * HDR video looks dark and grey wherever it's shown as normal video, Instagram's uploads included.
 * Most iPhone videos are HDR (HLG), and some Android ones are too (PQ). Their versions are made in
 * normal colour (SDR, BT.709) the way an SDR camera would have recorded the scene, following ITU-R
 * BT.2408: HDR's reference white (HLG 75%, 203 cd/m²) becomes SDR's white, an 18% grey card lands
 * where SDR puts it, and brighter highlights roll off smoothly instead of clipping.
 */
export type HdrKind = "hlg" | "pq";

export function hdrKind(info: Pick<VideoInfo, "color_transfer">): HdrKind | undefined {
  if (info.color_transfer === "arib-std-b67") return "hlg";
  if (info.color_transfer === "smpte2084") return "pq";
  return undefined;
}

const [A, B, C] = [0.17883277, 0.28466892, 0.55991073];
/** HLG's signal as the scene light a camera saw, 0 to 1 (ITU-R BT.2100). */
const hlgScene = (v: number) => (v <= 0.5 ? (v * v) / 3 : (Math.exp((v - C) / A) + B) / 12);

const REFERENCE_WHITE = hlgScene(0.75);
// HLG's brightest, compared with reference white. PQ highlights brighter than 1,000 cd/m² become white.
const PEAK = 1 / REFERENCE_WHITE;
// Light up to this level (1 is reference white) stays as it is; above it, highlights are squeezed.
const KNEE = 0.75;
// From BT.2020 to BT.709 primaries, in linear light (ITU-R BT.2087).
const TO_BT709 = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
];

/** HDR R'G'B' (0 to 1) as scene light, 0 to 1. */
function sceneLight(kind: HdrKind, rgb: number[]): number[] {
  if (kind === "hlg") return rgb.map(hlgScene);
  // PQ stores the light a screen gives off, here compared with 1,000 cd/m². HLG's reference display
  // (system gamma 1.2) turns that back into scene light.
  const [m1, m2, c1, c2, c3] = [2610 / 16384, 2523 / 32, 3424 / 4096, 2413 / 128, 2392 / 128];
  const display = rgb.map((v) => {
    const p = v ** (1 / m2);
    return 10 * (Math.max(p - c1, 0) / (c2 - c3 * p)) ** (1 / m1);
  });
  const luminance = 0.2627 * display[0] + 0.678 * display[1] + 0.0593 * display[2];
  return luminance > 0 ? display.map((d) => d * luminance ** (-1 / 6)) : [0, 0, 0];
}

/** The SDR camera curve (ITU-R BT.709). Its straight start keeps dark colours steady. */
const bt709 = (l: number) => (l < 0.018 ? 4.5 * l : 1.099 * l ** 0.45 - 0.099);

/** One HDR colour, as BT.2020 R'G'B' from 0 to 1, turned into the SDR BT.709 R'G'B' it becomes. */
export function hdrToSdr(kind: HdrKind, rgb: number[]): number[] {
  const scene = sceneLight(kind, rgb).map((e) => e / REFERENCE_WHITE);
  let out = TO_BT709.map((row) => row[0] * scene[0] + row[1] * scene[1] + row[2] * scene[2]);
  const luminance = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
  if (luminance <= 0) return [0, 0, 0];
  // Colours BT.709 can't show lose just enough saturation to fit, keeping their brightness and hue.
  const lowest = Math.min(...out);
  if (lowest < 0) out = out.map((v) => luminance + ((v - luminance) * luminance) / (luminance - lowest));
  // Highlights above the knee roll off towards white, which the peak reaches.
  const highest = Math.max(...out);
  if (highest > KNEE) {
    const t = Math.min((highest - KNEE) / (PEAK - KNEE), 1);
    const s = (PEAK - 1) / (1 - KNEE);
    const rolled = KNEE + ((1 - KNEE) * (1 + s) * t) / (1 + s * t);
    out = out.map((v) => (v * rolled) / highest);
  }
  return out.map((v) => bt709(Math.min(Math.max(v, 0), 1)));
}

/**
 * Saves the colour table for FFmpeg's lut3d filter as a .cube file: red changes fastest, then green,
 * then blue. 65 points a side keep every colour within about one 8-bit step of hdrToSdr; 33 don't.
 */
export async function writeHdrLut(kind: HdrKind, file: string, size = 65): Promise<void> {
  const lines = [`LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lines.push(hdrToSdr(kind, [r, g, b].map((v) => v / (size - 1))).map((v) => v.toFixed(5)).join(" "));
      }
    }
  }
  await fs.writeFile(file, `${lines.join("\n")}\n`);
}
