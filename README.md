# Immich Image-to-Image Search

A Chrome Manifest V3 extension for searching an Immich library using a reference image. Paste an image, drag and drop it, or select it with the file picker.

## Requirements

- A reachable Immich server with Smart Search enabled and indexing available.
- An Immich API key with permission to read the current user (`user.read`), upload assets, list and create albums, add assets to albums, and run Smart Search.
- The Immich account signed in to the browser must be the same account that owns the API key. The extension verifies this before opening native search results.
- Chrome with Manifest V3 extension support.

## Install for testing

1. Open `chrome://extensions` and enable Developer mode.
2. Select **Load unpacked** and choose this extension folder.
3. Open the extension's **Details → Extension options**.
4. Select **Add profile** and enter a profile name, Immich server origin, and API key.
5. Save the profile and allow Chrome to access that server when prompted.
6. The extension verifies the API key's user identity against the account signed in to Immich. A successful verification is shown in the saved profile.
7. Select the profile you want to use as active.
8. Open the extension popup, paste (`⌘V`), drop, or choose a reference image, then press **Enter** or select **Search my Immich library**.

The server URL must be an origin only: do not include a path, username, password, query string, or fragment. Use HTTPS when your Immich server supports it. Plain HTTP may expose API traffic on the local network.

## Multiple profiles

- Save multiple Immich server/account profiles in Extension options.
- Each profile has its own server origin, API key, and reference album ID.
- Select an active profile to choose which Immich account the popup uses.
- You can edit or remove saved profiles.
- The extension verifies the API identity for a profile before treating it as verified. Make sure the browser is signed in to the matching Immich account before using native search results.

Profile settings and API keys are stored locally in the current Chrome profile.

## Reference album

The extension automatically looks for an album named **Image2Image References** on the active Immich server. If it does not exist, the extension creates it and saves its ID in that profile. Newly uploaded reference assets use archived visibility and are added to this album. If Immich reports that an asset is a duplicate, the extension reuses the existing asset and ensures album membership without changing that asset's existing visibility. The extension does not delete references.

## Search behavior

- Uploads the selected image to Immich.
- Reuses an existing asset when Immich reports a duplicate.
- Ensures the reference asset belongs to the Image2Image References album.
- Runs Immich Smart Search using `queryAssetId`, excluding the reference asset from similar results.
- Polls for results for up to 60 seconds.
- Shows an animated activity indicator and elapsed-time counter while waiting for Smart Search indexing. The indicator respects the operating system's reduced-motion preference.
- Opens Immich's native search page when results are found. If indexing is not ready, the popup offers to open native search anyway.

## Privacy and permissions

- Profile settings, including API keys, are stored in `chrome.storage.local` in the user's Chrome profile.
- The extension requests optional host access for configured Immich server origins.
- The API key is sent only to the server configured in the selected profile.
- No analytics, external service, third-party library, or background service worker is included.
