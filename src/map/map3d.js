// Optional 3D view, loaded on first use: the terrain rebuilt at build time (heights.png) draped with the
// paper map and its overlays, plus the enabled markers and upright place names. Renders only on change.
// Uses map.js globals (data, layers, COLORS, view, selection, labelImage, store, $).
window.Map3D = (() => {
  const EXAGGERATION = 1.5, SIZE = data.size;
  let renderer, scene, camera, terrain, markers, highlight, power, names, heights, n, cam, pending = false, canvas;

  function load(src) {
    return new Promise((resolve, reject) => {
      const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error(src)); img.src = src;
    });
  }
  // Ground height in metres at world x, z (bilinear over the 512 grid, rows from the north).
  function heightAt(x, z) {
    const fx = Math.min(n - 1, Math.max(0, x / SIZE * n - 0.5)), fy = Math.min(n - 1, Math.max(0, (SIZE - z) / SIZE * n - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    return (heights[y0 * n + x0] * (1 - tx) + heights[y0 * n + x1] * tx) * (1 - ty) + (heights[y1 * n + x0] * (1 - tx) + heights[y1 * n + x1] * tx) * ty;
  }
  // World (x east, z north) -> scene (x east, z south, y up), centred on the map.
  const toScene = (x, z, y) => new THREE.Vector3(x - SIZE / 2, y * EXAGGERATION, SIZE / 2 - z);

  async function init() {
    const img = await load('nasdara/heights.png');
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx2 = c.getContext('2d'); ctx2.drawImage(img, 0, 0);
    const px = ctx2.getImageData(0, 0, img.width, img.height).data;
    n = img.width; heights = new Float32Array(n * n);
    for (let p = 0; p < n * n; p++) heights[p] = (px[p * 4] * 256 + px[p * 4 + 1]) / 10;

    canvas = $('map3d');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    scene = new THREE.Scene(); scene.background = new THREE.Color('#000');
    camera = new THREE.PerspectiveCamera(50, 1, 10, 80000);
    // Soft enough that flat ground shows the texture at about its own brightness; slopes get the shading.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 0.45));
    const sun = new THREE.DirectionalLight(0xffffff, 0.6); sun.position.set(-1, 1.4, -1); scene.add(sun);

    const geo = new THREE.PlaneGeometry(SIZE, SIZE, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let p = 0; p < n * n; p++) pos.setY(p, heights[p] * EXAGGERATION);
    geo.computeVertexNormals();
    terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xb59c78 }));
    scene.add(terrain);
    await updateTexture();
    buildNames();
    bindInput();
  }
  // Chosen base map (2048 px tiles, or white) with the enabled map overlays, composed into one texture.
  // Shaded relief is left out: the 3D lighting already shades the slopes.
  async function updateTexture() {
    const W = 2048, c = document.createElement('canvas'); c.width = c.height = W;
    const g = c.getContext('2d'), n1 = data.levels[1], span = W / n1;
    const tilesOf = kind => Promise.all([...Array(n1 * n1)].map((_, i) =>
      load(`nasdara/${kind}/1/${i % n1}_${(i / n1) | 0}.${kind === 'tiles' || kind === 'sat' ? 'jpg' : 'png'}`).then(img => [i, img]).catch(() => null)));
    if (base === 'white') { g.fillStyle = '#fff'; g.fillRect(0, 0, W, W); }
    else for (const t of await tilesOf(baseKind())) if (t) g.drawImage(t[1], (t[0] % n1) * span, ((t[0] / n1) | 0) * span, span, span);
    for (const [layer, kind] of [['topo', 'contours'], ['mainroads', 'roads']]) if (layers[layer])
      for (const t of await tilesOf(kind)) if (t) g.drawImage(t[1], (t[0] % n1) * span, ((t[0] / n1) | 0) * span, span, span);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    terrain.material.map?.dispose();
    terrain.material.map = tex; terrain.material.color.set(0xffffff); terrain.material.needsUpdate = true;
    redraw();
  }
  // Upright place names as sprites cut from labels.png, a little above the ground.
  function buildNames() {
    if (!labelImage?.complete || !data.labels) return;
    const base = new THREE.Texture(labelImage); base.needsUpdate = true;
    names = new THREE.Group();
    for (const [x, z, ax, ay, w, h] of data.labels) {
      const tex = base.clone(); tex.needsUpdate = true;
      tex.repeat.set(w / labelImage.width, h / labelImage.height);
      tex.offset.set(ax / labelImage.width, 1 - (ay + h) / labelImage.height);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      sprite.position.copy(toScene(x, z, heightAt(x, z) + 25));
      sprite.scale.set(w * data.labelScale * 1.5, h * data.labelScale * 1.5, 1);
      names.add(sprite);
    }
    scene.add(names);
  }
  // Enabled building / event / area markers as screen-sized points; the search selection highlighted.
  function updateMarkers() {
    for (const obj of [markers, highlight]) if (obj) { scene.remove(obj); obj.geometry.dispose(); obj.material.dispose(); }
    const pts = [], cols = [], add = (x, z, color) => { pts.push(toScene(x, z, heightAt(x, z) + 6)); cols.push(new THREE.Color(color)); };
    const b = data.buildings, S = data.stride;
    for (let i = 0; i < b.length; i += S) { const layer = data.types[b[i]].layer; if (layers[layer]) add(b[i + 1], b[i + 2], COLORS[layer]); }
    for (const [layer, list] of Object.entries(data.events)) if (layers[layer]) for (const [x, z] of list) add(x, z, COLORS[layer]);
    if (layers.underground) for (const [x, z] of data.underground) add(x, z, COLORS.underground);
    if (layers.zones) for (const zone of data.zones) add(zone.x, zone.z, COLORS.zones);
    if (layers.signs && data.signs) for (const [x, z] of data.signs) add(x, z, '#f2f2f2');
    const points = (list, colors, size, color) => {
      const geo = new THREE.BufferGeometry().setFromPoints(list);
      if (colors) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors.flatMap(c => [c.r, c.g, c.b]), 3));
      const options = { size, sizeAttenuation: false, vertexColors: !!colors };
      if (color !== undefined) options.color = color;
      const obj = new THREE.Points(geo, new THREE.PointsMaterial(options));
      scene.add(obj); return obj;
    };
    markers = points(pts, cols, 7);
    if (power) { scene.remove(power); power.geometry.dispose(); power.material.dispose(); power = null; }
    if (layers.power && data.power) {
      const line = data.power.segments.flatMap(([x1, z1, x2, z2]) => [toScene(x1, z1, heightAt(x1, z1) + 12), toScene(x2, z2, heightAt(x2, z2) + 12)]);
      power = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(line), new THREE.LineBasicMaterial({ color: 0xffd84a }));
      scene.add(power);
    }
    highlight = selection ? points(selection.buildings.map(i => toScene(b[i * S + 1], b[i * S + 2], heightAt(b[i * S + 1], b[i * S + 2]) + 8)), null, 11, 0xffcf3f) : null;
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
    placeCamera(); renderer.render(scene, camera);
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
  function bindInput() {
    let drag = null;
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, rotate: e.button === 2 || e.ctrlKey }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('pointermove', e => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
        if (drag.rotate) { cam.yaw += dx * 0.005; cam.pitch += dy * 0.004; clamp(); redraw(); }
        else { const k = cam.dist / innerHeight * 1.2; pan(-dx * k, dy * k); }
        return;
      }
      const hit = groundAt(e.clientX, e.clientY);
      $('coords').textContent = hit ? `X ${Math.round(hit[0])}  Y ${Math.round(hit[1])}  ·  ${Math.round(heightAt(...hit))} m` : 'X —  Y —';
    });
    canvas.addEventListener('wheel', e => { e.preventDefault(); cam.dist *= e.deltaY < 0 ? 0.85 : 1.18; clamp(); redraw(); }, { passive: false });
    addEventListener('resize', redraw);
  }

  return {
    async open() {
      if (!renderer) await init();
      // Start where the 2D map is: same centre and heading, distance matching its zoom.
      const visible = Math.min(innerWidth, innerHeight) / view.s;
      cam = { x: view.x, z: view.z, yaw: -(view.r || 0), pitch: 0.75, dist: visible / (2 * Math.tan(25 * Math.PI / 180)) * 0.9 };
      clamp(); canvas.hidden = false; updateMarkers();
    },
    close() {
      canvas.hidden = true;
      return { x: cam.x, z: cam.z, r: -cam.yaw };
    },
    command(name) {
      const step = cam.dist * 0.3, moves = { up: [0, step], down: [0, -step], left: [-step, 0], right: [step, 0] };
      if (moves[name]) pan(...moves[name]);
      else if (name === 'zoomIn' || name === 'zoomOut') { cam.dist *= name === 'zoomIn' ? 0.8 : 1.25; clamp(); redraw(); }
      // Same feel as 2D: "clockwise" turns the map clockwise on screen, i.e. the heading anticlockwise.
      else if (name === 'north') { cam.yaw = 0; redraw(); }
      else if (name === 'rotateLeft' || name === 'rotateRight') { cam.yaw += (name === 'rotateLeft' ? 1 : -1) * Math.PI / 12; redraw(); }
    },
    layersChanged(id) { if (['base', 'topo', 'mainroads'].includes(id)) updateTexture(); else if (id !== 'relief') updateMarkers(); },
    selectionChanged() { updateMarkers(); }
  };
})();
