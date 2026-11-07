#!/usr/bin/env python3
"""Compares docs/fit_check.png (left: drawing, right: ortho model render, both
at 500 px/BU, origin x=-0.8, z=2.6) feature by feature. Prints BU deltas."""
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
im = np.asarray(Image.open(os.path.join(ROOT, 'docs', 'fit_check.png')).convert('RGB')).astype(int)
ref, mod = im[:, :800], im[:, 800:]


def m(img, hex_, tol):
    c = np.array([int(hex_[i:i + 2], 16) for i in (0, 2, 4)])
    return np.sqrt(((img - c) ** 2).sum(-1)) < tol


def X(px):
    return round(px / 500 - 0.8, 3)


def Z(py):
    return round(2.6 - py / 500, 3)


def row(z):
    return int(round((2.6 - z) * 500))


def bbox(mask):
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    return {'x0': X(xs.min()), 'x1': X(xs.max()), 'z_top': Z(ys.min()), 'z_bot': Z(ys.max())}


out = {}
for name, img in (('dibujo', ref), ('modelo', mod)):
    d = {}
    dark = m(img, '363636', 60)
    g = dark.copy()
    g[:row(1.86)] = False
    g[row(1.38):] = False
    d['gafas'] = bbox(g)
    nm = m(img, 'f58476', 26)
    nm[:row(1.62)] = False
    nm[row(1.3):] = False
    nm[:, :int((0.65) * 500)] = False   # x < -0.15
    nm[:, int((0.95) * 500):] = False   # x > 0.15
    d['nariz'] = bbox(nm)
    ys, xs = np.nonzero(nm)
    if len(ys):
        widest = max(range(ys.min(), ys.max() + 1), key=lambda r: (ys == r).sum())
        d['nariz']['z_mas_ancha'] = Z(widest)
        d['nariz']['ancho_max'] = round((ys == widest).sum() / 500, 3)
    # glasses: dark runs along the lens centre row (frame edges)
    r = dark[row(1.62)]
    runs, start = [], None
    for i, v in enumerate(list(r) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append([X(start), X(i - 1)])
            start = None
    d['gafas_fila_1.62'] = runs
    col = dark[:, int(round((0.25 + 0.8) * 500))]
    rs, start = [], None
    for i, v in enumerate(list(col) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            rs.append([Z(start), Z(i - 1)])
            start = None
    d['gafas_col_0.25'] = [x for x in rs if 1.35 < x[0] < 1.9]
    sil = ~m(img, 'ffffff', 30)
    d['ancho_cara'] = {}
    for z in (1.9, 1.3, 1.2, 1.12):
        xs = np.nonzero(sil[row(z)])[0]
        d['ancho_cara'][z] = [X(xs.min()), X(xs.max())] if len(xs) else None
    hairline = {}
    for x in (-0.4, -0.25, -0.12, 0.0, 0.15, 0.3):
        col = dark[:row(1.75), int(round((x + 0.8) * 500))]
        ys = np.nonzero(col)[0]
        if len(ys):
            y = ys.min()
            while y + 1 < len(col) and col[y + 1]:
                y += 1
            hairline[x] = Z(y)
    d['linea_pelo'] = hairline
    tops = {}
    for x in (-0.5, -0.3, 0.0, 0.3, 0.5):
        ys = np.nonzero(dark[:, int(round((x + 0.8) * 500))])[0]
        tops[x] = Z(ys.min()) if len(ys) else None
    d['tope_pelo'] = tops
    out[name] = d
print(json.dumps(out, indent=1, ensure_ascii=False))
