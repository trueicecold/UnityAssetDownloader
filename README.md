# Unity Asset Downloader

Desktop app (Electron) and CLI that sign in to your Unity account, list every
Asset Store package you own, and download the `.unitypackage` files directly.

## Setup

```sh
npm install
npm link        # optional: puts `uad` on your PATH
```

## Desktop app

```sh
npm start       # or: uad gui
```

Sign in with the regular Unity ID web login (email, Google, Apple, …). After that you can:
- search, filter (not downloaded / downloaded / update available) and sort your assets
- download one at a time, or press "Download shown"
- cancel downloads, which resume later
- pick the download folder

## CLI

```sh
uad login                         # opens the Unity sign-in window
uad login --cookie "<header>"     # headless: paste a Cookie header from a signed-in browser
uad status
uad list [search] [--updates] [--json]
uad download 12345 "Some Asset"   # by ID or (unique) name
uad download --updates            # update every outdated package in the folder
uad download --all [--search text] [--out dir] [-j 3] [--force]
uad config downloadDir ~/UnityPackages
uad logout
```

Exit codes: `0` ok, `1` errors, `2` not signed in / session expired.

## Settings

Open Settings with the ⚙︎ button or Cmd/Ctrl + `,`. The same settings are used by the CLI
(`uad config [key] [value]`) and stored in `~/.unity-asset-downloader/config.json`.

| Setting | Values | |
|---|---|---|
| `downloadDir` | path | Where packages go. Existing packages in it are detected. |
| `concurrency` | 1–8 | Parallel downloads. A change applies right away to queued downloads. |
| `layout` | `flat` / `publisher` | Put new downloads in a subfolder per publisher. |
| `keepOldVersions` | `true` / `false` | On update, keep the old file renamed `Name (v1.2).unitypackage` instead of deleting it. |
| `notify` | `true` / `false` | Desktop notification when a batch of downloads finishes. App only. |
| `theme` | `system` / `light` / `dark` | App only. |

## Building executables

```sh
npm install
npm run dist:mac    # dist/*.dmg + *-mac.zip  (Apple Silicon "-arm64" and Intel)
npm run dist:win    # dist/Unity Asset Downloader Setup x.y.z.exe (installer) + portable .exe
npm run dist        # both
```

Both platforms build fine from a Mac. Windows builds don't need Wine.

**Signing.** The Mac app is ad-hoc signed (`build/after-pack.js`), not signed with a
Developer ID. On first launch of a downloaded copy, right-click the app and choose Open, or run
`xattr -dr com.apple.quarantine "/Applications/Unity Asset Downloader.app"`. The Windows
build is unsigned, so SmartScreen shows "More info → Run anyway". Proper signing needs an
Apple Developer ID (with `mac.identity` set and notarization) or a Windows code-signing
certificate.

**CLI from an installed build.** No Node install is needed. The app includes a launcher that runs
its own executable in Node mode:

- macOS:
  ```sh
  sudo ln -sf "/Applications/Unity Asset Downloader.app/Contents/Resources/bin/uad" /usr/local/bin/uad
  ```
- Windows (installer build): add `%LOCALAPPDATA%\Programs\Unity Asset Downloader\resources\bin`
  to your PATH, then run `uad …` in any terminal. The portable `.exe` is GUI only.

## How it works

The app uses the same endpoints as the "My Assets" page on assetstore.unity.com,
authenticated with your web session cookies:

| Purpose | Endpoint |
|---|---|
| List owned assets | `POST /api/graphql/batch` (`SearchMyAssets`, needs `x-csrf-token` = `_csrf` cookie) |
| Download | `GET /api/downloads/{id}`. When you're signed out, this redirects to Unity OAuth. |

The session is stored in `~/.unity-asset-downloader/session.json` (mode 0600) and is
shared by the GUI and the CLI. Set `UAD_HOME` to move it.

### Detecting downloads and updates

Every Asset Store `.unitypackage` embeds its metadata in a gzip header field (`A$`), for
example `{"id":"17256","version":"1.6","version_id":"1030794",...}`. The app scans the
download folder, including subfolders, and matches each package to your owned assets by ID.
This works for any package in the folder, not just ones this app downloaded.

- **Up to date:** the asset is marked *downloaded vX*.
- **Newer version on the store:** the asset is marked *update: vX → vY*, and Update (or
  `uad download --updates`) downloads the new version and replaces the old file.

`.uad-index.json` in the folder is a fallback for packages with no embedded metadata.
Partial downloads are kept in `.partial/` and resume automatically.

These are undocumented Unity web APIs and may change without notice.
