# Colleague sharing

Share a thread with a colleague's own T3 Code app.
Their messages run on your machine, with your agents, marked with their name.

## Share a thread

1. Right-click the thread in the sidebar
2. Choose **Share to colleague**
3. Type their name, then **Share**
4. Send them the link

The link opens their desktop app, asks them to open your shared thread, and adds it to their sidebar.
It expires after 24 hours.

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

Your colleague's app must reach your server, for example over Tailscale or your own domain.
The link uses the address you opened T3 Code from, when it is not `localhost`.
Set `T3CODE_COLLEAGUE_PUBLIC_URL` to override it, such as `https://t3.example.com`.
