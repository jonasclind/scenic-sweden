"""PNG output: hillshaded terrain with a score heatmap over it."""
from __future__ import annotations

import numpy as np
from PIL import Image

# inferno anchors, dark -> bright
_INFERNO = np.array([
    (0.001, 0.000, 0.014), (0.129, 0.047, 0.281), (0.341, 0.063, 0.430),
    (0.549, 0.161, 0.392), (0.741, 0.278, 0.302), (0.890, 0.448, 0.153),
    (0.976, 0.661, 0.036), (0.988, 0.906, 0.145),
])


def colormap(t: np.ndarray) -> np.ndarray:
    """t in [0,1] -> (..., 3) float RGB."""
    t = np.clip(np.nan_to_num(t), 0.0, 1.0)
    pos = t * (len(_INFERNO) - 1)
    i = np.clip(pos.astype(int), 0, len(_INFERNO) - 2)
    f = (pos - i)[..., None]
    return _INFERNO[i] * (1 - f) + _INFERNO[i + 1] * f


def hillshade(z: np.ndarray, step: float, azimuth: float = 315.0,
              altitude: float = 45.0, exaggeration: float = 2.0) -> np.ndarray:
    z = np.nan_to_num(z, nan=float(np.nanmin(z)) if np.isfinite(z).any() else 0.0)
    gy, gx = np.gradient(z * exaggeration, step)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    az = np.radians(360.0 - azimuth + 90.0)
    alt = np.radians(altitude)
    hs = (np.sin(alt) * np.cos(slope) +
          np.cos(alt) * np.sin(slope) * np.cos(az - aspect))
    return np.clip(hs, 0, 1)


def downsample(a: np.ndarray, ny: int, nx: int) -> np.ndarray:
    yi = np.linspace(0, a.shape[0] - 1, ny).astype(int)
    xi = np.linspace(0, a.shape[1] - 1, nx).astype(int)
    return a[np.ix_(yi, xi)]


def compose(score: np.ndarray, terrain: np.ndarray, step: float,
            water: np.ndarray | None = None, alpha: float = 0.78,
            upscale: int = 2) -> Image.Image:
    """score and terrain must share a shape. Row 0 is south; we flip for PNG."""
    finite = score[np.isfinite(score) & (score > 0)]
    if finite.size:
        lo, hi = np.percentile(finite, [2, 98])
    else:
        lo, hi = 0.0, 1.0
    t = (score - lo) / max(hi - lo, 1e-9)

    hs = hillshade(terrain, step)[..., None]
    base = np.repeat(hs, 3, axis=2) * np.array([0.82, 0.84, 0.80])
    rgb = base * (1 - alpha) + colormap(t) * alpha * (0.35 + 0.65 * hs)

    dead = ~np.isfinite(score) | (score <= 0)
    rgb[dead] = (base * 0.9)[dead]
    if water is not None:
        rgb[water] = np.array([0.15, 0.27, 0.42]) * (0.5 + 0.5 * hs[water])

    img = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)[::-1])
    if upscale > 1:
        img = img.resize((img.width * upscale, img.height * upscale), Image.LANCZOS)
    return img


def mark_spots(img: Image.Image, spots, x0: float, y0: float, span: float,
               upscale: int) -> Image.Image:
    """Draw numbered markers at ranked spots. Coordinates are metres from the
    box centre; the image has already been flipped so north is up."""
    from PIL import ImageDraw
    d = ImageDraw.Draw(img)
    w = img.width
    for k, sp in enumerate(spots, 1):
        px = (sp["x"] - x0) / span * w
        py = w - (sp["y"] - y0) / span * w          # flip: north is up
        r = 7 * upscale / 2
        d.ellipse([px - r, py - r, px + r, py + r], outline=(255, 255, 255), width=2)
        d.ellipse([px - 2, py - 2, px + 2, py + 2], fill=(255, 255, 255))
        tx = min(px + r + 2, w - 12); ty = min(max(py - r, 0), img.height - 12)
        d.text((tx, ty), str(k), fill=(255, 255, 255))
    return img


def draw_box(img: Image.Image, half_m: float, span: float,
             label: str | None = None) -> Image.Image:
    """Outline a centred sub-area, in metres, on a centred map image."""
    from PIL import ImageDraw
    d = ImageDraw.Draw(img)
    w = img.width
    f = half_m / (span / 2)
    lo, hi = w * (1 - f) / 2, w * (1 + f) / 2
    d.rectangle([lo, lo, hi, hi], outline=(255, 255, 255), width=2)
    if label:
        d.text((lo + 4, lo + 4), label, fill=(255, 255, 255))
    return img
