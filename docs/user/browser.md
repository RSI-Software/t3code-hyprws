# Built-in browser

T3 Code includes a built-in preview browser beside your conversation so you and your agents can inspect local dev servers, annotate UI issues, record flows, and test web apps without leaving the thread.

## Open and navigate

- Open the right panel in a thread and choose **Browser** (or click a running dev server in the thread's **Servers** list).
- **Local vs. remote**: On the desktop app, tabs for your local environment run natively. On web, mobile, or remote environments, tabs stream from the host's headless Chromium (~120 MB one-time download; see [Browser host setup](./remote-access.md#browser-host-setup)). On desktop, tabs you open for a remote environment can also load locally over the [preview tunnel](./remote-access.md#browser-on-a-remote-environment).
- **Find on page**: Press `mod+f` inside a desktop browser tab (or use its **⋮** menu if the page intercepts `mod+f`).
- **Default browser (macOS)**: You can set the desktop app as your [default web browser](./default-browser.md).

## Profiles, viewports, and settings

Configure defaults in **Settings → Browser**:

- **Browser profiles**: Maintain separate cookie/storage profiles and set a **Default browser profile**. Desktop users can copy signed-in cookies from Chrome, Safari, Firefox, Zen, or Helium ([Import browser sessions](./browser-import.md)).
- **Viewport, zoom & appearance**: Set **Default browser viewport** (fill, freeform, or phone/tablet presets with portrait/landscape rotation), **Default browser zoom**, and **Default browser appearance** (system/light/dark).
- **Links & search**: Configure **Open links in** and **Search engine**.

## Pick elements, annotate, and record

- **Element picker & annotations**: Pick elements or annotate regions on the page to attach them directly into the composer as inline context chips.
- **Screen recordings**: Record browser interactions directly from the tab toolbar. Configure **Browser recording frame rate**, **Show key presses in recordings**, and **Show mouse presses in recordings** in **Settings → Browser**.

## Agent browser access

Agents can open tabs, navigate, click, type, inspect accessibility snapshots, and take screenshots using T3 Code's `preview_*` tools.

- Toggle **Settings → Browser → Agent browser access** (per environment or project override; takes effect when the next agent session starts).
- **Floating preview**: By default, agent-opened tabs float over chat, and closing the right panel floats its browser tab (**Settings → Browser → Auto-show floating preview**). Turn this off to open agent tabs in the right panel instead and to close the panel without a float.
- **Take control**: Click **Take control** before interacting with an agent's tab, and release control when you want the agent to resume.

# Browser bookmarks

The desktop browser can keep frequently used pages close to the project where you use them or available everywhere in the same T3 Code profile.

## Save a page

Open a page, then select the star at the right of the address field. Choose one scope:

- **Project bookmark** appears only while browsing from the current project.
- **Global bookmark** appears from every project window that uses the same T3 Code profile.

The star is filled when the current page is bookmarked. Open it again to move the bookmark between scopes or remove it.

## Open a bookmark

Open a new browser tab. Saved pages appear before Recently used and Local servers, with Project bookmarks first and Global bookmarks second. Select a bookmark to open it in the current tab.

Empty bookmark sections stay hidden. Bookmarks persist across app restarts, and equivalent URL forms are kept as one bookmark.

Global bookmarks are local to the current T3 Code profile. They do not sync to a different profile, server, or device.
