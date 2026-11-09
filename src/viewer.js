import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// The same maths as the game's basicEffect.frag: lighting straight on the texture's sRGB values
// with no gamma step, clamped at 1, and pixels below 1% alpha thrown away.
const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vNormal = normalMatrix * normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

//
// While painting it can also outline the brush where it sits on the texture, the way the paint
// canvas does: up to four copies (with mirroring), each a box in UV space (left, top, right,
// bottom), drawn square or round, white inside a dark edge, about a screen pixel wide.
const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform bool lit;
  uniform vec4 brush[4];
  uniform int brushCount;
  uniform bool brushRound;
  varying vec2 vUv;
  varying vec3 vNormal;

  // How far a point is from a brush outline, in screen pixels.
  float brushDistance(vec2 uv, vec4 box) {
    vec2 centre = (box.xy + box.zw) * 0.5;
    vec2 halfSize = (box.zw - box.xy) * 0.5;
    vec2 pixel = max(fwidth(uv), vec2(1e-6));
    if (brushRound) {
      vec2 q = (uv - centre) / halfSize;
      return abs(length(q) - 1.0) / length(pixel / halfSize);
    }
    vec2 q = abs(uv - centre) - halfSize;
    return abs(max(q.x / pixel.x, q.y / pixel.y));
  }

  void main() {
    vec4 skin = texture2D(map, vUv);
    float white = 0.0;
    float dark = 0.0;
    for (int i = 0; i < 4; i++) {
      if (i >= brushCount) break;
      float d = brushDistance(vUv, brush[i]);
      white = max(white, 1.0 - smoothstep(0.6, 1.2, d));
      dark = max(dark, 1.0 - smoothstep(1.4, 2.4, d));
    }
    if (skin.a < 0.01 && dark == 0.0) discard;
    vec3 n = normalize(gl_FrontFacing ? vNormal : -vNormal);
    vec3 light = vec3(0.52);
    light += vec3(0.50) * max(dot(n, normalize(vec3(-0.4, 0.6, 0.7))), 0.0);
    light += vec3(0.22) * max(dot(n, normalize(vec3(0.7, 0.1, 0.5))), 0.0);
    vec3 colour = lit ? skin.rgb * min(light, vec3(1.0)) : skin.rgb;
    colour = mix(mix(colour, vec3(0.0), dark * 0.8), vec3(1.0), white);
    gl_FragColor = vec4(colour, max(skin.a, dark));
  }
