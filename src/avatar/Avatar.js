// 3D avatar: loads the Blender GLB, applies toon materials tuned to the
// drawing's palette, wraps the procedural 2D face on the head and exposes a
// small API for the behaviour layer (head rotation, morphs, face params).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FaceCanvas } from './FaceCanvas.js';

// Lights: ambient + direct = π, so a fully lit toon pixel shows the exact
// palette colour; shadows and the hair ramp come from the gradient maps.
const AMBIENT = 0.4 * Math.PI;
const DIRECT = 0.6 * Math.PI;

const HEAD_PARTS = /^(Head|FaceCanvas|Hair|Cowlick|Ear|EarInner|Nose|Frame|Temple|Hinge|Rivet|Lens|Bridge)/;

function gradient(values) {
  const data = new Uint8Array(values.length * 4);
  values.forEach((v, i) => data.set([v * 255, v * 255, v * 255, 255], i * 4));
  const tex = new THREE.DataTexture(data, values.length, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// per-material ramps (coordinate = N·L * 0.5 + 0.5)
const RAMPS = {
  flat: gradient([1, 1, 1, 1]),
  soft: gradient([0.55, 1, 1, 1]),
  hair: gradient([0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1]),  // shadow / base / highlight
};

function toon(hex, ramp, scale = 1) {
  const m = new THREE.MeshToonMaterial({ color: new THREE.Color(hex), gradientMap: RAMPS[ramp] });
  m.color.multiplyScalar(scale);
  return m;
}

function lensGlint() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineCap = 'round';
  g.lineWidth = 9;
  g.beginPath(); g.moveTo(84, 18); g.lineTo(108, 42); g.stroke();
  g.lineWidth = 5;
  g.beginPath(); g.moveTo(70, 22); g.lineTo(78, 30); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Avatar {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.headPivot = new THREE.Group();
    this.morphMeshes = [];
    this.ready = false;
  }

  async load(modelUrl, layoutUrl) {
    const [gltf, layout] = await Promise.all([
      new GLTFLoader().loadAsync(modelUrl),
      fetch(layoutUrl).then((r) => r.json()),
    ]);
    this.layout = layout;
    const pal = layout.palette;
    this.face = new FaceCanvas(layout);
    this.faceTex = new THREE.CanvasTexture(this.face.canvas);
    this.faceTex.colorSpace = THREE.SRGBColorSpace;
    this.faceTex.flipY = false;               // glTF UV convention
    this.faceTex.anisotropy = 4;

    const mats = {
      Skin: toon(pal.Skin, 'flat'),
      Neck: toon(pal.Skin, 'flat'),
      EarInner: toon(pal.EarInner, 'flat'),
      Nose: toon(pal.Nose, 'soft'),
      Hair: toon(pal.Hair, 'hair', 1 / 0.7),
      Glasses: toon(pal.Glasses, 'flat'),
      Rivet: toon(pal.Rivet, 'flat'),
      Shirt: toon(pal.Shirt, 'soft'),
    };
    const glint = lensGlint();

    const meshes = [];
    gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
    // neck pivot (Blender (0, 0.06, 1.12) -> three (0, 1.12, -0.06))
    this.headPivot.position.set(0, 1.12, -0.06);
    this.root.add(this.headPivot);
    this.root.add(gltf.scene);
    this.root.updateMatrixWorld(true);

    for (const mesh of meshes) {
      const name = mesh.name;
      const matName = mesh.material?.name || '';
      if (name.startsWith('FaceCanvas')) {
        mesh.material = new THREE.MeshBasicMaterial({
          map: this.faceTex, transparent: true, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        });
        mesh.renderOrder = 2;
      } else if (name.startsWith('Lens')) {
        const geo = mesh.geometry;
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        const pos = geo.attributes.position;
        const uv = new Float32Array(pos.count * 2);
        for (let i = 0; i < pos.count; i++) {
          uv[i * 2] = (pos.getX(i) - bb.min.x) / (bb.max.x - bb.min.x || 1);
          uv[i * 2 + 1] = (pos.getY(i) - bb.min.y) / (bb.max.y - bb.min.y || 1);
        }
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        mesh.material = new THREE.MeshBasicMaterial({ map: glint, transparent: true, opacity: 0.55, depthWrite: false });
        mesh.renderOrder = 3;
      } else {
        mesh.material = mats[matName] || mats.Skin;
      }
      mesh.castShadow = name.startsWith('Head');      // only the head casts (the neck shadow)
      mesh.receiveShadow = matName === 'Neck';
      if (mesh.morphTargetDictionary) this.morphMeshes.push(mesh);
      if (HEAD_PARTS.test(name)) this.headPivot.attach(mesh);
    }
    this.scene.add(this.root);
    this.ready = true;
    return this;
  }

  /** Morph targets shared by Head + FaceCanvas */
  setMorph(name, value) {
    for (const m of this.morphMeshes) {
      const i = m.morphTargetDictionary[name];
      if (i !== undefined) m.morphTargetInfluences[i] = value;
    }
  }

  setHead(yaw, pitch, roll) {
    this.headPivot.rotation.set(pitch, yaw, roll, 'YXZ');
  }

  drawFace(params, time) {
    this.face.draw(params, time);
    this.faceTex.needsUpdate = true;
  }

  /** World position of a point in head space (for 2D overlays). */
  headPoint(x, y, z) {
    return this.headPivot.localToWorld(new THREE.Vector3(x, y, z));
  }
}

export function setupLights(scene) {
  scene.add(new THREE.AmbientLight(0xffffff, AMBIENT));
  const sun = new THREE.DirectionalLight(0xffffff, DIRECT);
  // ~40° above the horizon, slightly from the left: a band of shadow under the chin
  sun.position.set(-1.2, 1.6 + 3.2, 4.0);
  sun.target.position.set(0, 1.3, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -1; sun.shadow.camera.right = 1;
  sun.shadow.camera.top = 1; sun.shadow.camera.bottom = -1;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 12;
  sun.shadow.bias = -0.0015;
  sun.shadow.radius = 3;
  if ('intensity' in sun.shadow) sun.shadow.intensity = 0.42;  // neck shade ≈ the drawing's #e5a991
  scene.add(sun, sun.target);
  return sun;
}
