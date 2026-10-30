# Colleague sharing

Share a thread with a colleague's own T3 Code app.
Their messages run on your machine, with your agents, marked with their name.

## Share a thread

1. Right-click the thread in the sidebar
2. Choose **Share to colleague**
3. Type their name, then **Share**
4. Send them the link

The link opens their desktop app, pairs it with your server, and opens the thread.
It expires after 24 hours.

## Share more threads

A colleague with at least one shared thread shows as **Share with <name>**.
The thread appears in their sidebar right away; no new link needed.

## Stop sharing

Open **Share to colleague** on the thread, then **Stop sharing** beside their name.
The thread leaves their sidebar.
If they have it open, it stops updating and their messages no longer send.

## What they can reach

- **Sidebar:** only the threads you shared
- **Messages:** only to shared threads
- **Everything else:** a paired client's normal access

Pairing is environment-wide: share only with people you trust on that machine.
To cut access completely, revoke their session in **Settings → Connections**.

## Reachability

Your colleague's app must reach your server, for example over Tailscale or your own domain.
Set `T3CODE_COLLEAGUE_PUBLIC_URL` to the address they use, such as `https://t3.example.com`.
