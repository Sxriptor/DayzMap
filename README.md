# DayZ Map Desk

A small Windows Electron companion with offline DayZ maps (Chernarus, Frostline/Sakhal and Nasdara) built from your own DayZ install. Unofficial; map and game data remain © Bohemia Interactive. No internet, game integration or automatic player tracking.

## Run

Install Node.js 24 or later, then run:

```powershell
npm install
npm start
```

Build a portable Windows executable with `npm run dist:win`. Output is in `dist/`.

## Offline maps

Each map is drawn locally: no internet, no web map library, roughly 40-80 MB of tiles on disk per map (most of it the full-resolution satellite; only tiles on screen are loaded) and a data file of a few MB. Build them once (and again after DayZ updates) with DayZ installed; each map takes a minute or two:

```powershell
npm run build:map                  # every installed map: Nasdara, Chernarus, Frostline (Sakhal)
npm run build:map -- sakhal        # just one: nasdara, chernarusplus or sakhal (build:nasdara is a shortcut)
npm run build:map -- "D:\SteamLibrary\steamapps\common\DayZ"   # if DayZ is not in a Steam library the script finds
```

The script reads only unencrypted game files and writes `src/map/<map>/`, plus `src/map/maps.js`, the list of built maps. These are git-ignored: it is Bohemia's game data, so do not redistribute it. Switch maps under Layers → Map; each map keeps its own view, base map and layers.

The maps differ in what their game files hold:

- **Nasdara**: the paper map, with its printed names lifted off as described below.
- **Frostline (Sakhal)**: the paper map (`map_unfolded_sakhal_co.paa`) as printed. Its busy, colourful style defeats picking out names and contours by colour, so the names rotate with the map and the Topography layer is drawn from the exported terrain. Game place names start hidden there, since the paper already prints them.
- **Chernarus**: the game files have no paper map texture (the engine draws the in-game map), so its **Topographic** base is drawn from the exported terrain: land, water with its shoreline, forest from the tree export, and contour lines every 10 m (bolder every 50 m). Without an export it falls back to the estimated terrain, which is rough near the sea; Satellite is the better base until then.

