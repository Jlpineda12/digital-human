"""Renders the character from 4 angles (front, 3/4, side, back) into docs/turntable.png."""
import importlib.util
import math
import os
import sys

sys.argv = [sys.argv[0], '--', '--no-export']
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('bc', os.path.join(HERE, 'build_character.py'))
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)

import bpy  # noqa: E402

objs = bc.build()
bc.render.__globals__['fit_check'] = lambda *a, **k: None  # skip fit check here
os.remove = (lambda f: (lambda p: None if p.endswith('_face_static.png') else f(p)))(os.remove)
bc.render(objs)
sc = bpy.context.scene
cam = sc.camera
pivot = cam.parent
frames = []
for i, ang in enumerate((0, -40, -90, 180)):
    pivot.rotation_euler = (0, 0, math.radians(ang))
    sc.render.resolution_x, sc.render.resolution_y = 420, 600
    sc.render.filepath = os.path.join(bc.ROOT, 'docs', f'_tt{i}.png')
    bpy.ops.render.render(write_still=True)
    frames.append(sc.render.filepath)
from PIL import Image  # noqa: E402
ims = [Image.open(f).convert('RGB').crop((20, 20, 400, 520)) for f in frames]
W = Image.new('RGB', (380 * 4, 500), 'white')
for i, im in enumerate(ims):
    W.paste(im, (i * 380, 0))
W.save(os.path.join(bc.ROOT, 'docs', 'turntable.png'))
for f in frames:
    os.unlink(f)
print('turntable ok')
