# Xcode Setup — What to do on the Mac

Everything in `swift/` is hand-written Swift. You just need to wire it into a new Xcode project.

## Step 1: Generate the Xcode project skeleton

```bash
xcrun safari-web-extension-converter \
  /path/to/brainrot-filter/extension/ \
  --app-name "Brainrot Filter" \
  --bundle-identifier com.brainrotfilter.app \
  --swift \
  --ios-only
```

This creates a folder called `Brainrot Filter/` with two Xcode targets:
- `Brainrot Filter` — the iOS app
- `Brainrot Filter Extension` — the Safari extension

## Step 2: Replace the generated Swift files

The converter generates placeholder Swift files. Replace them with the files from `swift/`:

| Replace this generated file | With this file from `swift/` |
|---|---|
| `Brainrot Filter/AppDelegate.swift` (or similar) | `App/BrainrotFilterApp.swift` |
| `Brainrot Filter/ViewController.swift` | `App/ContentView.swift` |
| *(add new file)* | `App/SettingsView.swift` |
| *(add new file)* | `App/Models/AppSettings.swift` |
| `Brainrot Filter Extension/SafariWebExtensionHandler.swift` | `Extension/SafariWebExtensionHandler.swift` |

The extension JS files (`content.js`, `background.js`, `manifest.json`) should already be in
`Brainrot Filter Extension/Resources/` — the converter puts them there from the `extension/` folder.

## Step 3: Add an App Group

Both targets need to share the same App Group so settings flow from app → extension.

1. Select the **Brainrot Filter** target → Signing & Capabilities → `+` → **App Groups**
   - Add group: `group.com.brainrotfilter.app`
2. Select the **Brainrot Filter Extension** target → repeat the same step
3. Make sure `AppSettings.appGroupID` in `AppSettings.swift` matches exactly

## Step 4: Update bundle identifiers

- Main app:  `com.brainrotfilter.app`
- Extension: `com.brainrotfilter.app.extension`

Update the matching string in `ContentView.swift`:
```swift
private let extensionBundleID = "com.brainrotfilter.app.extension"
```

And in `background.js`:
```js
const APP_BUNDLE_ID = "com.brainrotfilter.app";
```

## Step 5: Add the SafariServices framework

Select the **Brainrot Filter** target → General → Frameworks, Libraries, and Embedded Content → `+` → `SafariServices.framework`

## Step 6: Build and test

- Simulator: build the main app target, open Safari in the sim, enable the extension
- Device: connect iPhone, select device, build, install, enable in Settings → Safari → Extensions

## Icons

Drop PNG icons into `extension/icons/`:
- `icon-48.png`  (48×48)
- `icon-128.png` (128×128)
- `icon-512.png` (512×512 — for App Store)

Any tool (Canva, Sketch, even Preview) works for resizing.