What a build contains (Nasdara's figures):

- **Base map**: the in-game paper map (`map_unfolded_nasdara_co.paa`): roads, contours, grid and town/landmark names. No satellite imagery. The printed names and grid numbers are lifted off the image by colour (no text recognition) into `labels.png`, so they stay upright when the map is rotated. Single symbols and the odd stray mark stay painted on the map.
- **Base map choice**: Paper map, **Satellite** (stitched from the 1,849 terrain satellite tiles in `worlds_nasdara_data.pbo`, down to their full 1 m/px when zoomed in) or plain White, under Layers → Base map.
- **Shaded relief and terrain heights**: the terrain normal map (`global_nohq.paa`) gives hill shading, and is integrated into a 512 × 512 height grid pinned to the 13,719 building heights in `mapgrouppos.xml` (about 3 m error on held-out buildings). The cursor readout shows ground height.
- **Optional 3D view** (3D button, top right): that terrain draped with the chosen base map and overlays, upright place names and the enabled markers. three.js (`src/map/vendor`, MIT) loads only when 3D is opened. Drag to pan, right-drag (or Ctrl+drag) to turn and tilt, wheel to zoom; the numpad keys work the same as in 2D, and the compass faces north.
- **Main roads**: the widest printed roads (highway, boulevards, main streets) redrawn bold. The paper map draws ordinary roads and dirt tracks the same way, so those are not split further.
- **Topography**: the printed contour lines, picked out by colour (darker and greyer than the parchment, unlike roads) and redrawn darker as a toggleable layer.
- **Overlays** from the Central Economy (`worlds_nasdara_ce.pbo`): every lootable building by type (military, police, medical, fire, hunting, industrial, civilian, wrecks), vehicle/heli crash/convoy/police car/locked container/water truck spawns, toxic zones, infected zones by type, animal territories (game animals, dogs, small animals), bunker and tunnel entrances (`cfgundergroundtriggers.json`), player spawn areas and the loot tier map.
- **Loot search**: type an item (e.g. `AKM`) to highlight buildings where the economy can spawn it. A building matches when it or its area shares a usage flag with the item, it has a container accepting the item's category, and its area tier is allowed. This follows the economy files but is not an exact spawn simulation. Attachment/cargo-only spawns are not included.

Not in any unencrypted file: individual object placements, the road network, the town-name list and exact heights. The optional world export below reads them from a running server.

Map controls: drag to pan, wheel or double-click to zoom (Shift+double-click zooms out), `/` or Shift+Q to search, Esc clears the search, Ctrl+C copies the cursor's X, Y. The view and layer choices are remembered.

## World export (optional server mod)

A small **server-side mod** (`tools/export-mod`) reads what the unencrypted files lack from a running DayZ server, using only the game's own script API. It never touches the encrypted world file. One run adds:

- **Place search**: every named place in the world config (cities, villages, local names, ruins, bays, hills). Type a name in the search box to jump there.
- **Exact terrain**: the game's ground height every 10 m, replacing the normal-map estimate in 3D and in the cursor readout (8 m grid in 2D).
- **Roads (surveyed)**: wherever the game has a road surface underfoot, sampled every 4 m. Paved roads are dark grey, gravel and dirt brown, and building floors are left out.
- **Building outlines**: the true footprint and rotation of every building and larger structure, shown once zoomed in.
- **Forest**: tree density from every tree and bush.
- **Wells & water** and **Fuel pumps**: the objects the game itself lets you drink from or refuel at.
- **Powerlines** and **Road signs**, as before.

1. `npm run pack:export-mod` writes `@NasdaraExport\addons\NasdaraExport.pbo`.
2. Install **DayZ Server** (Steam → Library → Tools). Copy its `serverDZ.cfg` (for example to `C:\dzexport\export.cfg`) and set the mission `template` there to the map's mission: `dayzOffline.chernarusplus`, `dayzOffline.sakhal` or `dayzOffline.nasdara`. Keep BattlEye on: without it the server shuts itself down straight after start-up.
3. From the DayZ Server folder run `DayZServer_x64.exe -config=C:\dzexport\export.cfg -port=2402 -profiles=C:\dzexport -servermod=<full path>\@NasdaraExport`. Use a short profiles path: the server hangs at start-up with a very long one. You do not need to join. The export starts once the mission is up, logs progress (`[NasdaraExport] ...`) to `C:\dzexport\script_*.log`, and the server **shuts itself down when done**. Add `-nasdaraStay` to keep it running.
4. The files are named after the world (`chernarusplus_objects.json`, `sakhal_terrain.txt`, ...). Copy them from `C:\dzexport\NasdaraExport\` into this project's `exports\<world>\` folder (`exports\chernarusplus\`, `exports\sakhal\` or `exports\nasdara\`) and run `npm run build:map -- <world>`. Only the layers whose files are present are built.

Run one server at a time. The Chernarus export peaks at over 6 GB of memory, and running two exports at once on a 16 GB machine killed one of them. Each export takes about 5 minutes.

The export files are plain text. `<world>_shapes.txt` counts every model the sweep saw and `<world>_surfaces.txt` lists every ground surface name, so the road and object filters can be checked.

## Controls

The window is just the map: a borderless window with a close button (×) and a move grip (⠿) at the top right. Drag the window edges to resize; position and size are remembered.

Global keys work while DayZ or another app has focus. Numpad keys need **Num Lock on**.

| Key | Action |
| --- | --- |
| Numpad 8 / 2 | Pan up / down |
| Numpad 4 / 6 | Pan left / right |
| Numpad 1 / 3 | Rotate counterclockwise / clockwise (15° steps) |
| Numpad 9 / 7 | Zoom in / out |
| Ctrl+Alt+M | Show / hide without taking focus |
| Ctrl+Alt+T | Toggle mouse click-through |

The numpad keys are captured system-wide only while the map is visible; hiding it (Ctrl+Alt+M) gives them back to the game. Pan directions follow the screen, so they stay intuitive when the map is rotated. Click the compass (bottom right) to reset north up. The tray menu can reopen the window and turn off click-through. Closing the window exits the app.

Use DayZ's borderless windowed mode for the always-on-top window. Exclusive fullscreen can cover ordinary desktop windows. Keybind behavior inside DayZ needs testing on your machine, especially if the game runs elevated.

## Resource use

The app uses plain HTML/CSS/JavaScript and one local canvas map, without a UI framework, map library, background polling, or app animations. Only the tiles on screen are loaded, and the map redraws only when you interact. Chromium background throttling stays enabled. Hiding or minimizing releases the map page and reloads it on reopening; the view, rotation and layers are restored.

Electron's Chromium runtime still uses memory; this is not a native map engine, and no fixed RAM/CPU target is promised. Hardware acceleration stays enabled to avoid pushing map rendering onto the CPU.

The map runs sandboxed without Node.js access; its preload only exposes closing the window and receiving map commands. All navigation and popups are blocked, and the only permission granted is writing copied coordinates to the clipboard.

## Verify

`npm test` checks preference recovery, the numpad layout, loot matching and search, the world-export importers, and (once built) each map's generated data. `npx electron . --smoke` checks the map page, the rotate command path, hide/show unloading, click-through and shortcut registration.
