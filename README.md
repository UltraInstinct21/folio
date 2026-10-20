# folio

A minimal personal EPUB reader built with Tauri 2, vanilla JavaScript and foliate-js.

## Features

- Library view with covers, author names and reading progress
- Paginated reader with page turning by click, keyboard or mouse wheel
- Resume where you left off, per book
- Table of contents panel
- Text selection toolbar: 4 highlight colors, copy, remove
- Font size control and three themes: light, sepia, dark
- Open books with the file picker or drag and drop

There is no sync, no search, no account, no cloud. That is intentional.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Left / Right, Space | Turn page |
| T | Table of contents |
| Esc | Close panel, then leave reader |
| Home | Jump to start |

## Run in dev

```
npm install
npm run tauri dev
```

## Build for Linux

```
npm run tauri build
```

Produces:

- `src-tauri/target/release/bundle/deb/folio_*.deb` (installs to the app menu)
- `src-tauri/target/release/bundle/appimage/folio_*.AppImage` (run anywhere)

A bare 5 MB binary is also produced at `src-tauri/target/release/folio`.

## Windows and macOS

Cross compiling from Linux is not supported by Tauri, so macOS and Windows
installers are produced automatically by GitHub Actions:

1. Push this repository to GitHub.
2. Push a tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. The workflow in `.github/workflows/build.yml` builds:
   - Windows: NSIS installer (`.exe`) and MSI
   - macOS: `.app` and `.dmg` for both Apple Silicon and Intel
   - Linux: deb and AppImage
4. A draft GitHub release appears containing all installers. Publish it or
   download the artifacts directly.

## Data

Library state, covers and imported books live in the system app data dir:

- Linux: `~/.local/share/dev.sarthi.ereader/`
- Windows: `%APPDATA%/dev.sarthi.ereader/`
- macOS: `~/Library/Application Support/dev.sarthi.ereader/`

Delete that folder for a hard reset.

## Layout

```
src/                 frontend, plain HTML/CSS/JS, no build step
src/vendor/          vendored foliate-js and style sheets polyfill (MIT)
src-tauri/           Rust shell, 5 commands: load_library, save_library,
                     read_file, import_book, save_cover
.github/workflows/   CI builds for all three platforms
```
