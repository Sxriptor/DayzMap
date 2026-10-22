// Optional 3D view, loaded on first use: the terrain rebuilt at build time (heights.png) draped with the
// paper map and its overlays, plus the enabled markers and upright place names. Renders only on change.
// Uses map.js globals (data, layers, COLORS, view, selection, labelImage, store, $).
window.Map3D = (() => {
  const EXAGGERATION = 1, SIZE = data.size;
  let renderer, scene, camera, terrain, markers, highlight, power, names, heights, n, cam, pending = false, canvas;

  function load(src) {
    return new Promise((resolve, reject) => {
      const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error(src)); img.src = src;
    });
  }
  // Ground height in metres at world x, z (bilinear over the exported height grid).
  function heightAt(x, z) {
    const fx = Math.min(n - 1, Math.max(0, x / SIZE * n - 0.5)), fy = Math.min(n - 1, Math.max(0, (SIZE - z) / SIZE * n - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    return (heights[y0 * n + x0] * (1 - tx) + heights[y0 * n + x1] * tx) * (1 - ty) + (heights[y1 * n + x0] * (1 - tx) + heights[y1 * n + x1] * tx) * ty;
  }
  // World (x east, z north) -> scene (x east, z south, y up), centred on the map.
  const toScene = (x, z, y) => new THREE.Vector3(x - SIZE / 2, y * EXAGGERATION, SIZE / 2 - z);

  async function init() {
    const img = await load(`${ROOT}${data.terrain?.fine ? 'heights-fine.png' : 'heights.png'}`);
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx2 = c.getContext('2d'); ctx2.drawImage(img, 0, 0);
    const px = ctx2.getImageData(0, 0, img.width, img.height).data;
    n = img.width; heights = new Float32Array(n * n);
    for (let p = 0; p < n * n; p++) heights[p] = (px[p * 4] * 256 + px[p * 4 + 1]) / 10;

    canvas = $('map3d');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(devicePixelRatio || 1);
    scene = new THREE.Scene(); scene.background = new THREE.Color('#000');
    camera = new THREE.PerspectiveCamera(50, 1, 10, 80000);
    // Unlit imagery retains the same colours and contrast as the 2D map.
    terrain = new THREE.Group(); scene.add(terrain);
    await updateTexture();
    buildNames();
    bindInput();
  }
  // Stream the same tile pyramid as 2D onto terrain patches. A parent stays
  // visible until all its children are ready, so refinement never leaves holes.
  let textureRevision = 0, activeLoads = 0;
  const patches = new Map(), loadQueue = [];
  const frustum = new THREE.Frustum(), projection = new THREE.Matrix4();
  let patchFrame = 0, detailBand;
  const currentDetailBand = () => effectiveScale() >= 1 ? 3 : effectiveScale() >= 0.5 ? 2 : effectiveScale() >= 0.4 ? 1 : 0;
  const effectiveScale = () => cam ? innerHeight / (2 * cam.dist * Math.tan(camera.fov * Math.PI / 360)) : view.s;
  function disposePatch(patch) {
    if (!patch.mesh) return;
    terrain.remove(patch.mesh); patch.mesh.geometry.dispose();
    patch.mesh.material.map?.dispose(); patch.mesh.material.dispose();
  }
  async function updateTexture() {
    textureRevision++; detailBand = currentDetailBand();
    for (const patch of patches.values()) disposePatch(patch);
    patches.clear(); loadQueue.length = 0;
    const roots = levelsOf(baseKind())[0];
    const initial = [];
    for (let y = 0; y < roots; y++) for (let x = 0; x < roots; x++) initial.push(requestPatch(0, x, y).ready);
    await Promise.all(initial); redraw();
  }
  function requestPatch(level, x, y) {
    const key = `${level}/${x}_${y}`;
    let patch = patches.get(key);
    if (patch) return patch;
    const across = levelsOf(baseKind())[level], span = SIZE / across;
    const center = toScene((x + 0.5) * span, SIZE - (y + 0.5) * span, heightAt((x + 0.5) * span, SIZE - (y + 0.5) * span));
    patch = { key, level, x, y, span, revision: textureRevision, used: patchFrame,
      sphere: new THREE.Sphere(center, Math.hypot(span, 2000) / Math.sqrt(2)) };
    patch.ready = new Promise(resolve => { patch.resolve = resolve; });
    patches.set(key, patch); loadQueue.push(patch); pumpTiles(); return patch;
  }
  function pumpTiles() {
    while (activeLoads < 4 && loadQueue.length) {
      const patch = loadQueue.shift();
      if (patch.revision !== textureRevision) { patch.resolve(); continue; }
      activeLoads++;
      composePatch(patch).then(image => {
        if (patch.revision !== textureRevision || patches.get(patch.key) !== patch) return;
        const segments = Math.max(4, Math.min(64, Math.ceil(patch.span / (SIZE / Math.min(n, 512)))));
        const geo = new THREE.PlaneGeometry(patch.span, patch.span, segments, segments); geo.rotateX(-Math.PI / 2);
        const pos = geo.attributes.position, x0 = patch.x * patch.span, z0 = SIZE - patch.y * patch.span;
        for (let i = 0; i < pos.count; i++) {
          const x = x0 + pos.getX(i) + patch.span / 2, z = z0 - pos.getZ(i) - patch.span / 2;
          pos.setXYZ(i, x - SIZE / 2, heightAt(x, z) * EXAGGERATION, SIZE / 2 - z);
        }
        geo.computeBoundingSphere();
        const texture = new THREE.CanvasTexture(image);
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        patch.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: texture }));
        patch.mesh.visible = false; terrain.add(patch.mesh);
      }).catch(error => { patch.failed = true; console.warn('3D map tile unavailable:', patch.key, error.message); })
        .finally(() => { activeLoads--; patch.resolve(); pumpTiles(); redraw(); });
    }
  }
  async function composePatch(patch) {
    const { level, x, y, span } = patch, size = Math.min(data.tile, renderer.capabilities.maxTextureSize);
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d'), across = levelsOf(baseKind())[level];
    // Snapshot options so a layer change cannot mix two configurations in one tile.
    const enabled = { ...layers }, chosenBase = base;
    const scale = effectiveScale(), kind = chosenBase === 'satellite' ? 'sat' : 'tiles';
    if (chosenBase === 'white') { g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); }
    else g.drawImage(await load(`${ROOT}${kind}/${level}/${x}_${y}.jpg`), 0, 0, size, size);
    const whole = (image, alpha = 1) => {
      if (!image?.complete || !image.naturalWidth) return;
      g.save(); g.globalAlpha = alpha;
      g.drawImage(image, x / across * image.width, y / across * image.height,
        image.width / across, image.height / across, 0, 0, size, size); g.restore();
    };
    if (enabled.relief && scale < 1) whole(reliefImage, Math.min(1, (1 - scale) / 0.75) * (chosenBase === 'satellite' ? 0.5 : 1));
    if (enabled.forest && data.forest) whole(forestImage);
    // Overlay pyramids stop earlier than satellite imagery. Crop their sharpest
    // available parent instead of requesting nonexistent high-resolution files.
    for (const [id, folder] of [['topo', 'contours'], ['roadnet', 'roadnet'], ['mainroads', 'roads']]) {
      if (!enabled[id] || (NEEDS[id] && !data[NEEDS[id]]) || (id === 'mainroads' && scale >= 0.5)) continue;
      const index = Math.min(level, data.levels.length - 1), count = data.levels[index];
      const ratio = across / count, ox = Math.floor(x / ratio), oy = Math.floor(y / ratio);
      const image = await load(`${ROOT}${folder}/${index}/${ox}_${oy}.png`);
      g.save();
      if (id === 'mainroads') g.globalAlpha = Math.min(1, (0.5 - scale) / 0.25);
      g.drawImage(image, (x / ratio - ox) * image.width, (y / ratio - oy) * image.height,
        image.width / ratio, image.height / ratio, 0, 0, size, size); g.restore();
    }
    if (enabled.tiers) { g.imageSmoothingEnabled = false; whole(tierImage); g.imageSmoothingEnabled = true; }
    const k = size / span, left = x * span, north = SIZE - y * span;
    const circle = (wx, wz, radius, color, alpha) => {
      if (wx + radius < left || wx - radius > left + span || wz - radius > north || wz + radius < north - span) return;
      g.beginPath(); g.arc((wx - left) * k, (north - wz) * k, radius * k, 0, Math.PI * 2);
      g.globalAlpha = alpha; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
      g.strokeStyle = color; g.lineWidth = Math.max(1, 1.5 * k / Math.max(scale, 0.01)); g.stroke();
    };
    if (enabled.zones) for (const zone of data.zones) circle(zone.x, zone.z, zone.r, '#9fb500', 0.25);
    if (enabled.infected) for (const [wx, wz, radius, type] of data.infected) {
      const color = INFECTED_COLORS.find(([re]) => re.test(data.zoneTypes[type]))[1]; circle(wx, wz, radius, color, 0.18);
    }
    for (const [wx, wz, radius, species] of data.animals) {
      const id = animalLayer(species); if (enabled[id]) circle(wx, wz, radius, COLORS[id], 0.22);
    }
    if (enabled.outlines && data.outlines && scale >= 0.4) {
      g.fillStyle = chosenBase === 'satellite' ? '#ffffff30' : '#5a463240';
      g.strokeStyle = chosenBase === 'satellite' ? '#ffffffb0' : '#2b2b2b'; g.lineWidth = Math.min(1.5, 0.5 + scale) * k / scale;
      for (let i = 0, o = data.outlines; i < o.length; i += 5) {
        const [wx, wz, hw, hd, angle] = o.slice(i, i + 5), radius = Math.hypot(hw, hd);
        if (wx + radius < left || wx - radius > left + span || wz - radius > north || wz + radius < north - span) continue;
        g.save(); g.translate((wx - left) * k, (north - wz) * k); g.rotate(angle);
        g.fillRect(-hw * k, -hd * k, hw * 2 * k, hd * 2 * k); g.strokeRect(-hw * k, -hd * k, hw * 2 * k, hd * 2 * k); g.restore();
      }
    }
    return c;
  }
  function updateTerrain() {
    if (detailBand !== currentDetailBand()) updateTexture();
    patchFrame++;
    projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(projection);
    for (const patch of patches.values()) if (patch.mesh) patch.mesh.visible = false;
    const levels = levelsOf(baseKind()), pixelRatio = renderer.getPixelRatio();
    function visit(patch) {
      if (!frustum.intersectsSphere(patch.sphere)) return;
      patch.used = patchFrame;
      const distance = Math.max(1, camera.position.distanceTo(patch.sphere.center) - patch.span * 0.7);
      const pixels = patch.span * innerHeight * pixelRatio / (2 * distance * Math.tan(camera.fov * Math.PI / 360));
      if (patch.level < levels.length - 1 && pixels > data.tile * 0.85) {
        const ratio = levels[patch.level + 1] / levels[patch.level], children = [];
        for (let y = 0; y < ratio; y++) for (let x = 0; x < ratio; x++) {
          const child = requestPatch(patch.level + 1, patch.x * ratio + x, patch.y * ratio + y);
          child.used = patchFrame; children.push(child);
        }
        if (children.every(child => child.mesh)) { children.forEach(visit); return; }
      }
      if (patch.mesh) patch.mesh.visible = true;
    }
    for (let y = 0; y < levels[0]; y++) for (let x = 0; x < levels[0]; x++) visit(requestPatch(0, x, y));
    // Bound GPU memory while retaining recently viewed parents for seamless zooming.
    const stale = [...patches.values()].filter(p => p.mesh && !p.mesh.visible && p.used < patchFrame - 2).sort((a, b) => a.used - b.used);
    while (patches.size > 96 && stale.length) {
      const patch = stale.shift(); disposePatch(patch); patches.delete(patch.key);
    }
  }
  // Keep names upright and at the same readable screen size as the 2D view.
  function buildNames() {
    if (names) {
      scene.remove(names); names.traverse(child => { child.material?.map?.dispose(); child.material?.dispose(); });
    }
    names = new THREE.Group(); scene.add(names);
    if (labelImage?.complete && labelImage.naturalWidth && data.labels?.length) {
      for (const [i, [x, z, ax, ay, w, h]] of data.labels.entries()) {
        if (layers.places && data.places && paperNames.has(i)) continue;
        const texture = new THREE.Texture(labelImage); texture.needsUpdate = true;
        texture.repeat.set(w / labelImage.width, h / labelImage.height);
        texture.offset.set(ax / labelImage.width, 1 - (ay + h) / labelImage.height);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
        sprite.position.copy(toScene(x, z, heightAt(x, z) + 5));
        sprite.userData = { w, h, paper: true }; names.add(sprite);
      }
    }
    if (!layers.places || !data.places) return;
    for (const [x, z, name, type] of data.places) {
      const [font, minScale] = PLACE_STYLE.find(([re]) => re.test(type)).slice(1);
      const c = document.createElement('canvas'), g = c.getContext('2d'), f = `${font} 'Segoe UI', sans-serif`;
      g.font = f; const w = Math.ceil(g.measureText(name).width) + 12, h = 32;
      c.width = w * 2; c.height = h * 2; g.scale(2, 2);
      g.font = f; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.strokeStyle = base === 'satellite' ? '#000c' : '#f4ead2e0'; g.lineWidth = 4; g.strokeText(name, w / 2, h / 2);
      g.fillStyle = /Marine/.test(type) ? (base === 'satellite' ? '#9fd4ff' : '#1d4e8a') : base === 'satellite' ? '#fff' : '#1d140b';
      g.fillText(name, w / 2, h / 2);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
      sprite.position.copy(toScene(x, z, heightAt(x, z) + 5));
      sprite.userData = { w, h, minScale }; names.add(sprite);
    }
  }
  const namePosition = new THREE.Vector3();
  function updateNameSizes() {
    if (!names) return;
    const scale = effectiveScale();
    for (const sprite of names.children) {
      const { w, h, paper, minScale = 0 } = sprite.userData;
      const k = paper ? Math.min(1.5, scale * data.labelScale) : 1;
      sprite.visible = scale >= minScale && (!paper || h * k >= 3);
      namePosition.copy(sprite.position).applyMatrix4(camera.matrixWorldInverse);
      const units = 2 * Math.max(1, -namePosition.z) * Math.tan(camera.fov * Math.PI / 360) / innerHeight;
      sprite.scale.set(w * k * units, h * k * units, 1);
    }
  }
  // Enabled building / event / area markers as screen-sized points; the search selection highlighted.
  const badgeTextures = new Map();
  let circleTexture;
  const symbolBadges = new Map();
  for (const id of ['spawns', 'underground']) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    if (id === 'spawns') {
      g.beginPath(); g.arc(32, 32, 25, 0, Math.PI * 2); g.strokeStyle = '#fff'; g.lineWidth = 6; g.stroke();
    } else {
      g.fillStyle = '#00d0d0'; g.fillRect(5, 5, 54, 54); g.strokeStyle = '#000'; g.lineWidth = 4; g.strokeRect(5, 5, 54, 54);
      g.beginPath(); g.moveTo(16, 24); g.lineTo(48, 24); g.lineTo(32, 46); g.closePath(); g.fillStyle = '#000'; g.fill();
    }
    symbolBadges.set(id, c);
  }
  function updateMarkers() {
    for (const obj of [markers, highlight]) if (obj) {
      scene.remove(obj); obj.traverse(child => { child.geometry?.dispose(); if (obj === highlight) child.material?.map?.dispose(); child.material?.dispose(); });
    }
    const pts = [], cols = [], groups = new Map();
    const add = (x, z, color, id) => {
      const point = toScene(x, z, heightAt(x, z) + 6);
      const badge = markerBadges.get(id) || symbolBadges.get(id);
      if (badge) {
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(point);
      } else { pts.push(point); cols.push(new THREE.Color(color)); }
    };
    const b = data.buildings, S = data.stride, selected = new Set(selection?.buildings || []);
    for (let i = 0; i < b.length; i += S) { const layer = data.types[b[i]].layer; if (layers[layer] || selected.has(i / S)) add(b[i + 1], b[i + 2], COLORS[layer], buildingIcon(data.types[b[i]])); }
    for (const [layer, list] of Object.entries(data.events)) if (layers[layer]) for (const [x, z, name] of list) add(x, z, COLORS[layer], eventIcon(layer, name));
    if (layers.underground) for (const [x, z] of data.underground) add(x, z, COLORS.underground, 'underground');
    if (layers.spawns) for (const [x, z] of data.spawns) add(x, z, '#fff', 'spawns');

    if (layers.signs && data.signs) for (const [x, z] of data.signs) add(x, z, '#f2f2f2');
    for (const kind of ['water', 'fuel']) if (layers[kind] && data.uses) for (const [x, z, name] of data.uses[kind]) add(x, z, COLORS[kind], sourceIcon(kind, name));
    const points = (list, colors, size, color, ring = false) => {
      const geo = new THREE.BufferGeometry().setFromPoints(list);
      if (colors) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors.flatMap(c => [c.r, c.g, c.b]), 3));
      circleTexture ||= new THREE.CanvasTexture(badgeCanvas(null, '#fff'));
      const options = { size, sizeAttenuation: false, vertexColors: !!colors,
        map: ring ? new THREE.CanvasTexture(symbolBadges.get('spawns')) : circleTexture, transparent: true, alphaTest: 0.05 };
      if (color !== undefined) options.color = color;
      const obj = new THREE.Points(geo, new THREE.PointsMaterial(options));
      scene.add(obj); return obj;
    };
    markers = new THREE.Group(); scene.add(markers);
    const fallback = points(pts, cols, 7); markers.add(fallback);
    for (const [id, list] of groups) {
      const badge = markerBadges.get(id) || symbolBadges.get(id);
      let cached = badgeTextures.get(id);
      if (!cached || cached.badge !== badge) {
        cached?.texture.dispose();
        cached = { badge, texture: new THREE.CanvasTexture(badge) }; badgeTextures.set(id, cached);
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(list);
      const material = new THREE.PointsMaterial({ map: cached.texture, size: 24,
        sizeAttenuation: false, transparent: true, alphaTest: 0.05, depthWrite: false });
      markers.add(new THREE.Points(geometry, material));
    }
    if (power) { scene.remove(power); power.geometry.dispose(); power.material.dispose(); power = null; }
    if (layers.power && data.power) {
      const line = data.power.segments.flatMap(([x1, z1, x2, z2]) => [toScene(x1, z1, heightAt(x1, z1) + 12), toScene(x2, z2, heightAt(x2, z2) + 12)]);
      // Dashed like the 2D map; dash lengths are in metres.
      power = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(line),
        new THREE.LineDashedMaterial({ color: 0x000000, dashSize: 30, gapSize: 20 }));
      power.computeLineDistances(); scene.add(power);
    }
    if (selection?.kind === 'place') highlight = points([toScene(selection.x, selection.z, heightAt(selection.x, selection.z) + 30)], null, 34, 0xffcf3f, true);
    else highlight = selection ? points(selection.buildings.map(i => toScene(b[i * S + 1], b[i * S + 2], heightAt(b[i * S + 1], b[i * S + 2]) + 8)), null, 32, 0xffcf3f, true) : null;
    redraw();
  }

  // Orbit camera around a ground target: yaw is the compass heading looking forward (0 = north, east positive);
  // pitch is the angle down from horizontal. The 2D map's clockwise rotation r corresponds to yaw = -r.
  function placeCamera() {
    const ground = heightAt(cam.x, cam.z), t = toScene(cam.x, cam.z, ground);
    const horiz = cam.dist * Math.cos(cam.pitch);
    camera.position.set(t.x - Math.sin(cam.yaw) * horiz, t.y + cam.dist * Math.sin(cam.pitch), t.z + Math.cos(cam.yaw) * horiz);
    camera.lookAt(t);
  }
  function redraw() { if (!pending) { pending = true; requestAnimationFrame(render); } }
  function render() {
    pending = false;
    if (!canvas || canvas.hidden) return;
    const w = innerWidth, h = innerHeight;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio())) renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    placeCamera(); camera.updateMatrixWorld(); updateTerrain(); updateNameSizes();
    if (power) {
      // Convert pixels to world units at the camera target on every zoom.
      const unitsPerPixel = 2 * cam.dist * Math.tan(camera.fov * Math.PI / 360) / h;
      power.material.dashSize = 4 * unitsPerPixel;
      power.material.gapSize = 4 * unitsPerPixel;
    }
    renderer.render(scene, camera);
    userPins.render(pinScreen3D, groundAt);
    $('compass').firstChild.style.transform = `rotate(${-cam.yaw}rad)`;
  }
  const clamp = () => {
    cam.x = Math.min(SIZE, Math.max(0, cam.x)); cam.z = Math.min(SIZE, Math.max(0, cam.z));
    cam.dist = Math.min(30000, Math.max(150, cam.dist)); cam.pitch = Math.min(1.5, Math.max(0.15, cam.pitch));
  };
  // Moves the target by screen-relative amounts (right, up) in metres.
  function pan(right, up) {
    cam.x += Math.cos(cam.yaw) * right + Math.sin(cam.yaw) * up;
    cam.z += -Math.sin(cam.yaw) * right + Math.cos(cam.yaw) * up;
    clamp(); redraw();
  }
  // World point under a screen position, by stepping along the view ray against the height grid.
  function groundAt(sx, sy) {
    const ray = new THREE.Raycaster(); ray.setFromCamera({ x: sx / innerWidth * 2 - 1, y: -(sy / innerHeight) * 2 + 1 }, camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    for (let t = 0; t < 80000; t += 15) {
      const p = o.clone().addScaledVector(d, t), x = p.x + SIZE / 2, z = SIZE / 2 - p.z;
      if (x < 0 || z < 0 || x > SIZE || z > SIZE) { if (t > 40000) break; continue; }
      if (p.y <= heightAt(x, z) * EXAGGERATION) return [x, z];
    }
    return null;
  }
  function pinScreen3D(x, z) {
    const p = toScene(x, z, heightAt(x, z) + 2).project(camera);
    return p.z < -1 || p.z > 1 ? null : [(p.x + 1) * innerWidth / 2, (1 - p.y) * innerHeight / 2];
  }
  function bindInput() {
    userPins.bindMap(canvas, groundAt);
    let drag = null;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, rotate: e.button === 2 || e.ctrlKey }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('pointermove', e => {
      if (drag) {
        $('tooltip').hidden = true;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
        if (drag.rotate) { cam.yaw += dx * 0.005; cam.pitch += dy * 0.004; clamp(); redraw(); }
        else { const k = cam.dist / innerHeight * 1.2; pan(-dx * k, dy * k); }
        return;
      }
      const hit = groundAt(e.clientX, e.clientY);
      const marker = pick(e.clientX, e.clientY, (x, z) => {
        const p = toScene(x, z, heightAt(x, z) + 6).project(camera);
        return p.z < -1 || p.z > 1 ? [Infinity, Infinity] : [(p.x + 1) * innerWidth / 2, (1 - p.y) * innerHeight / 2];
      }, false);
      const tip = $('tooltip'); tip.hidden = !marker;
      if (marker) {
        tip.replaceChildren(marker.label, document.createElement('br'), Object.assign(document.createElement('small'),
          { textContent: `${Math.round(marker.x)}, ${Math.round(marker.z)}${marker.sub ? ` ? ${marker.sub}` : ''}` }));
        tip.style.left = `${Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 6)}px`; tip.style.top = `${e.clientY + 14}px`;
      }
      $('coords').textContent = hit ? `X ${Math.round(hit[0])}  Y ${Math.round(hit[1])}  ·  ${Math.round(heightAt(...hit))} m` : 'X —  Y —';
    });
    canvas.addEventListener('pointerleave', () => { $('tooltip').hidden = true; });
    canvas.addEventListener('wheel', e => { e.preventDefault(); cam.dist *= e.deltaY < 0 ? 0.85 : 1.18; clamp(); redraw(); }, { passive: false });
    addEventListener('resize', redraw);
  }

  return {
    async open() {
      if (!renderer) await init();
      // Start where the 2D map is: same centre and heading, distance matching its zoom.
      cam = { x: view.x, z: view.z, yaw: -(view.r || 0), pitch: 0.75, dist: innerHeight / (view.s * 2 * Math.tan(25 * Math.PI / 180)) };
      clamp(); canvas.hidden = false; await updateTexture(); buildNames(); updateMarkers();
    },
    close() {
      canvas.hidden = true; $('tooltip').hidden = true;
      return { x: cam.x, z: cam.z, r: -cam.yaw, s: effectiveScale() };
    },
    command(name) {
      const step = cam.dist * 0.3, moves = { up: [0, step], down: [0, -step], left: [-step, 0], right: [step, 0] };
      if (moves[name]) pan(...moves[name]);
      else if (name === 'zoomIn' || name === 'zoomOut') { cam.dist *= name === 'zoomIn' ? 0.8 : 1.25; clamp(); redraw(); }
      // Same feel as 2D: "clockwise" turns the map clockwise on screen, i.e. the heading anticlockwise.
      else if (name === 'north') { cam.yaw = 0; redraw(); }
      else if (name === 'rotateLeft' || name === 'rotateRight') { cam.yaw += (name === 'rotateLeft' ? 1 : -1) * Math.PI / 12; redraw(); }
    },
    focus(x, z) { cam.x = x; cam.z = z; cam.dist = Math.min(cam.dist, 4000); clamp(); redraw(); },
    layersChanged(id) {
      const texture = ['base', 'topo', 'mainroads', 'roadnet', 'forest', 'relief', 'outlines', 'tiers', 'zones', 'infected', 'game', 'predators', 'dogs', 'critters'].includes(id);
      if (texture) updateTexture();
      // Refresh markers when their layers change.
      if ((!texture && id !== 'relief') || id === 'base') updateMarkers();
      if (id === 'places' || id === 'base') { buildNames(); redraw(); }
    },
    pinsChanged() { redraw(); },
    selectionChanged() { updateMarkers(); }
  };
})();
