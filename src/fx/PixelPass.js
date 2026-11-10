// Pixel-art mode: the same 3D scene rendered the way Pixel Sprite Forge bakes
// sprites (https://github.com/Jlpineda12/pixel-sprite-forge), but live:
//   1. render at a low "virtual" resolution (nearest filtering, no AA)
//   2. alpha threshold -> hard silhouette
//   3. quantisation to Jose's palette + ordered Bayer 4x4 dithering between
//      the two nearest colours (only where there is a real gradient)
//   4. adaptive 1px outline (a darker shade of the neighbouring colour)
// The result is upscaled with nearest-neighbour, so every texel is a pixel.
import * as THREE from 'three';

// Palette of the drawing + shade/highlight ramps (sRGB). Like a
// hand-made sprite palette (17 with the skin outline tone); the same .hex file is used for the Blender bake.
export const JOSE_PALETTE = [
  '1c1a1c', '363636', '575555', '8a8482',   // hair / glasses ramp
  'ffffff', 'e9e4dc',                       // eye white, lens
  'ffb59c', 'e5a991', 'c98a74', '8f5545',   // skin ramp (last one: outline)
  'f58476', 'ff8a8a',                       // nose, blush / tongue
  'aa2923', '6e1a1a',                       // mouth, mouth interior
  '9b322c', '74241f', '4e1714',             // shirt ramp
];

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */`
  #define N ${JOSE_PALETTE.length}
  uniform sampler2D tSrc;
  uniform vec2 res;
  uniform vec3 pal[N];
  uniform float deadzone;
  uniform float outlineDark;
  varying vec2 vUv;

  vec3 toSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  float bayer4(vec2 p) {
    p = mod(p, 4.0);
    float i = p.x + p.y * 4.0;
    // 4x4 Bayer matrix, row major
    if (i < 1.0) return 0.0;   if (i < 2.0) return 8.0;   if (i < 3.0) return 2.0;   if (i < 4.0) return 10.0;
    if (i < 5.0) return 12.0;  if (i < 6.0) return 4.0;   if (i < 7.0) return 14.0;  if (i < 8.0) return 6.0;
    if (i < 9.0) return 3.0;   if (i < 10.0) return 11.0; if (i < 11.0) return 1.0;  if (i < 12.0) return 9.0;
    if (i < 13.0) return 15.0; if (i < 14.0) return 7.0;  if (i < 15.0) return 13.0; return 5.0;
  }
  // nearest palette colour, weighted RGB distance (closer to perceived contrast)
  vec3 quantize(vec3 c) {
    vec3 best = pal[0];
    float bd = 1e9;
    for (int i = 0; i < N; i++) {
      vec3 d = c - pal[i];
      float dist = dot(d * d, vec3(0.30, 0.59, 0.11));
      if (dist < bd) { bd = dist; best = pal[i]; }
    }
    return best;
  }
  // ordered dithering between the two nearest palette colours. Colours close
  // to a palette entry (flat toon bands) stay flat: only real gradients dither.
  vec3 ditherQuantize(vec3 c, vec2 px) {
    vec3 a = pal[0], b = pal[0];
    float da = 1e9, db = 1e9;
    for (int i = 0; i < N; i++) {
      vec3 d = c - pal[i];
      float dist = dot(d * d, vec3(0.30, 0.59, 0.11));
      if (dist < da) { db = da; b = a; da = dist; a = pal[i]; }
      else if (dist < db) { db = dist; b = pal[i]; }
    }
    vec3 ab = b - a;
    float t = clamp(dot(c - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    if (t < deadzone) return a;
    return t > (bayer4(px) + 0.5) / 16.0 ? b : a;
  }
  vec4 texel(vec2 px) { return texture2D(tSrc, (px + 0.5) / res); }

  void main() {
    vec2 px = floor(vUv * res);
    vec4 s = texel(px);
    if (s.a < 0.5) {
      // outline: transparent pixel touching the silhouette (4-connectivity)
      vec4 n = texel(px + vec2(1.0, 0.0));
      vec4 m = texel(px - vec2(1.0, 0.0));
      if (m.a > n.a) n = m;
      m = texel(px + vec2(0.0, 1.0)); if (m.a > n.a) n = m;
      m = texel(px - vec2(0.0, 1.0)); if (m.a > n.a) n = m;
      if (n.a < 0.5) discard;
      gl_FragColor = vec4(quantize(toSRGB(n.rgb) * outlineDark), 1.0);
      return;
    }
    gl_FragColor = vec4(ditherQuantize(toSRGB(s.rgb), px), 1.0);
  }
`;

export class PixelPass {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{ pixelSize?: number, deadzone?: number, outlineDark?: number }} opts
   */
  constructor(renderer, { pixelSize = 5, deadzone = 0.5, outlineDark = 0.45 } = {}) {
    this.renderer = renderer;
    this.pixelSize = pixelSize;
    this.enabled = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    const pal = JOSE_PALETTE.map((h) => {
      const n = parseInt(h, 16);
      return new THREE.Vector3((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255);
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: this.target.texture },
        res: { value: new THREE.Vector2(1, 1) },
        pal: { value: pal },
        deadzone: { value: deadzone },
        outlineDark: { value: outlineDark },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** Virtual resolution for a stage of w×h CSS pixels. */
  setSize(w, h) {
    const vw = Math.max(16, Math.round(w / this.pixelSize));
    const vh = Math.max(16, Math.round(h / this.pixelSize));
    this.target.setSize(vw, vh);
    this.material.uniforms.res.value.set(vw, vh);
    this.size = { w: vw, h: vh };
  }

  render(scene, camera) {
    const r = this.renderer;
    if (!this.enabled) {
      r.render(scene, camera);
      return;
    }
    const prevClear = r.getClearAlpha();
    r.setRenderTarget(this.target);
    r.setClearAlpha(0);
    r.clear();
    r.render(scene, camera);
    r.setRenderTarget(null);
    r.setClearAlpha(prevClear);
    r.clear();
    r.render(this.quadScene, this.quadCam);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
