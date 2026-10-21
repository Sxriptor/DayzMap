# DayZ Map Desk

A small Windows Electron companion with an offline DayZ Nasdara map built from your own DayZ install. Unofficial; map and game data remain © Bohemia Interactive. No internet, game integration or automatic player tracking.

## Run

Install Node.js 24 or later, then run:

```powershell
npm install
npm start
```

Build a portable Windows executable with `npm run dist:win`. Output is in `dist/`.

## Offline Nasdara map

Nasdara is drawn locally: no internet, no web map library, about 8 MB of tiles and a ~470 KB data file. Build it once (and again after DayZ updates) with DayZ and the Nasdara DLC installed:

```powershell
npm run build:nasdara
# or, if DayZ is not in a Steam library this script can find:
npm run build:nasdara -- "D:SteamLibrarysteamappscommonDayZ"
```

The script reads only unencrypted game files and writes `src/map/nasdara/` (git-ignored; it is Bohemia's game data, so do not redistribute it):

- **Base map**: the in-game paper map (`map_unfolded_nasdara_co.paa`): roads, contours, grid and town/landmark names. No satellite imagery. The printed names and grid numbers are lifted off the image by colour (no text recognition) into `labels.png`, so they stay upright when the map is rotated. Single symbols and the odd stray mark stay painted on the map.
- **Base map choice**: Paper map, **Satellite** (stitched from the 1,849 terrain satellite tiles in `worlds_nasdara_data.pbo`, 4 m/px) or plain White, under Layers → Base map.
- **Shaded relief and terrain heights**: the terrain normal map (`global_nohq.paa`) gives hill shading, and is integrated into a 512 × 512 height grid pinned to the 13,719 building heights in `mapgrouppos.xml` (about 3 m error on held-out buildings). The cursor readout shows ground height.
- **Optional 3D view** (3D button, top right): that terrain draped with the chosen base map and overlays, upright place names and the enabled markers. three.js (`src/map/vendor`, MIT) loads only when 3D is opened. Drag to pan, right-drag (or Ctrl+drag) to turn and tilt, wheel to zoom; the numpad keys work the same as in 2D, and the compass faces north.
- **Main roads**: the widest printed roads (highway, boulevards, main streets) redrawn bold. The paper map draws ordinary roads and dirt tracks the same way, so those are not split further.
- **Topography**: the printed contour lines, picked out by colour (darker and greyer than the parchment, unlike roads) and redrawn darker as a toggleable layer.
- **Overlays** from the Central Economy (`worlds_nasdara_ce.pbo`): every lootable building by type (military, police, medical, fire, hunting, industrial, civilian, wrecks), vehicle/heli crash/convoy/police car/locked container/water truck spawns, toxic zones, infected zones by type, animal territories (game animals, dogs, small animals), bunker and tunnel entrances (`cfgundergroundtriggers.json`), player spawn areas and the loot tier map.
- **Loot search**: type an item (e.g. `AKM`) to highlight buildings where the economy can spawn it. A building matches when it or its area shares a usage flag with the item, it has a container accepting the item's category, and its area tier is allowed. This follows the economy files but is not an exact spawn simulation. Attachment/cargo-only spawns are not included.

Not available: road classes, other individual object placements and the searchable town-name list live only in the encrypted world file (`worlds_nasdara.ebo`), which this project does not touch. Town names are still visible on the paper map. Powerlines and road signs can be added with the export below.

Map controls: drag to pan, wheel or double-click to zoom (Shift+double-click zooms out), `/` or Shift+Q to search, Esc clears the search, Ctrl+C copies the cursor's X, Y. The view and layer choices are remembered.

## Powerlines and road signs (optional export)

Their positions are not in any unencrypted file, so a small **server-side mod** reads them from a running DayZ server. It never touches the encrypted world file.

1. `npm run pack:export-mod` writes `@NasdaraExport\addons\NasdaraExport.pbo`.
2. Install **DayZ Server** (Steam → Library → Tools) and set the mission `template` in its `serverDZ.cfg` to the Nasdara mission folder in its `mpmissions` directory.
3. Start it once: `DayZServer_x64.exe -config=serverDZ.cfg -profiles=profiles -servermod=<full path>\@NasdaraExport`. You do not need to join. When the server log shows `[NasdaraExport] done: ...`, stop the server.
4. Copy `profiles\nasdara_objects.json` into this project's `exports\` folder and run `npm run build:nasdara`. The **Powerlines** and **Road signs** layers then appear in 2D and 3D.

`profiles\nasdara_shapes.txt` lists every model the sweep saw, to check nothing power-related was missed. The mod and the import have unit tests but have not yet been run against a live server.

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

`npm test` checks preference recovery, the numpad layout, loot matching and search, and (once built) the generated Nasdara data. `npx electron . --smoke` checks the map page, the rotate command path, hide/show unloading, click-through and shortcut registration.
