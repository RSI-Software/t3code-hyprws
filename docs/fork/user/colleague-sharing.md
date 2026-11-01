# Colleague sharing

Share a thread with a colleague's own T3 Code app.
Their messages run on your machine, with your agents, marked with their name.

## Share a thread

1. Right-click the thread in the sidebar
2. Choose **Share to colleague**
3. Type their name, then **Share**
4. Send them the link

The link is a normal `https` page, so any chat makes it clickable.
It offers **Open in desktop app** or **Continue in this browser**.
Either opens your shared thread; the app also adds it to their sidebar.
The link expires after 24 hours.

## Share more threads

A colleague with at least one shared thread shows as **Share with <name>**.
The thread appears in their sidebar right away; no new link needed.

## Stop sharing

Open **Share to colleague** on the thread, then **Stop sharing** beside their name.
Their copy stays in their sidebar, frozen at that moment and marked **Disconnected from host**.
They can still read and copy it; sends are refused.
Sharing again brings it back to live.

## What they can reach

- **Sidebar:** only the threads you shared
- **Messages:** only to shared threads
- **Reads:** diffs and search in shared threads
- **Nothing else:** no terminals, files, or settings

To cut access completely, revoke their session in **Settings → Connections**.

## Reachability

Your colleague must reach your server from their network.
The link address comes from, in order:

1. Your local Cloudflare Tunnel hostname
2. Your T3 Code address, when not local
3. A local network address

A local network address works only on your network; the dialog warns when the link uses one.
