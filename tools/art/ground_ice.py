"""Procedural seamless lake-ice texture (the image models kept drawing ice floes or lily pads).

Usage: python ground_ice.py <out.png> [size] [seed]

Everything is periodic (FFT-filtered noise, Voronoi on a wrapped torus), so the tile repeats
without seams: pale blue-grey ice with cloudy depth, a network of white pressure cracks, fainter
hairline cracks, frost streaks and a sprinkle of trapped bubbles. Needs numpy and Pillow.
"""
import sys

import numpy as np
from PIL import Image


def fft_noise(n, rng, power=2.0, aniso=(1.0, 1.0)):
    """Periodic noise with a 1/f^power spectrum (stretched by aniso), normalised to 0..1."""
    f = np.fft.fftfreq(n)
    fx, fy = np.meshgrid(f * aniso[0], f * aniso[1])
    r = np.sqrt(fx * fx + fy * fy)
    r[0, 0] = 1.0
    spec = (rng.normal(size=(n, n)) + 1j * rng.normal(size=(n, n))) / r ** power
    spec[0, 0] = 0
    out = np.real(np.fft.ifft2(spec))
    return (out - out.min()) / (out.max() - out.min())


def voronoi_edges(n, count, rng, warp=None):
    """Distance (in texels) from each texel to the nearest Voronoi edge on a wrapped tile."""
    pts = rng.random((count, 2)) * n
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    if warp is not None:
        xx = xx + warp[0]
        yy = yy + warp[1]
    d1 = np.full((n, n), 1e9, np.float32)
    d2 = np.full((n, n), 1e9, np.float32)
    for px, py in pts:
        dx = np.abs(xx - px)
        dx = np.minimum(dx, n - dx)
        dy = np.abs(yy - py)
        dy = np.minimum(dy, n - dy)
        d = np.sqrt(dx * dx + dy * dy)
        closer = d < d1
        d2 = np.where(closer, d1, np.minimum(d2, d))
        d1 = np.where(closer, d, d1)
    return (d2 - d1) / 2


def main():
    out = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 512
    rng = np.random.default_rng(int(sys.argv[3]) if len(sys.argv) > 3 else 11)
    base = np.array([178, 206, 226], np.float32) / 255
    deep = np.array([120, 160, 196], np.float32) / 255
    cloud = fft_noise(n, rng, 1.6)
    c = np.clip((cloud - 0.35) * 1.6, 0, 1)[..., None]
    img = base[None, None, :] * (1 - 0.7 * c) + deep[None, None, :] * (0.7 * c)
    # Long frost streaks running one way.
    streak = fft_noise(n, rng, 1.4, aniso=(0.25, 2.5))
    img += (np.clip(streak - 0.6, 0, 1) * 0.16)[..., None]
    # Pressure cracks: bright lines on a warped Voronoi net, a soft glow either side.
    wx = (fft_noise(n, rng, 2.2) - 0.5) * n * 0.06
    wy = (fft_noise(n, rng, 2.2) - 0.5) * n * 0.06
    e = voronoi_edges(n, 9, rng, (wx, wy))
    # Not a closed net: whole stretches of crack fade out.
    keep = np.clip((fft_noise(n, rng, 2.0) - 0.3) * 2.5, 0, 1)
    line = np.exp(-(e / 1.0) ** 2) * keep * 0.8
    glow = np.exp(-(e / 6.0) ** 2) * 0.22 * keep
    img = img * (1 - glow[..., None] * 0.2) + (glow * 0.55)[..., None]
    img = img * (1 - line[..., None]) + np.array([0.94, 0.97, 1.0])[None, None, :] * line[..., None]
    # Hairline cracks: a finer net, only visible in patches.
    e2 = voronoi_edges(n, 40, rng, (wx * 0.6, wy * 0.6))
    mask = np.clip((fft_noise(n, rng, 1.8) - 0.45) * 3, 0, 1)
    hair = np.exp(-(e2 / 0.7) ** 2) * mask
    img = img * (1 - 0.35 * hair[..., None]) + (0.35 * hair)[..., None] * np.array([0.85, 0.92, 0.98])[None, None, :]
    # Trapped bubbles.
    for _ in range(140):
        x, y = rng.random(2) * n
        r = rng.uniform(0.8, 2.2)
        yy, xx = np.ogrid[0:n, 0:n]
        dx = np.minimum(np.abs(xx - x), n - np.abs(xx - x))
        dy = np.minimum(np.abs(yy - y), n - np.abs(yy - y))
        b = np.clip(1 - np.sqrt(dx * dx + dy * dy) / r, 0, 1) * 0.5
        img = img * (1 - b[..., None]) + b[..., None]
    # Fine grain so it isn't plastic.
    img += ((rng.random((n, n)) - 0.5) * 0.025)[..., None]
    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).save(out)


if __name__ == "__main__":
    main()
