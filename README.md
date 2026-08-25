<p align="center">
  <img src="flash/assurance_logo.png" alt="Assurance logo" width="300" />
</p>

<h1 align="center">Assurance</h1>

<p align="center">
  A turn-based combined-arms strategy game played across a contested hex-grid battlefield.
</p>

<p align="center">
  <a href="https://atritheone.com/assurance">Website</a>
  ·
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#building-and-packaging">Builds</a>
  ·
  <a href="LICENSE">MIT license</a>
</p>

## About the game

Assurance puts you in command of either The Empire or The Alliance. Build a force, advance through fog-of-war, seize both Gates, break the enemy Barrier, and hold the opposing Base long enough to secure victory.

The battlefield combines positional combat with an economy, production queues, research, unit upgrades, reconnaissance, supply, and a multi-layered enemy planner. Every decision competes for time, funds, and momentum.

## Highlights

- Two playable factions with different elite facilities and units: The Empire's Spectral and The Alliance's Reaper.
- Fourteen ground and air unit types, from Infantry, Tanks, and Artillery to Ghosts, Bombers, and support vehicles.
- Three AI difficulty levels backed by campaign planning, task forces, threat assessment, fog-aware targeting, retreats, repairs, and production strategy.
- Fog-of-war, last-seen intelligence, stealth attacks, terrain penalties, barriers, and layered air/ground occupancy.
- Production and research queues, three unit levels, field upgrades, and a secondary Gain economy for instant actions.
- Custom starting forces and economies for both sides.
- Named JSON saves in the desktop build and local browser saves in standalone builds.
- Desktop, single-file browser, and Android build targets.

## How a campaign works

1. Produce unit material and research new facilities or upgrades.
2. Deploy units from your back row, Supply Trucks, or Command Helis.
3. Scout through fog-of-war and contest the West and East Gates.
4. Hold each Gate for two consecutive turns with a capture-capable unit.
5. Own both Gates to bring down the opposing Barrier and enter the enemy Base Area.
6. Hold the enemy Base for four consecutive turns to win.

Capture-capable units are Infantry, Operators, Ghosts, and Spectrals. Losing a Gate restores the Barrier; units stranded behind it take attrition until they retreat or both Gates are recaptured.

### Key battlefield rules

| System | Rule |
| --- | --- |
| Gates | Each captured Gate reveals its side of the map and costs £1B per day to maintain. |
| No Man's Land | Units lose 1 movement, attack range, and sight range. |
| Enemy Base Area | Units lose 2 movement, attack range, and sight range. Entry requires control of both Gates. |
| Combat | Attacks have a 10% miss chance and a 10% critical chance for 50% additional damage. |
| Stealth | Attacking from the opponent's fog-of-war deals 20% additional damage. |
| Repair | Units repair on their back row or near a friendly Supply Truck or Command Heli. |
| Gain | Earned from destroyed units and support units; can accelerate production, research, and upgrades. |

The in-game Help screen contains the complete rules and detailed cards for every unit and level.

## Controls

| Input | Action |
| --- | --- |
| Click | Select units and hexes, then issue available movement or attack actions. |
| Left/right side of a hex | Choose movement or attack when both are valid on the same target. |
| Drag the map | Pan the battlefield. |
| Mouse wheel | Zoom around the pointer. |
| <kbd>A</kbd> | End the current turn. |
| <kbd>P</kbd> | Pause or resume. |
| <kbd>Esc</kbd> | Open the in-game menu or close an overlay. |
| <kbd>Enter</kbd> | Continue from welcome and result screens. |

## Quick start

### Requirements

- A current Node.js LTS release
- npm

Install the locked dependencies and start the Electron development build:

```sh
npm ci
npm run dev
```

Run the normal verification suite before submitting changes:

```sh
npm test
npm run build
```

## Available commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Electron app with the Vite development server. |
| `npm test` | Bundle and run the TypeScript test suite with Node's test runner. |
| `npm run build` | Type-check and create the production Electron bundles in `dist/`. |
| `npm run check:ai` | Run the extended, parallel AI behavior scenarios. |
| `npm run build:standalone` | Produce a self-contained `dist/assurance-standalone.html`. |
| `npm run dist:win` | Create a Windows x64 portable executable. |
| `npm run dist:linux` | Create a Linux x64 Debian package. |
| `npm run dist:mac` | Create macOS DMG and ZIP packages. |
| `npm run prepare:linux-vm` | Prepare clean Linux VM build inputs under `release/`. |
| `npm run prepare:mac-vm` | Prepare clean macOS VM build inputs under `release/`. |

Generated files are written to `dist/` and `release/`; both directories are intentionally excluded from version control.

## Building and packaging

### Desktop

Build the application bundle for the current development environment:

```sh
npm run build
```

Platform installers must be built on, or with access to, the corresponding platform toolchain:

```sh
npm run dist:win
npm run dist:linux
npm run dist:mac
```

The Windows target is a portable x64 executable, Linux produces an x64 `.deb`, and macOS produces `.dmg` and `.zip` artifacts.

### Standalone browser build

```sh
npm run build:standalone
```

This inlines the compiled renderer, font, icon, and sound assets into `dist/assurance-standalone.html`. Browser saves use local storage; the Electron build reads and writes JSON save files.

### Android

The Capacitor wrapper is isolated in `platforms/android-wrapper`. It consumes the root renderer build and adds Android-specific layout, navigation, save handling, and embedded sound assets.

See the [Android wrapper guide](platforms/android-wrapper/README.md) for Android Studio setup, syncing, and debug APK instructions.

## Project structure

```text
assurance/
├── src/
│   ├── main/                 Electron main process and desktop save bridge
│   ├── preload/              Context-isolated renderer API
│   └── renderer/
│       ├── canvas/           Hex-grid interaction and rendering
│       ├── data/             Unit and building definitions
│       ├── game/             Rules, economy, combat, AI, fog, and state
│       ├── save/             Browser and desktop save abstractions
│       └── ui/               Navigation, panels, and game information
├── tests/                    Campaign, AI, and UI behavior tests
├── scripts/                  Test, AI-check, standalone, and packaging tools
├── build/                    Canonical icons and sound assets
├── flash/                    Source branding artwork
└── platforms/android-wrapper Capacitor Android project
```

The Electron renderer runs with Node integration disabled and communicates with desktop functionality through the context-isolated preload bridge.

## Testing

The standard suite covers game rules, economy and Gain behavior, fog-of-war information, supply and repair mechanics, campaign sequences, AI decisions, and UI log behavior.

```sh
npm test
```

For the slower strategic AI scenario matrix:

```sh
npm run check:ai
```

## License

Assurance is available under the [MIT License](LICENSE).
