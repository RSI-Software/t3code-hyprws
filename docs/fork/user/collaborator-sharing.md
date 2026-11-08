# Collaborator sharing

Share a thread with a collaborator's own T3 Code app.
They follow it live; their messages **run on your machine**, with your agents, marked with their name.

## Share a thread

1. Right-click the thread in the sidebar
2. Choose **Share with collaborator**
3. Type their name and choose **Share**
4. Send them the link

The link **expires after 24 hours** and opens in their desktop app or browser.
To share another thread with someone you shared with before, pick their name under **Shared before**; no new link is needed.

## Approve their messages

By default each collaborator **Needs approval**: their messages **wait for you** at the end of the thread, with **Send** and **Dismiss**.
Switch them to **Can send** to let messages **reach the agent** at once.
Change it beside their name in the share dialog, or under **Collaborators** in the thread details.

While approval is on, they **send text only** and can **Withdraw** a waiting message.

## Stop sharing

Open **Share with collaborator** on the thread, then **Stop sharing** beside their name.
Their waiting messages are dropped, and their copy **freezes**, marked **Disconnected from host**.
Sharing again brings it back to live.

To **cut all access**, revoke their session in **Settings → Connections**.

## What they can reach

- **Only threads** you shared
- **Diffs and search** in those threads
- **No terminals**, files, or settings

## Reachability

Your collaborator must **reach your server** from their network.
The link uses your Cloudflare Tunnel hostname or public T3 Code address when you have one; otherwise a local address that **works only on your network**, and the dialog warns you.
