"""Builds the stylized 3D version of the character from docs/reference.jpg.

    python3 blender/extract_profiles.py                     # measure the drawing (once)
    blender -b --factory-startup --python blender/build_character.py -- [--render]

Modeling rules
  * Every mesh is built from quad primitives (cube-spheres mapped to
    superellipsoids, a lofted hair shell, tubes for the glasses) + one level of
    subdivision: clean all-quad topology, low polygon count. The script checks
    it at the end (no triangles, no n-gons) and prints a polygon report.
  * Shapes follow silhouettes measured from the drawing
    (blender/reference_profiles.json): hair top + fringe line, face width, nose.
  * Eyes and mouth are NOT modeled: they are drawn procedurally on a 2D "face
    canvas" wrapped on the face (2D animation on a 3D head).

Outputs
  assets/models/jose.glb    meshes + morph targets (cheeks_up, squash)
  assets/models/face.json   UV layout of the face canvas (eyes, mouth) + palette
  docs/blender_render*.png  flat toon verification renders + ortho fit check (--render)

Units: 1 BU = 500 px of the drawing. Face looks towards -Y.
"""
import json
import math
import os
import sys

import bpy  # noqa: I001  (bpy must be imported before bmesh in the pip module)
import bmesh
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PROFILE = json.load(open(os.path.join(ROOT, 'blender', 'reference_profiles.json')))

PALETTE = {
    'Skin': 'ffb59c', 'SkinShadow': 'e5a991', 'EarInner': 'e9a193', 'Nose': 'f58476',
    'Neck': 'ffb59c', 'Hair': '363636', 'Glasses': '353736', 'Rivet': 'ffb8a8', 'Shirt': '9b322c',
    'Mouth': 'aa2923', 'Pupil': '363636', 'EyeWhite': 'ffffff', 'Lens': 'ffffff',
}

FACE_FRONT_Y = -0.45
# measured on the drawing (blender/measure_fit.py): stroke centres, stroke 0.045 BU
LENS_W, LENS_H, LENS_Z, LENS_X, FRAME_R = 0.40, 0.246, 1.627, 0.24, 0.023
DECAL = dict(x0=-0.53, x1=0.53, z0=1.0, z1=1.95)