`;

const TARGET_HEIGHT = 0.55;
const DISTANCE = 2.3;

// Directions are the character's own: it stands facing +Z, so its left side is +X.
const VIEWS = {
  front: [0, 0.05, 1],
  back: [0, 0.05, -1],
  left: [1, 0.05, 0],
  right: [-1, 0.05, 0],
};

const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, TARGET_HEIGHT, 0);
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 6;
    this.controls.autoRotateSpeed = 3;
    this.controls.addEventListener('change', () => this.render());

    this.blank = new THREE.DataTexture(new Uint8Array([168, 168, 168, 255]), 1, 1);
    this.blank.needsUpdate = true;
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        map: { value: this.blank },
        lit: { value: true },
        brush: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
        brushCount: { value: 0 },
        brushRound: { value: false },
      },
      transparent: true,
      side: THREE.FrontSide,
    });
    this.lines = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 });
    // Parts of the file the game doesn't draw: there to see, but plainly not part of the model.
    this.ghostMaterial = new THREE.MeshBasicMaterial({
      color: 0x9aa0ac, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide,
    });
    this.ghost = null;
    // With a texture per object: a material for each object, by object number.
    this.partMaterials = [];
    this.model = new THREE.Group();
    this.scene.add(this.model);
    this.mesh = null;
    this.wire = null;
    this.showWire = false;
    this.crisp = false;
    this.distance = DISTANCE;

    this.view('front');
    this.listenForPicks();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  // A click that isn't a drag reports the polygon corner under the pointer to onPick, so the studio
  // can tell which object was clicked. Grey parts count too.
  listenForPicks() {
    this.onPick = null;
    this.raycaster = new THREE.Raycaster();
    let down = null;
    this.canvas.addEventListener('pointerdown', (event) => {
      down = event.button === 0 ? { x: event.clientX, y: event.clientY, at: performance.now() } : null;
    });
    this.canvas.addEventListener('pointerup', (event) => {
      if (!down || !this.onPick) return;
      const still = Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5 && performance.now() - down.at < 500;
      down = null;
      if (!still) return;
      const corner = this.cornerAt(event.clientX, event.clientY);
      if (corner !== null) this.onPick(corner);
    });
  }

  // Painting on the model. surface: { wants(event), start(hit, event), move(hit), end(), hover(hit) },
  // where a hit is the texture point under the pointer, { u, v }, or null off the model. While set,
  // a press on the model paints instead of turning it; a press beside the model still turns it.
  setSurfacePainting(surface) {
    this.surface = surface;
    this.canvas.style.cursor = '';
    if (this.surfaceListening) return;
    this.surfaceListening = true;
    // Capture listeners on the canvas run before the orbit controls' own.
    const options = { capture: true };
    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.surface || event.button !== 0 || !this.surface.wants(event)) return;
      const hit = this.surfaceAt(event.clientX, event.clientY);
      if (!hit) return;
      this.controls.enabled = false;
      this.canvas.setPointerCapture(event.pointerId);
      this.surfaceDrag = { x: event.clientX, y: event.clientY };
      this.surface.start(hit, event);
    }, options);
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.surface) return;
      if (!this.surfaceDrag) {
        if (event.buttons) return;
        const hit = this.surfaceAt(event.clientX, event.clientY);
        this.canvas.style.cursor = hit ? 'crosshair' : '';
        this.surface.hover(hit);
        return;
      }
      // Points along the way, a few screen pixels apart, so the stroke follows the surface rather
      // than cutting straight across the texture.
      const from = this.surfaceDrag;
      const steps = Math.min(24, Math.max(1, Math.ceil(Math.hypot(event.clientX - from.x, event.clientY - from.y) / 3)));
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((event.clientX - from.x) * i) / steps;
        const y = from.y + ((event.clientY - from.y) * i) / steps;
        this.surface.move(this.surfaceAt(x, y));
      }
      this.surfaceDrag = { x: event.clientX, y: event.clientY };
    }, options);
    const finish = () => {
      if (!this.surfaceDrag) return;
      this.surfaceDrag = null;
      this.controls.enabled = true;
      this.surface?.end();
    };
    this.canvas.addEventListener('pointerup', finish, options);
    this.canvas.addEventListener('pointercancel', finish, options);
    this.canvas.addEventListener('pointerleave', () => {
      if (this.surface && !this.surfaceDrag) this.surface.hover(null);
    });
  }

  // The texture point on the model under a point on the page, or null. Only the solid model counts,
  // not the grey parts.
  surfaceAt(clientX, clientY) {
    if (!this.mesh) return null;
    const box = this.canvas.getBoundingClientRect();
    const point = new THREE.Vector2(((clientX - box.left) / box.width) * 2 - 1, -((clientY - box.top) / box.height) * 2 + 1);
    this.raycaster.setFromCamera(point, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit?.uv) return null;
    return { u: hit.uv.x - Math.floor(hit.uv.x), v: hit.uv.y - Math.floor(hit.uv.y) };
  }

  // Shows or hides the grey parts.
  showGhost(show) {
    if (!this.ghost) return;
    this.ghost.visible = show;
    this.render();
  }

  cornerAt(clientX, clientY) {
    const box = this.canvas.getBoundingClientRect();
    const point = new THREE.Vector2(((clientX - box.left) / box.width) * 2 - 1, -((clientY - box.top) / box.height) * 2 + 1);
    this.raycaster.setFromCamera(point, this.camera);
    const targets = [this.mesh, this.ghost].filter(Boolean);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return hit ? hit.face.a : null;
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.canvas.parentElement;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  view(name) {
    const [x, y, z] = VIEWS[name];
    const offset = new THREE.Vector3(x, y, z).normalize().multiplyScalar(this.distance);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
    this.render();
  }

  setMesh(data) {
    if (this.mesh) {
      this.model.remove(this.mesh, this.wire);
      this.mesh.geometry.dispose();
      this.wire.geometry.dispose();
    }
    if (this.ghost) {
      this.model.remove(this.ghost);
      this.ghost.geometry.dispose();
      this.ghost = null;
    }
    if (data.ghost) {
      const ghost = new THREE.BufferGeometry();
      ghost.setAttribute('position', new THREE.BufferAttribute(data.ghost.position, 3));
      ghost.setIndex(new THREE.BufferAttribute(data.ghost.index, 1));
      this.ghost = new THREE.Mesh(ghost, this.ghostMaterial);
      this.ghost.renderOrder = 1;
      this.model.add(this.ghost);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
    geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
    if (data.hasNormals) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
    else geometry.computeVertexNormals();
    this.mesh = new THREE.Mesh(geometry, this.material);

    const outline = new THREE.BufferGeometry();
    outline.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    outline.setIndex(new THREE.BufferAttribute(data.edges, 1));
    this.wire = new THREE.LineSegments(outline, this.lines);
    this.wire.visible = this.showWire;
    this.model.add(this.mesh, this.wire);
    this.frameModel();
  }

  // The stage suits the pack's characters, about 1 unit tall and standing on 0. A model that doesn't
  // fit it, such as one made at home in other units, gets its own framing, grey parts included. The
  // camera only moves when the framing changes, so going from one pack model to the next keeps it.
  frameModel() {
    this.model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model, true);
    if (box.isEmpty()) return;
    const reach = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
    const fits = box.min.y > -0.15 && box.max.y < 1.3 && reach < 0.8;
    const size = box.getSize(new THREE.Vector3());
    const target = fits ? new THREE.Vector3(0, TARGET_HEIGHT, 0) : box.getCenter(new THREE.Vector3());
    const distance = fits ? DISTANCE : Math.max(size.x, size.y, size.z, 0.1) * 2.1;
    if (target.distanceTo(this.controls.target) < 1e-6 && Math.abs(distance - this.distance) < 1e-6) {
      this.render();
      return;
    }
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.distance = distance;
    this.controls.target.copy(target);
    this.controls.minDistance = Math.min(0.3, distance / 8);
    this.controls.maxDistance = Math.max(6, distance * 3);
    this.camera.position.copy(target).add(direction.multiplyScalar(distance));
    this.controls.update();
    this.render();
  }

  get isTurned() {
    return Math.abs(this.model.quaternion.w) < 1 - 1e-6;
  }

  get orientation() {
    return this.isTurned ? this.model.quaternion.toArray() : null;
  }

  set orientation(quaternion) {
    if (quaternion) this.model.quaternion.fromArray(quaternion);
    else this.model.quaternion.identity();
    this.placeModel();
  }

  // A quarter turn for a model that loads on its side. Only the preview moves.
  turn(axis) {
    const quarter = new THREE.Quaternion().setFromAxisAngle(AXES[axis], Math.PI / 2);
    this.model.quaternion.premultiply(quarter).normalize();
    if (!this.isTurned) this.model.quaternion.identity();
    this.placeModel();
  }

  modelBox() {
    this.model.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(this.mesh, true);
  }

  // A turned model stands on the floor at the middle of the stage, so the camera orbits around it.
  placeModel() {
    this.model.position.set(0, 0, 0);
    if (this.isTurned) {
      const box = this.modelBox();
      const centre = box.getCenter(new THREE.Vector3());
      this.model.position.set(-centre.x, -box.min.y, -centre.z);
    }
    this.frameModel();
  }

  prepare(texture) {
    if (texture === this.blank) return texture;
    texture.flipY = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    this.applyFilter(texture);
    texture.needsUpdate = true;
    return texture;
  }

  useTexture(texture) {
    this.oneTexture();
    const old = this.material.uniforms.map.value;
    this.prepare(texture);
    this.material.uniforms.map.value = texture;
    if (old !== this.blank) old.dispose();
    this.render();
  }

  // The brush outline on the model. spots: boxes in UV space, [left, top, right, bottom], up to
  // four; none hides it.
  setBrush(spots = [], round = false) {
    const uniforms = this.material.uniforms;
    const key = JSON.stringify([spots, round]);
    if (key === this.brushKey) return;
    this.brushKey = key;
    spots.slice(0, 4).forEach((box, i) => uniforms.brush.value[i].set(...box));
    uniforms.brushCount.value = Math.min(spots.length, 4);
    uniforms.brushRound.value = round;
    this.render();
  }

  // Back to one texture for everything shown.
  oneTexture() {
    if (!this.mesh || !Array.isArray(this.mesh.material)) return;
    this.mesh.geometry.clearGroups();
    this.mesh.material = this.material;
  }

  // A texture of its own on each object. images: ImageBitmaps by object number (gaps are grey);
  // cornerPart: each corner's object number, as the mesh came with it.
  setPartSkins(images, cornerPart) {
    if (!this.mesh) return;
    const geometry = this.mesh.geometry;
    const index = geometry.index.array;
    geometry.clearGroups();
    const materials = [];
    const used = new Map();
    let start = 0;
    for (let t = 3; t <= index.length; t += 3) {
      const part = cornerPart[index[start]];
      if (t < index.length && cornerPart[index[t]] === part) continue;
      if (!used.has(part)) {
        used.set(part, materials.length);
        materials.push(this.partMaterial(part, images[part]));
      }
      geometry.addGroup(start, t - start, used.get(part));
      start = t;
    }
    this.mesh.material = materials.length ? materials : this.material;
    this.render();
  }

  partMaterial(part, image) {
    const material = this.partMaterials[part] ?? this.material.clone();
    this.partMaterials[part] = material;
    material.uniforms.lit.value = this.material.uniforms.lit.value;
    material.uniforms.brushCount.value = 0;
    material.side = this.material.side;
    const old = material.uniforms.map.value;
    material.uniforms.map.value = image ? this.prepare(new THREE.Texture(image)) : this.blank;
    if (old && old !== this.blank && old !== this.material.uniforms.map.value) old.dispose();
    return material;
  }

  // image: an ImageBitmap, or null for plain grey. UVs already count from the top of the image.
  setSkin(image) {
    this.useTexture(image ? new THREE.Texture(image) : this.blank);
  }

  // While painting, the model reads the painter's own pixels, so repaint() is all it takes to update it.
  setPaintPixels(pixels, width, height) {
    const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    this.useTexture(new THREE.DataTexture(bytes, width, height, THREE.RGBAFormat, THREE.UnsignedByteType));
  }

  repaint() {
    this.material.uniforms.map.value.needsUpdate = true;
    this.render();
  }

  applyFilter(texture) {
    texture.magFilter = this.crisp ? THREE.NearestFilter : THREE.LinearFilter;
    texture.minFilter = this.crisp ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = !this.crisp;
  }

  setOptions({ lit, wire, backFaces, crisp, turntable }) {
    const materials = [this.material, ...this.partMaterials.filter(Boolean)];
    for (const material of materials) {
      if (lit !== undefined) material.uniforms.lit.value = lit;
      if (backFaces !== undefined) {
        material.side = backFaces ? THREE.DoubleSide : THREE.FrontSide;
        material.needsUpdate = true;
      }
    }
    if (wire !== undefined) {
      this.showWire = wire;
      if (this.wire) this.wire.visible = wire;
    }
    if (crisp !== undefined) {
      this.crisp = crisp;
      for (const material of materials) {
        const texture = material.uniforms.map.value;
        if (texture !== this.blank) {
          this.applyFilter(texture);
          texture.needsUpdate = true;
        }
      }
    }
    if (turntable !== undefined) {
      this.controls.autoRotate = turntable;
      this.renderer.setAnimationLoop(turntable ? () => this.controls.update() : null);
    }
    this.render();
  }
}
