# Collaborator sharing

Share a thread with a collaborator's own T3 Code app.
They follow it live; their messages run on your machine, with your agents, marked with their name.
The agent treats them as it would yours and answers them in the thread.

## Share a thread

1. Right-click the thread in the sidebar
2. Choose **Share with collaborator**
3. Type their name and choose **Share**
4. Send them the link

The link is a normal `https` page, so any chat makes it clickable.
It offers **Open in desktop app** or **Continue in this browser**.
Either opens your shared thread; the app also adds it to their sidebar.
The link expires after 24 hours.

## Access

Each shared thread has its own access, set beside their name under **People with access**, or with their switch under **Collaborators** in the thread details:

- **Needs approval**, the default: messages **wait for you**
- **Can send**, so messages **reach the agent** at once

Sharing again keeps the access you set.

A waiting message shows at the end of the thread, with **Send** and **Dismiss**.
You also get a notice when you are elsewhere.
Until you choose, they can **Withdraw** it.
They send text only while approval is on.

## Share more threads

Collaborators you shared other threads with show under **Shared before**; choose their name.
The thread appears in their sidebar right away; no new link needed.

## Stop sharing

Open **Share with collaborator** on the thread, then **Stop sharing** beside their name.
Their waiting messages are dropped.
Their copy stays in their sidebar, frozen at that moment and marked **Disconnected from host**.
They can still read and copy it; sends are refused.
Sharing again brings it back to live.

## What they can reach

- **Sidebar** shows only the threads you shared
- **Messages** go only to shared threads
- **Diffs and search** only in shared threads
- **No terminals**, files, or settings

To cut access completely, revoke their session in **Settings → Connections**.

## Reachability

Your collaborator must reach your server from their network.
The link address comes from, in order:

1. Your local Cloudflare Tunnel hostname
2. Your T3 Code address, when not local
3. A local network address

A local network address works only on your network; the dialog warns when the link uses one.