def srgb(hex_):
    c = [int(hex_[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c) + (1.0,)


def interp(points, x):
    """Piecewise-linear lookup in [[x, y], ...] (sorted or not)."""
    pts = sorted(points)
    if x <= pts[0][0]:
        return pts[0][1]
    if x >= pts[-1][0]:
        return pts[-1][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return y0 + (y1 - y0) * (x - x0) / max(1e-9, x1 - x0)
    return pts[-1][1]


def material(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    if not getattr(m, 'use_nodes', True):
        m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    if p:
        p.inputs['Base Color'].default_value = srgb(PALETTE[name])
        p.inputs['Roughness'].default_value = 0.8
    m.diffuse_color = srgb(PALETTE[name])
    return m


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def to_object(name, bm, mat, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    me.materials.append(material(mat))
    for poly in me.polygons:
        poly.use_smooth = smooth
    return ob


def subdivide(ob, levels=1):
    mod = ob.modifiers.new('Subdivision', 'SUBSURF')
    mod.levels = mod.render_levels = levels
    return ob


def apply_all(ob):
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    for mod in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)


# ---------------------------------------------------------------------------
# Quad primitives
# ---------------------------------------------------------------------------
def cube_sphere(n):
    """All-quad sphere: cube with an n×n grid per face, projected to the unit sphere."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    if n > 1:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=n - 1, use_grid_fill=True)
    for v in bm.verts:
        v.co = v.co.normalized()
    return bm


def superellipsoid(name, center, radii, mat, power=2.0, n=3, rot=None, shape=None, comp=1.0):
    """Quad cube-sphere mapped onto |x/a|^p + |y/b|^p + |z/c|^p = 1.
    `shape(local_co) -> local_co` lets a part be sculpted procedurally."""
    bm = cube_sphere(n)
    a, b, c = (r * comp for r in radii)  # comp: pre-inflate low-res cages that subdivision will shrink
    for v in bm.verts:
        d = v.co
        s = ((abs(d.x) / a) ** power + (abs(d.y) / b) ** power + (abs(d.z) / c) ** power) ** (-1 / power)
        v.co = d * s
        if shape:
            v.co = shape(v.co)
    ob = to_object(name, bm, mat)
    ob.location = center
    if rot:
        ob.rotation_euler = rot
    return ob


def tube(name, points, radius, mat, cyclic=True, sides=6):
    """Quad tube along a polyline (glasses frames, temples, bridge)."""
    bm = bmesh.new()
    pts = [Vector(p) for p in points]
    rings = []
    count = len(pts)
    for i, p in enumerate(pts):
        prev = pts[i - 1] if (cyclic or i > 0) else p
        nxt = pts[(i + 1) % count] if (cyclic or i < count - 1) else p
        t = (nxt - prev).normalized()
        ref = Vector((0, 1, 0)) if abs(t.y) < 0.9 else Vector((1, 0, 0))
        u = t.cross(ref).normalized()
        w = t.cross(u).normalized()
        rings.append([bm.verts.new(p + (u * math.cos(k * 2 * math.pi / sides) + w * math.sin(k * 2 * math.pi / sides)) * radius)
                      for k in range(sides)])
    segs = count if cyclic else count - 1
    for i in range(segs):
        r0, r1 = rings[i], rings[(i + 1) % count]
        for k in range(sides):
            bm.faces.new((r0[k], r0[(k + 1) % sides], r1[(k + 1) % sides], r1[k]))
    return to_object(name, bm, mat)


def rounded_rect_path(cx, cz, w, h, y, side, r_top=0.035, r_bot_out=0.095, r_bot_in=0.075, bulge=0.012,
                      wrap=0.05, seg=5):
    """Lens outline like the drawing: a rounded rectangle (big rounded bottom
    corners, small top ones), slightly bulging edges, wrapped around the face
    (outer side further back)."""
    hw, hh = w / 2, h / 2
    o = 1 if side > 0 else -1          # outer side direction in x
    # corners: (centre_x, centre_z, radius, start_angle)
    corners = [
        (hw - r_top, hh - r_top, r_top, 0.0),                          # top-right
        (-hw + r_top, hh - r_top, r_top, math.pi / 2),                 # top-left
        (-hw + (r_bot_out if o < 0 else r_bot_in), -hh + (r_bot_out if o < 0 else r_bot_in),
         r_bot_out if o < 0 else r_bot_in, math.pi),                   # bottom-left
        (hw - (r_bot_out if o > 0 else r_bot_in), -hh + (r_bot_out if o > 0 else r_bot_in),
         r_bot_out if o > 0 else r_bot_in, 1.5 * math.pi),             # bottom-right
    ]
    pts = []
    for ccx, ccz, r, a0 in corners:
        for k in range(seg + 1):
            a = a0 + (math.pi / 2) * k / seg
            pts.append((ccx + r * math.cos(a), ccz + r * math.sin(a)))
    out = []
    for x, z in pts:
        # bulge the straight edges outward a little (hand-drawn curvature)
        bx = bulge * math.cos(math.pi * z / (2 * hh)) * (1 if x > 0 else -1) * (abs(x) > hw - 0.02)
        bz = bulge * math.cos(math.pi * x / (2 * hw)) * (1 if z > 0 else -1) * (abs(z) > hh - 0.02)
        X, Z = x + bx, z + bz
        u = (X * o + hw) / w            # 0 inner .. 1 outer
        out.append((cx + X, y + wrap * u * u, cz + Z))
    return out


# ---------------------------------------------------------------------------
# Parts
# ---------------------------------------------------------------------------
def face_half_width(z):
    """Measured face half width (the hair hides the forehead sides)."""
    pts = [p for p in PROFILE['face_half'] if p[0] < 1.45]
    return 0.54 if z >= max(p[0] for p in pts) else interp(pts, z)


def build_head():
    """Superellipsoid with p=4: its width per height reproduces the measured
    face (0.53 / 0.49 / 0.43 at z 1.3 / 1.2 / 1.12 vs 0.537 / 0.496 / 0.42)."""
    zc, rz, ry, a, p = 1.67, 0.62, 0.45, 0.545, 4.0

    def shape(co):
        z = co.z + zc
        if z > 1.95:   # lower the cranium: it lives under the hair and must never poke through
            co = Vector((co.x, co.y, 1.95 - zc + (z - 1.95) * 0.55))
        return co
    head = superellipsoid('Head', (0, 0, zc), (a, ry, rz), 'Skin', power=p, n=4, comp=1.03, shape=shape)
    subdivide(head, 1)
    apply_all(head)
    return head


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def build_hair():
    """Full hair helmet that covers the whole cranium.

    Topology: the upper half of an n×n cube-sphere (4 side faces × rows + the
    top face) -> all quads, no poles. Each vertex gets an azimuth θ (0 = front)
    and a height h (0 = hairline, 1 = crown). The hairline follows the drawing:
    fringe lobes + parting notches at the front, sideburns down to the glasses,
    just above the ears on the sides and the nape at the back. The front
    silhouette is then re-fitted to the measured hair top.
    """
    # sideburns run down to mid-ear height (z 1.61) at the face edges
    EAR_MID, EAR_TOP = 1.61, 1.76

    def sideburn(x, z):
        return z if abs(x) <= 0.42 else z + (EAR_MID - z) * smoothstep(0.42, 0.5, abs(x))
    fringe = [[x, sideburn(x, 1.79 if abs(x) > 0.42 else z)] for x, z in PROFILE['hair_bottom']]
    fringe += [[-0.6, EAR_MID], [0.6, EAR_MID]]
    top = []
    for x, z in PROFILE['hair_top']:            # cowlick bump removed: tufts are separate
        if -0.47 < x < -0.24:
            k = (x + 0.47) / 0.23
            z = 2.2 + (2.355 - 2.2) * (1 - (1 - k) ** 2)
        top.append([x, z])
    n, row_b = 20, 8                              # grid per face, hairline row on the side faces
    z_apex, cy = 2.47, 0.02
    rx, ry_front, ry_back, q, pz = 0.6, 0.485, 0.53, 3.0, 2.2

    def footprint(th):
        sx, sy = math.sin(th), -math.cos(th)
        ry = ry_front if sy < 0 else ry_back
        r = 1 / ((abs(sx) / rx) ** q + (abs(sy) / ry) ** q) ** (1 / q)
        return r * sx, r * sy

    def hairline(th):
        fx, _ = footprint(th)
        a = abs(math.degrees(th))
        front = interp(fringe, fx)
        # sides: down to mid-ear in front of and behind the ear, arching over it
        ear = 1 - smoothstep(9, 17, abs(a - 92))
        # nape: rounded, lowest at the centre, rising behind the ears
        back_c = 1 - (180 - a) / 50                    # 1 at the back centre, 0 at 130°
        back = 1.58 - 0.2 * max(0.0, back_c) ** 0.7
        side = EAR_MID + (EAR_TOP + 0.02 - EAR_MID) * ear
        w_side = smoothstep(45, 62, a) * (1 - smoothstep(118, 145, a))
        w_back = smoothstep(118, 145, a)
        w_front = 1 - w_side - w_back
        return front * w_front + side * w_side + back * w_back

    fr_vals = [z for x, z in fringe if abs(x) < 0.42]
    fr_lo, fr_hi = min(fr_vals), max(fr_vals)

    def locks(p, th, h):
        """Natural hair volume: clumps that start at each fringe lobe and fan out
        from the parting towards the crown (the notches become grooves between
        locks), plus soft waves on the sides and the back."""
        a = abs(math.degrees(th))
        out = Vector((p.x, p.y - cy, 0.0))
        out = out.normalized() if out.length > 1e-6 else Vector((0, -1, 0))
        w_front = 1 - smoothstep(40, 75, a)
        xs = p.x + (p.x + 0.25) * 0.4 * h               # locks diverge from the parting going up
        lobe = (fr_hi - interp(fringe, xs)) / max(1e-6, fr_hi - fr_lo)   # 1 = lobe, 0 = notch
        # locks: strongest a little above the hairline (no visor over the forehead)
        rise = smoothstep(0.0, 0.18, h)
        fringe_vol = w_front * lobe ** 1.5 * 0.05 * rise * (1 - h) ** 0.9
        wave = (1 - w_front) * 0.02 * (1 - h) ** 1.2 * (0.5 + 0.5 * math.cos(th * 7 + 3.5 * h))
        # shaped masses from the drawing: left lobe, right "hump" (with the dip
        # between it and the dome), round crown and occiput
        lumps = 0.0
        for c, r, amp in (((-0.47, -0.05, 2.12), 0.2, 0.045), ((0.43, -0.12, 2.24), 0.17, 0.05),
                          ((0.0, 0.05, 2.42), 0.28, 0.035), ((0.0, 0.42, 1.95), 0.3, 0.04),
                          ((0.3, -0.25, 2.31), 0.07, -0.025)):
            d2 = (p - Vector(c)).length_squared
            lumps += amp * math.exp(-d2 / (r * r))
        # parting groove running back from the notch at x = -0.25
        groove = -0.02 * math.exp(-((p.x + 0.25 + 0.1 * h) ** 2) / 0.0025) * smoothstep(0.05, 0.3, h) * (1 - h)
        radial = (p - Vector((0, cy, 1.75))).normalized()
        return out * (fringe_vol + wave) + radial * (lumps + groove) + Vector((0, 0, -0.15 * fringe_vol))

    bm = cube_sphere(n)                           # unit sphere, cube topology
    eps = 1e-4
    zb_cube = -1 + 2 * row_b / n
    # recover cube coordinates (projection back onto the cube) to get (θ, h)
    for v in bm.verts:
        d = v.co
        m = max(abs(d.x), abs(d.y), abs(d.z))
        c = d / m
        th = math.atan2(c.x, -c.y)
        if abs(c.z - 1) < 1e-6:                   # top face
            h = 0.5 + 0.5 * (1 - max(abs(c.x), abs(c.y)))
        else:                                     # side faces
            h = 0.5 * (c.z - zb_cube) / (1 - zb_cube)
        h = max(0.0, h)
        lam = h * math.pi / 2
        fx, fy = footprint(th)
        horiz = max(0.0, math.cos(lam)) ** (2 / pz)
        zb = hairline(th)
        z = zb + (z_apex - zb) * max(0.0, math.sin(lam)) ** (2 / pz)
        p = Vector((fx * horiz, fy * horiz + cy, z))
        v.co = p + locks(p, th, h)
        v.tag = h <= eps
    # drop everything below the hairline row (cube rows < row_b)
    bottom = [f for f in bm.faces if all(v.tag for v in f.verts) or
              sum(1 for v in f.verts if v.co.z < hairline(math.atan2(v.co.x, -(v.co.y - cy))) - 1e-6) > 0]
    bmesh.ops.delete(bm, geom=bottom, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    # curled tips: two inward extrusions of the hairline (roll under, then up
    # towards the skull) give the edge a rounded, natural thickness
    for inward, lift in ((0.022, -0.012), (0.035, 0.04)):
        edges = [e for e in bm.edges if e.is_boundary]
        ext = bmesh.ops.extrude_edge_only(bm, edges=edges)
        for v in [e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)]:
            d = Vector((v.co.x, v.co.y - cy, 0.0))
            v.co = v.co - d.normalized() * inward + Vector((0, 0, lift))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    hair = to_object('Hair', bm, 'Hair')
    # re-fit the front silhouette (max z per x) to the measured hair top
    # (one scale factor per x, smoothed across x so the crown stays ripple-free)
    zb = 1.62
    bins = {}
    for v in hair.data.vertices:
        bins.setdefault(round(v.co.x * 25), []).append(v.co.z)
    keys = sorted(bins)
    raw = [min(1.25, max(0.8, (interp(top, k / 25) - zb) / max(1e-3, max(bins[k]) - zb))) for k in keys]
    fac = []
    for i in range(len(keys)):
        win = raw[max(0, i - 1):i + 2]
        fac.append([keys[i] / 25, sum(win) / len(win)])
    for v in hair.data.vertices:
        if v.co.z > zb:
            v.co.z = zb + (v.co.z - zb) * interp(fac, v.co.x)
    # no subdivision: the 16×16 grid already gives a smooth dome with smooth
    # shading, and keeps the fringe lobes and notches crisp
    return hair


def build_cowlick():
    """Two leaf-shaped tufts on the top-left, as in the drawing."""
    tufts = []
    for name, c, r, ry, bend in (('Cowlick.A', (-0.30, -0.02, 2.31), (0.055, 0.04, 0.1), 18, 0.05),
                                 ('Cowlick.B', (-0.405, -0.02, 2.25), (0.085, 0.04, 0.05), -12, -0.04)):
        def shape(co, rr=r, bend=bend):
            # leaf profile: pinched tip that curls sideways
            t = max(0.0, co.z / (rr[2] * 1.15))
            return Vector((co.x * (1 - 0.7 * t) + bend * t * t, co.y * (1 - 0.4 * t), co.z * (1 + 0.25 * t)))
        ob = superellipsoid(name, c, r, 'Hair', power=2.0, n=2, rot=(0, math.radians(ry), 0), shape=shape, comp=1.15)
        subdivide(ob, 1)
        apply_all(ob)
        tufts.append(ob)
    return tufts


def build_nose():
    """Drop shape driven by the measured per-row width of the drawn nose."""
    nz = PROFILE['nose']
    top, bot = 1.56, 1.375
    rows = [(z, w) for z, w, _ in nz['rows'] if bot <= z <= top]
    rows = [(bot, 0.0)] + rows + [(top, 0.0)]
    zc = (top + bot) / 2
    hz = (top - bot) / 2
    wmax = max(w for _, w in rows)

    def shape(co):
        z = co.z + zc
        k = interp(rows, z) / wmax
        k = max(k, 0.12)
        bulge = 1.0 + 0.25 * max(0.0, 1 - (z - bot) / (top - bot) * 1.6)  # rounder tip at the bottom
        return Vector((co.x * k, co.y * min(1.0, k * 1.15) * bulge, co.z))
    # in the drawing the nose sits in front of the frames, between the lenses
    nose = superellipsoid('Nose', (nz['x'], FACE_FRONT_Y - 0.08, zc), (wmax * 1.22, 0.07, hz), 'Nose', power=2.2, n=2,
                          shape=shape, comp=1.08)
    subdivide(nose, 1)
    apply_all(nose)
    return nose


def build_ears():
    out = []
    for side, tag in ((-1, 'R'), (1, 'L')):
        ear = superellipsoid(f'Ear.{tag}', (side * 0.6, 0.03, 1.61), (0.085, 0.06, 0.13), 'Skin', power=2.2, n=2, comp=1.1)
        inner = superellipsoid(f'EarInner.{tag}', (side * 0.565, -0.02, 1.6), (0.035, 0.045, 0.105), 'EarInner',
                               power=2.0, n=1, comp=1.25)
        for ob in (ear, inner):
            subdivide(ob, 1)
            apply_all(ob)
        out += [ear, inner]
    return out


def build_glasses():
    gy = FACE_FRONT_Y - 0.075
    out = []
    for side, tag in ((-1, 'R'), (1, 'L')):
        out.append(tube(f'Frame.{tag}', rounded_rect_path(side * LENS_X, LENS_Z, LENS_W, LENS_H, gy, side), FRAME_R,
                        'Glasses', cyclic=True, sides=6))
        # hinge block at the top outer corner (carries the rivet), as drawn
        hx = side * (LENS_X + LENS_W / 2 + 0.035)
        hinge = superellipsoid(f'Hinge.{tag}', (hx, gy + 0.045, LENS_Z + LENS_H / 2 - 0.03), (0.05, 0.03, 0.035), 'Glasses',
                               power=4.0, n=1, comp=1.2)
        subdivide(hinge, 1)
        apply_all(hinge)
        out.append(hinge)
        out.append(tube(f'Temple.{tag}', [(hx + side * 0.03, gy + 0.065, 1.71), (side * 0.55, gy + 0.14, 1.71),
                                          (side * 0.58, 0.02, 1.68)], 0.017, 'Glasses', cyclic=False, sides=6))
        rv = superellipsoid(f'Rivet.{tag}', (hx + side * 0.012, gy + 0.045 - 0.032, LENS_Z + LENS_H / 2 - 0.03),
                            (0.014, 0.008, 0.014), 'Rivet', n=1, comp=1.3)
        subdivide(rv, 1)
        apply_all(rv)
        out.append(rv)
        bm = bmesh.new()
        hw, hh = (LENS_W - 0.03) / 2, (LENS_H - 0.03) / 2
        vs = [bm.verts.new((side * LENS_X + x, gy + 0.004, LENS_Z + z)) for x, z in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh))]
        bm.faces.new(vs)
        lens = to_object(f'Lens.{tag}', bm, 'Lens', smooth=False)
        out.append(lens)
    out.append(tube('Bridge', [(-(LENS_X - LENS_W / 2) - 0.01, gy, LENS_Z + 0.025),
                               ((LENS_X - LENS_W / 2) + 0.01, gy, LENS_Z + 0.025)], FRAME_R, 'Glasses', cyclic=False, sides=6))
    return out


def build_body():
    def cylinder(name, radius, z0, z1, mat, sy=0.82):
        bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=radius, depth=z1 - z0, end_fill_type='NOTHING',
                                            location=(0, 0.06, (z0 + z1) / 2))
        ob = bpy.context.active_object
        ob.name = name
        ob.scale = (1.0, sy, 1.0)
        ob.data.materials.append(material(mat))
        for poly in ob.data.polygons:
            poly.use_smooth = True
        apply_all(ob)
        return ob
    neck = cylinder('Neck', 0.27, 0.62, 1.12, 'Neck')   # own material: it receives the head's shadow
    # no painted band: the head casts the shadow under the chin (Blender + web)

    def shape(co):
        return Vector((co.x, co.y, max(co.z, 0.0)))  # half dome: flat bust cut
    shirt = superellipsoid('Shirt', (0, 0.06, 0.55), (0.64, 0.36, 0.38), 'Shirt', power=2.0, n=4, shape=shape, comp=1.04)
    subdivide(shirt, 1)
    apply_all(shirt)
    return [neck, shirt]


def build_face_canvas(head):
    """The face canvas re-uses the head's own front quads (identical geometry,
    so it can never sink under the skin), pushed 3 mm out along the normals,
    with a planar UV projection from the front. Same morph targets as the head."""
    bm = bmesh.new()
    bm.from_mesh(head.data)
    bm.normal_update()
    w = DECAL['x1'] - DECAL['x0']
    h = DECAL['z1'] - DECAL['z0']
    zc = head.location.z
    keep = set()
    for f in bm.faces:
        c = f.calc_center_median()
        if c.y < -0.2 and DECAL['z0'] - zc <= c.z <= DECAL['z1'] - zc and f.normal.y < -0.3:
            keep.add(f)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in keep], context='FACES')
    for v in bm.verts:
        v.co = v.co + v.normal * 0.003
    uv = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        for loop in f.loops:
            co = loop.vert.co
            loop[uv].uv = ((co.x - DECAL['x0']) / w, (co.z + zc - DECAL['z0']) / h)
    face = to_object('FaceCanvas', bm, 'EyeWhite')
    face.location = head.location
    return face


def morph(co, zc):
    """Shape-key offsets shared by the head and the face canvas (head-local coords)."""
    z = co.z + zc
    wgt = max(0.0, -co.y / 0.45) ** 2 * max(0.0, 1 - abs(z - 1.33) / 0.18) * min(1.0, abs(co.x) / 0.25)
    cheeks = co + Vector((math.copysign(0.015, co.x) * wgt, -0.02 * wgt, 0.035 * wgt))
    squash = Vector((co.x * 1.04, co.y * 1.02, co.z * 0.94))
    return cheeks, squash


def add_morphs(*objs):
    for ob in objs:
        ob.shape_key_add(name='Basis')
        cheeks = ob.shape_key_add(name='cheeks_up', from_mix=False)
        squash = ob.shape_key_add(name='squash', from_mix=False)
        for i, v in enumerate(ob.data.vertices):
            c, s_ = morph(v.co, ob.location.z)
            cheeks.data[i].co = c
            squash.data[i].co = s_


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    objs = {}
    head = build_head()
    objs['Head'] = head
    for ob in [build_hair()] + build_cowlick() + [build_nose()] + build_ears() + build_glasses() + build_body():
        objs[ob.name] = ob
    objs['FaceCanvas'] = build_face_canvas(head)
    add_morphs(head, objs['FaceCanvas'])
    report(objs)
    return objs


def report(objs):
    """Topology check: all quads, polygon budget."""
    total = tris = ngons = 0
    lines = []
    for name, ob in sorted(objs.items()):
        polys = ob.data.polygons
        t = sum(1 for p in polys if p.loop_total == 3)
        g = sum(1 for p in polys if p.loop_total > 4)
        total += len(polys)
        tris += t
        ngons += g
        lines.append(f'  {name:<14}{len(polys):>6} caras  {t} tri  {g} ngon')
    print('\n'.join(lines))
    print(f'TOTAL {total} caras · {tris} triángulos · {ngons} n-gons · {total * 2} tris al renderizar')
    with open(os.path.join(ROOT, 'docs', 'topology.json'), 'w') as fh:
        json.dump({'faces': total, 'triangles': tris, 'ngons': ngons,
                   'objects': {n: len(o.data.polygons) for n, o in objs.items()}}, fh, indent=1)
    assert tris == 0 and ngons == 0, 'la malla debe ser 100% quads'


def face_layout():
    w = DECAL['x1'] - DECAL['x0']
    h = DECAL['z1'] - DECAL['z0']

    def u(x):
        return round((x - DECAL['x0']) / w, 4)

    def v(z):
        return round((z - DECAL['z0']) / h, 4)
    inset = 0.035
    eyes = []
    for side in (-1, 1):
        cx = side * LENS_X
        eyes.append({'side': 'L' if side > 0 else 'R',
                     'u0': u(cx - LENS_W / 2 + inset), 'u1': u(cx + LENS_W / 2 - inset),
                     'v0': v(LENS_Z - LENS_H / 2 + inset), 'v1': v(LENS_Z + LENS_H / 2 - inset)})
    return {
        'decal': DECAL,
        'eyes': eyes,
        'mouth': {'u': u(0.01), 'v': v(1.19), 'w': round(0.24 / w, 4), 'h': round(0.22 / h, 4)},
        'palette': {k: '#' + v_ for k, v_ in PALETTE.items()},
    }


def export(objs):
    path = os.path.join(ROOT, 'assets', 'models', 'jose.glb')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objs.values():
        ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                              export_apply=True, export_morph=True, export_morph_normal=False,
                              export_yup=True, export_materials='EXPORT')
    with open(os.path.join(ROOT, 'assets', 'models', 'face.json'), 'w') as fh:
        json.dump(face_layout(), fh, indent=1)
    print('exported', path, os.path.getsize(path), 'bytes')


# ---------------------------------------------------------------------------
# Verification render: flat toon shading + 2D face texture (no outlines)
# ---------------------------------------------------------------------------
def toonify():
    for m in bpy.data.materials:
        if m.name not in PALETTE:
            continue
        base = srgb(PALETTE[m.name])
        shade = tuple(c * 0.86 for c in base[:3]) + (1,)
        if m.name in ('Skin', 'Neck'):  # the drawing's own shadow tone
            shade = srgb(PALETTE['SkinShadow'])
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        diff = nt.nodes.new('ShaderNodeBsdfDiffuse')
        s2r = nt.nodes.new('ShaderNodeShaderToRGB')
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.interpolation = 'CONSTANT'
        ramp.color_ramp.elements[0].color = shade
        # face stays flat and lit like the drawing; the neck gets the cast shadow
        ramp.color_ramp.elements[1].position = 0.05 if m.name == 'Skin' else 0.3
        ramp.color_ramp.elements[1].color = base
        if m.name == 'Hair':  # locks read through a deeper shadow and a soft highlight
            ramp.color_ramp.elements[0].color = tuple(c * 0.45 for c in base[:3]) + (1,)
            hi = ramp.color_ramp.elements.new(0.85)
            hi.color = tuple(min(1.0, c * 2.1) for c in base[:3]) + (1,)
        em = nt.nodes.new('ShaderNodeEmission')
        nt.links.new(diff.outputs[0], s2r.inputs[0])
        nt.links.new(s2r.outputs[0], ramp.inputs[0])
        nt.links.new(ramp.outputs[0], em.inputs[0])
        nt.links.new(em.outputs[0], out.inputs[0])


def face_texture(path, size=512):
    """Static drawing of the reference expression, used only for the Blender render."""
    import numpy as np
    lay = face_layout()
    img = np.zeros((size, size, 4), np.float32)
    yy, xx = np.mgrid[0:size, 0:size]
    u = (xx + 0.5) / size
    v = 1 - (yy + 0.5) / size

    def put(mask, hex_):
        c = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        img[mask] = (*c, 1)
    for e in lay['eyes']:
        inside = (u > e['u0']) & (u < e['u1']) & (v > e['v0']) & (v < e['v1'])
        put(inside, '#ffffff')
        lid = e['v0'] + (e['v1'] - e['v0']) * 0.62
        put(inside & (v > lid), lay['palette']['Skin'])
        cx = (e['u0'] + e['u1']) / 2 + 0.035
        r = (e['v1'] - e['v0']) * 0.36
        pupil = ((u - cx) ** 2 + ((v - lid) * 1.0) ** 2 < r * r) & (v < lid) & inside
        put(pupil, lay['palette']['Pupil'])
        put(inside & (abs(v - lid) < 0.006), '#2a2a2a')
    m = lay['mouth']
    x = (u - m['u']) / (m['w'] / 2)
    curve = m['v'] + 0.012 * np.sin(x * math.pi * 1.1 + 0.6) - 0.01 * x
    put((abs(x) < 1) & (abs(v - curve) < 0.011), lay['palette']['Mouth'])
    from bpy_extras.image_utils import load_image  # noqa: F401  (ensures image module ready)
    im = bpy.data.images.new('FaceTex', size, size, alpha=True)
    im.pixels.foreach_set(img[::-1].ravel())
    im.filepath_raw = path
    im.file_format = 'PNG'
    im.save()
    return im


def fit_check(sc, persp_cam):
    """Orthographic front render at 500 px/BU, compared with the drawing."""
    import numpy as np
    from PIL import Image
    ortho = link(bpy.data.objects.new('OrthoCam', bpy.data.cameras.new('OrthoCam')))
    ortho.data.type = 'ORTHO'
    ortho.data.ortho_scale = 2.0
    ortho.location = (0, -10, 1.6)
    ortho.rotation_euler = (math.radians(90), 0, 0)
    sc.camera = ortho
    sc.render.resolution_x, sc.render.resolution_y = 800, 1000
    gp = [o for o in sc.objects if o.type in {'GREASEPENCIL', 'GPENCIL'}]
    for o in gp:
        o.hide_render = True
    path = os.path.join(ROOT, 'docs', '_ortho.png')
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for o in gp:
        o.hide_render = False
    sc.camera = persp_cam
    sc.render.resolution_x, sc.render.resolution_y = 700, 1000
    model = np.asarray(Image.open(path).convert('RGB')).astype(int)
    ref = np.asarray(Image.open(os.path.join(ROOT, 'docs', 'reference.jpg')).convert('RGB')).astype(int)
    cx, top = PROFILE['centre_px'], PROFILE['top_px']
    # reference pixel of the ortho render's top-left corner (x=-0.8, z=2.6)
    x0 = int(round(cx - 0.8 * 500))
    y0 = int(round(top + (2.45 - 2.6) * 500))
    ref = ref[y0:y0 + 1000, x0:x0 + 800]
    pad = ((0, 1000 - ref.shape[0]), (0, 800 - ref.shape[1]), (0, 0))
    ref = np.pad(ref, pad, constant_values=255)

    def mask(img, hex_, tol, rows=None):
        c = np.array([int(hex_[i:i + 2], 16) for i in (0, 2, 4)])
        m = np.sqrt(((img - c) ** 2).sum(-1)) < tol
        if rows:
            r0, r1 = rows
            m[:r0], m[r1:] = False, False
        return m
    z_row = lambda z: int(round((2.6 - z) * 500))  # noqa: E731
    report = {}
    for name, hex_, tol, rows in (('pelo', '363636', 60, (0, z_row(1.80))),
                                  ('nariz', 'f58476', 26, (z_row(1.6), z_row(1.3))),
                                  ('silueta', 'ffffff', 30, None)):
        a, b = mask(model, hex_, tol, rows), mask(ref, hex_, tol, rows)
        if name == 'silueta':
            a, b = ~a, ~b
        inter, union = (a & b).sum(), (a | b).sum()
        ya, xa = np.nonzero(a)
        yb, xb = np.nonzero(b)
        shift = (float(np.hypot(xa.mean() - xb.mean(), ya.mean() - yb.mean())) / 500) if len(xa) and len(xb) else None
        report[name] = {'IoU': round(float(inter / max(union, 1)), 3),
                        'desfase_centroide_BU': round(shift, 3) if shift is not None else None}
    viz = np.full((1000, 1600, 3), 255, np.uint8)
    viz[:, :800] = ref.astype(np.uint8)
    viz[:, 800:] = model.astype(np.uint8)
    Image.fromarray(viz).save(os.path.join(ROOT, 'docs', 'fit_check.png'))
    os.remove(path)
    with open(os.path.join(ROOT, 'docs', 'fit_report.json'), 'w') as fh:
        json.dump(report, fh, indent=1, ensure_ascii=False)
    print('FIT', json.dumps(report, ensure_ascii=False))


def render(objs):
    sc = bpy.context.scene
    toonify()
    tex_path = os.path.join(ROOT, 'docs', '_face_static.png')
    face_texture(tex_path)
    fm = bpy.data.materials.new('FaceCanvasMat')
    if not getattr(fm, 'use_nodes', True):
        fm.use_nodes = True
    nt = fm.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(tex_path)
    tex.interpolation = 'Closest'
    em = nt.nodes.new('ShaderNodeEmission')
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(tex.outputs['Color'], em.inputs[0])
    nt.links.new(tex.outputs['Alpha'], mix.inputs[0])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])
    if hasattr(fm, 'surface_render_method'):
        fm.surface_render_method = 'BLENDED'
    objs['FaceCanvas'].data.materials[0] = fm
    for side in ('L', 'R'):
        objs[f'Lens.{side}'].hide_render = True

    world = bpy.data.worlds.new('Paper')
    world.color = (1, 1, 1)
    if not getattr(world, 'use_nodes', True):
        world.use_nodes = True
    wn = world.node_tree
    wn.nodes.clear()
    out_w = wn.nodes.new('ShaderNodeOutputWorld')
    lp = wn.nodes.new('ShaderNodeLightPath')
    paper = wn.nodes.new('ShaderNodeBackground')
    paper.inputs['Color'].default_value = (1, 1, 1, 1)
    amb = wn.nodes.new('ShaderNodeBackground')
    amb.inputs['Color'].default_value = (1, 1, 1, 1)
    amb.inputs['Strength'].default_value = 0.25
    mixw = wn.nodes.new('ShaderNodeMixShader')
    wn.links.new(lp.outputs['Is Camera Ray'], mixw.inputs[0])
    wn.links.new(amb.outputs[0], mixw.inputs[1])
    wn.links.new(paper.outputs[0], mixw.inputs[2])
    wn.links.new(mixw.outputs[0], out_w.inputs[0])
    sc.world = world
    for name, ob in objs.items():
        ob.visible_shadow = name == 'Head'
    for name in ('FaceCanvas', 'Lens.L', 'Lens.R'):
        if hasattr(objs[name], 'lineart'):
            objs[name].lineart.usage = 'EXCLUDE'
    bpy.ops.object.light_add(type='SUN', location=(2, -4, 5))
    sun = bpy.context.active_object
    sun.rotation_euler = (math.radians(50), math.radians(-8), math.radians(-12))  # ~40° high: shadow band under the chin as drawn
    sun.data.energy = 3.0
    cam = link(bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')))
    cam.location = (0, -7.6, 1.6)
    cam.rotation_euler = (math.radians(90), 0, 0)
    cam.data.lens = 85
    sc.camera = cam
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = 700, 1000
    sc.view_settings.view_transform = 'Standard'
    sc.render.film_transparent = False

    sc.render.filepath = os.path.join(ROOT, 'docs', 'blender_render.png')
    bpy.ops.render.render(write_still=True)
    fit_check(sc, cam)
    # 3/4 view: proves it is a real 3D volume, not a flat drawing
    pivot = bpy.data.objects.new('CamPivot', None)
    link(pivot)
    pivot.location = (0, 0, 1.6)
    cam.location = (0, -7.6, 0.0)
    cam.parent = pivot
    pivot.rotation_euler = (0, 0, math.radians(-35))
    sc.render.filepath = os.path.join(ROOT, 'docs', 'blender_render_34.png')
    bpy.ops.render.render(write_still=True)
    os.remove(tex_path)
    print('rendered', sc.render.filepath)


if __name__ == '__main__':
    built = build()
    if '--no-export' not in ARGS:
        export(built)
    if '--render' in ARGS:
        render(built)
