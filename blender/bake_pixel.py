"""Pixel-art version of Jose, baked with the Pixel Sprite Forge add-on.

    python3 blender/bake_pixel.py [--psf ../pixel-sprite-forge] [--quick]
    blender -b --factory-startup --python blender/bake_pixel.py -- [--psf PATH]

Builds the same quad model as build_character.py (same toon look-dev), rigs a
2-second idle (breathing, looking around, a small nod) and bakes it in
8 directions with the add-on (https://github.com/Jlpineda12/pixel-sprite-forge):
128x128 virtual pixels, Jose's own 17-colour palette (assets/pixel/jose.hex),
no dithering (clean cel clusters), adaptive outline, normal map, Godot/Phaser metadata and
one GIF per direction. Output: docs/pixel/.
"""
import importlib.util
import math
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
PSF = os.path.abspath(ARGS[ARGS.index('--psf') + 1]) if '--psf' in ARGS else \
    os.path.join(os.path.dirname(ROOT), 'pixel-sprite-forge')
QUICK = '--quick' in ARGS
OUT = os.path.join(ROOT, 'docs', 'pixel')

sys.argv = [sys.argv[0], '--', '--no-export']
spec = importlib.util.spec_from_file_location('bc', os.path.join(ROOT, 'blender', 'build_character.py'))
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)

import bpy  # noqa: E402

if not os.path.isdir(os.path.join(PSF, 'pixel_sprite_forge')):
    sys.exit(f'No encuentro el add-on en {PSF} (usa --psf /ruta/a/pixel-sprite-forge)')
sys.path.insert(0, PSF)
import pixel_sprite_forge as psf  # noqa: E402

HEAD_PARTS = ('Head', 'FaceCanvas', 'Hair', 'Cowlick', 'Ear', 'EarInner', 'Nose', 'Frame', 'Temple',
              'Hinge', 'Rivet', 'Lens', 'Bridge')


def rig_idle(objs, frames=24):
    """Root empty (breathing) + neck pivot (head motion), keyed for a seamless loop."""
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = 1, frames
    root = bpy.data.objects.new('Jose', None)
    bc.link(root)
    neck = bpy.data.objects.new('NeckPivot', None)
    bc.link(neck)
    neck.location = (0, 0, 1.12)
    neck.parent = root
    bpy.context.view_layer.update()      # parents' world matrices must be current before re-parenting
    for name, ob in objs.items():
        head = name.split('.')[0] in HEAD_PARTS
        parent = neck if head else root
        mw = ob.matrix_world.copy()
        ob.parent = parent
        ob.matrix_world = mw
    bpy.context.view_layer.update()
    for f in range(1, frames + 1):
        t = (f - 1) / frames * 2 * math.pi          # one full cycle -> loops cleanly
        root.location = (0, 0, 0.012 * math.sin(t))
        root.keyframe_insert('location', frame=f)
        neck.rotation_euler = (math.radians(3.0 * math.sin(2 * t)),     # nod
                               math.radians(2.5 * math.sin(t + 0.6)),    # tilt
                               math.radians(9.0 * math.sin(t)))          # look left / right
        neck.keyframe_insert('rotation_euler', frame=f)
    return root


def main():
    objs = bc.build()
    bc.FACE_BOLD = 2.2      # mouth / eyelid strokes must survive 128 px
    tex_path = bc.look_dev(objs)
    for side in ('L', 'R'):
        objs[f'Lens.{side}'].hide_render = True
    root = rig_idle(objs)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    if hasattr(sc, 'eevee'):
        sc.eevee.taa_render_samples = 8
    psf.register()
    s = sc.pixel_forge
    s.target = root
    s.directions = '8'
    s.camera_view = 'CUSTOM'
    s.elevation = 8
    s.facing = 'NEG_Y'
    s.resolution = '128'
    s.fit_padding = 0.03
    s.supersample = '4'
    s.downsample_mode = 'AVERAGE'
    s.palette = 'FILE'
    s.palette_file = os.path.join(ROOT, 'assets', 'pixel', 'jose.hex')
    s.dither = 'NONE'                    # toon bands are already flat: clean clusters, no noise
    s.saturation, s.contrast = 1.0, 1.0
    s.outline = 'OUTER'
    s.outline_adaptive = True
    s.anim_source = 'SCENE'
    s.scene_anim_name = 'idle'
    s.frame_step = 6 if QUICK else 3
    s.fps = 4 if QUICK else 8
    s.layout = 'GRID'
    s.export_json = s.export_godot = True
    s.export_normals = not QUICK
    s.export_gifs = True
    s.gif_scale = 3
    s.output_dir = OUT + os.sep
    s.base_name = 'jose'
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    res = bpy.ops.pixel_forge.bake()
    os.remove(tex_path)
    print('bake', res, sorted(os.listdir(OUT)))
    turnaround()


def turnaround():
    """docs/pixel/jose_turnaround.gif: the 8 directions in a row, animated, x3."""
    import json

    from PIL import Image
    doc = json.load(open(os.path.join(OUT, 'jose.json')))
    sheet = Image.open(os.path.join(OUT, 'jose.png')).convert('RGBA')
    order = ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW']
    by = {}
    for key, f in doc['frames'].items():
        d = key.split('_')[1] if key.count('_') >= 2 else key.split('_')[0]
        by.setdefault(d, []).append((key, f))
    n = min(len(v) for v in by.values())
    cw, ch = next(iter(doc['frames'].values()))['sourceSize'].values()
    frames = []
    for i in range(n):
        im = Image.new('RGBA', (cw * 8, ch), (246, 241, 231, 255))
        for j, d in enumerate(order):
            key, f = sorted(by[d])[i]
            fr, src = f['frame'], f['spriteSourceSize']
            crop = sheet.crop((fr['x'], fr['y'], fr['x'] + fr['w'], fr['y'] + fr['h']))
            im.alpha_composite(crop, (j * cw + src['x'], src['y']))
        frames.append(im.convert('RGB').resize((cw * 8 * 2, ch * 2), Image.NEAREST))
    frames[0].save(os.path.join(OUT, 'jose_turnaround.gif'), save_all=True, append_images=frames[1:],
                   duration=int(1000 / bpy.context.scene.pixel_forge.fps), loop=0, optimize=False)
    print('turnaround ok', len(frames), 'frames')


main()
