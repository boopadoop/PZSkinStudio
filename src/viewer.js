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

const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform bool lit;
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vec4 skin = texture2D(map, vUv);
    if (skin.a < 0.01) discard;
    vec3 n = normalize(gl_FrontFacing ? vNormal : -vNormal);
    vec3 light = vec3(0.52);
    light += vec3(0.50) * max(dot(n, normalize(vec3(-0.4, 0.6, 0.7))), 0.0);
    light += vec3(0.22) * max(dot(n, normalize(vec3(0.7, 0.1, 0.5))), 0.0);
    gl_FragColor = vec4(lit ? skin.rgb * min(light, vec3(1.0)) : skin.rgb, skin.a);
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
      uniforms: { map: { value: this.blank }, lit: { value: true } },
      transparent: true,
      side: THREE.FrontSide,
    });
    this.lines = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 });
    this.model = new THREE.Group();
    this.scene.add(this.model);
    this.mesh = null;
    this.wire = null;
    this.showWire = false;
    this.crisp = false;

    this.view('front');
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
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
    const offset = new THREE.Vector3(x, y, z).normalize().multiplyScalar(DISTANCE);
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
    this.render();
  }

  useTexture(texture) {
    const old = this.material.uniforms.map.value;
    if (texture !== this.blank) {
      texture.flipY = false;
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = 4;
      this.applyFilter(texture);
      texture.needsUpdate = true;
    }
    this.material.uniforms.map.value = texture;
    if (old !== this.blank) old.dispose();
    this.render();
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
    if (lit !== undefined) this.material.uniforms.lit.value = lit;
    if (backFaces !== undefined) {
      this.material.side = backFaces ? THREE.DoubleSide : THREE.FrontSide;
      this.material.needsUpdate = true;
    }
    if (wire !== undefined) {
      this.showWire = wire;
      if (this.wire) this.wire.visible = wire;
    }
    if (crisp !== undefined) {
      this.crisp = crisp;
      const texture = this.material.uniforms.map.value;
      if (texture !== this.blank) {
        this.applyFilter(texture);
        texture.needsUpdate = true;
      }
    }
    if (turntable !== undefined) {
      this.controls.autoRotate = turntable;
      this.renderer.setAnimationLoop(turntable ? () => this.controls.update() : null);
    }
    this.render();
  }
}
