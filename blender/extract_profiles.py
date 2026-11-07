#!/usr/bin/env python3
"""Measures the reference drawing so the 3D model follows it, instead of eyeballing.

    python3 blender/extract_profiles.py      -> blender/reference_profiles.json

Writes, in Blender units (1 BU = 500 px, x right, z up, face looks to -Y):
  hair_top(x)     top silhouette of the hair
  hair_bottom(x)  front hairline / fringe edge (lobes + parting notch) and sideburns
  face_half(z)    half-width of the face per height
  nose            bbox + half-width per height of the nose
  cowlick         bounding boxes of the two tufts above the hair line
"""
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
img = np.asarray(Image.open(os.path.join(ROOT, 'docs', 'reference.jpg')).convert('RGB')).astype(np.int32)
H, W, _ = img.shape


def near(hex_, tol):
    c = np.array([int(hex_[i:i + 2], 16) for i in (0, 2, 4)])
    return np.sqrt(((img - c) ** 2).sum(-1)) < tol


dark = near('363636', 45)
skin = near('ffb59c', 26) | near('feaf9e', 26) | near('e5a991', 20)
nose = near('f58476', 30)

# Reference frame: face edges and vertical anchors measured on the drawing
rows = np.arange(H)
face_rows = [y for y in range(1100, 1180) if skin[y].any()]
xs = np.nonzero(skin[1140])[0]
cx = (xs.min() + xs.max()) / 2           # face centre (column)
top_y = np.nonzero(dark.any(axis=1))[0].min()  # top of the hair (row)
Z_TOP = 2.45                              # hair top in BU (chin ends ~1.06)


def bx(px):
    return round(float((px - cx) / 500), 4)


def bz(py):
    return round(float(Z_TOP - (py - top_y) / 500), 4)


def smooth(v, k=5):
    v = np.asarray(v, float)
    pad = np.pad(v, k, mode='edge')
    return np.convolve(pad, np.ones(2 * k + 1) / (2 * k + 1), mode='same')[k:-k]


# ---- hair: per column, first dark row (top) and end of that dark run (hairline)
glasses_top = 925  # rows below this are the glasses frame, not hair
cols, tops, bots = [], [], []
for x in range(int(cx - 290), int(cx + 290)):
    col = dark[:glasses_top, x]
    ys = np.nonzero(col)[0]
    if not len(ys):
        continue
    y0 = ys.min()
    y = y0
    while y + 1 < glasses_top and col[y + 1]:
        y += 1
    cols.append(x)
    tops.append(y0)
    bots.append(y)
tops_s, bots_s = smooth(tops, 4), smooth(bots, 6)  # fringe: keep the lobes and notches, drop pixel noise
step = max(1, len(cols) // 48)
hair_top = [[bx(cols[i]), bz(tops_s[i])] for i in range(0, len(cols), step)]
hair_bottom = [[bx(cols[i]), bz(bots_s[i])] for i in range(0, len(cols), step)]

# ---- cowlick: dark blobs above the main hair outline on the left
cow = dark[:top_y + 140, :int(cx)]
ys, xs = np.nonzero(cow)
cowlick = {'x0': bx(xs.min()), 'x1': bx(int(cx) - 120), 'z0': bz(top_y + 140), 'z1': bz(ys.min())}

# ---- face half width per height (skip ear rows: interpolate across them)
face_half = []
for y in range(880, 1300, 10):
    xs = np.nonzero(skin[y, int(cx - 300):int(cx + 300)])[0]
    if len(xs) < 10:
        continue
    left, right = xs.min() + cx - 300, xs.max() + cx - 300
    half = (right - left) / 2 / 500
    face_half.append([bz(y), round(float(half), 4)])
ears = [p for p in face_half if 1.46 < p[0] < 1.76]
if ears:
    lo = [p for p in face_half if p[0] <= 1.46]
    hi = [p for p in face_half if p[0] >= 1.76]
    a, b = (hi[-1] if hi else ears[0]), (lo[0] if lo else ears[-1])
    for p in ears:
        k = (a[0] - p[0]) / max(1e-6, a[0] - b[0])
        p[1] = round(a[1] + (b[1] - a[1]) * k, 4)

# ---- nose
ys, xs = np.nonzero(nose[900:1200, int(cx - 150):int(cx + 150)])
ys, xs = ys + 900, xs + int(cx - 150)
nose_rows = []
for y in range(ys.min(), ys.max() + 1, 4):
    r = xs[ys == y]
    if len(r):
        nose_rows.append([bz(y), round(float((r.max() - r.min() + 1) / 2 / 500), 4), bx((r.max() + r.min()) / 2)])
nose_info = {'x': bx(xs.mean()), 'z_top': bz(ys.min()), 'z_bottom': bz(ys.max()),
             'half_width_max': round(float((xs.max() - xs.min() + 1) / 2 / 500), 4), 'rows': nose_rows}

out = {'units': '1 BU = 500 px', 'centre_px': float(cx), 'top_px': int(top_y),
       'hair_top': hair_top, 'hair_bottom': hair_bottom, 'cowlick': cowlick,
       'face_half': face_half, 'nose': nose_info}
path = os.path.join(ROOT, 'blender', 'reference_profiles.json')
with open(path, 'w') as fh:
    json.dump(out, fh, indent=1)
print('hair x range', hair_top[0][0], hair_top[-1][0])
print('hair top z  ', min(p[1] for p in hair_top), '..', max(p[1] for p in hair_top))
print('hairline z  ', min(p[1] for p in hair_bottom), '..', max(p[1] for p in hair_bottom))
print('face half   ', face_half[0], face_half[len(face_half) // 2], face_half[-1])
print('nose        ', {k: v for k, v in nose_info.items() if k != 'rows'})
print('cowlick     ', cowlick)
