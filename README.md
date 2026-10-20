# folio

A minimal, fast EPUB reader for people who just want to sit down and read.
Built with Tauri 2 and vanilla JavaScript, rendered by foliate-js.

No sync. No accounts. No cloud. Your library is a JSON file on your disk.

## Features

- Library shelf with covers, authors and reading progress
- Paginated reader: turn pages by clicking the page edges, arrow keys,
  space bar, or the mouse wheel
- Resume every book exactly where you left off
- Table of contents panel
- Highlighting: select text and pick one of four colors, or copy it;
  click any highlight later to remove it
- Font size control and three themes: light, sepia, dark
- Open books with the file picker, or drop EPUB files on the window

### Small on purpose

- The Linux installer is about 2 MB and the standalone binary is 5 MB,
  which is small enough to keep multiple releases around or run it from
  a USB stick
- No framework, no bundler, no runtime beyond the system webview: the
  whole frontend is a handful of plain HTML/CSS/JS files, so cold start
  is near instant
- Library state is a single readable JSON file, not a database; you can
  open it, back it up, or diff it
- It does one thing and therefore stays light: no services, no update
  daemons, no background tasks of any kind

## Installing

Grab the installer for your platform from the
[Releases page](../../releases) and install it:

| Platform | File |
| --- | --- |
| Windows 64 bit | `.msi` or `-setup.exe` from the release |
| macOS Apple Silicon | `aarch64.dmg` |
| macOS Intel | `x64.dmg` |
| Debian / Ubuntu | `.deb` |
| Fedora / openSUSE | `.rpm` |
| Any Linux | `.AppImage` |

The binaries are unsigned, so expect one polite warning per platform:
Windows SmartScreen asks you to confirm with More info then Run anyway;
macOS Gatekeeper asks to approve the app after the first open.

## Building from source

Requirements: Node.js 20+, Rust 1.77+, and the platform dependencies
listed in the
[Tauri guide](https://v2.tauri.app/start/prerequisites/).

```
npm install
npm run tauri dev      # run in development
npm run tauri build    # produce installers for your platform
```

Cross compiling is not supported, so Windows and macOS installers are
built by the included GitHub Actions workflow whenever a `v*` tag is
pushed. A draft release with all platform installers appears
automatically.

## Usage

| Key | Action |
| --- | --- |
| Left, Right, Space | Turn page |
| T | Table of contents |
| Esc | Close panel, then leave the reader |
| Home | Jump to the start |

Select text inside a book to highlight it in four colors or copy it.
Click a highlight to remove it. Mouse wheel also turns pages.

## Where your data lives

One JSON file plus thumbnails and imported books:

- Linux: `~/.local/share/app.folio/`
- Windows: `%APPDATA%/app.folio/`
- macOS: `~/Library/Application Support/app.folio/`

Older folio versions used a personal folder name; data there is moved
over automatically on first run. Delete the folder to reset the app.

## Project layout

```
src/                  frontend, plain HTML/CSS/JS, no build step
src/vendor/           vendored foliate-js and the style sheets polyfill
src-tauri/            Rust shell, 5 small commands, no other logic
.github/workflows/    CI builds for all three platforms
```

## License

MIT. The vendored foliate-js is MIT by John Factotum and keeps its own
license file in `src/vendor/foliate-js/LICENSE`.
