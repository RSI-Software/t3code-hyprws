# Collaborator sharing

Share a thread with a collaborator's own T3 Code app.
They follow it live; their messages **run on your machine**, with your agents, marked with their name.
In their sidebar, the thread's card is marked **Shared by** you.
Above the composer, each of you sees **the other's unsent draft** live, read-only; attachments and other context show by name only.
Passages either of you cites stay **marked in the transcript** in that person's colour, with their initial; hover one to read whose it is and their comment.

## Share a thread

1. **Right-click** the thread in the sidebar
2. Choose **Share with collaborator** or **Someone new…**
3. Type their **name** and choose **Share**
4. **Send them** the link

The link opens in their desktop app or browser; unopened, it **expires after 24 hours**.
Once they open it, their access **does not expire**; it lasts until you stop sharing or remove their device.
To share another thread with someone you shared with before, pick their name under **Shared before**; no new link is needed.

## Save each other as colleagues

Open the link in **your own T3 Code app**: from the desktop app, or pasted into **Settings → Environments → Add environment**.
You each save the other as a **colleague**, and both apps say so: **Saved Jordan as a colleague**.

- Threads they share with you later **appear live**, with no new link
- A colleague sees **nothing of yours** until you share a thread
- In a browser with no T3 Code of its own, you stay a **one-time guest**

To share with a saved colleague, right-click the thread, then **Share with → their name**: **one click**, no link.
The share dialog and command palette offer the same.

## Approve their messages

By default each collaborator **Needs approval**: their messages **wait for you** at the end of the thread, with **Send** and **Dismiss**.
Switch them to **Can send** to let messages **reach the agent** at once.
Change it beside their name in the share dialog, or under **Collaborators** in the thread details.

While approval is on, they **send text only** and can **Withdraw** a waiting message.
They see which you did: **Sent by the host** under a sent message, or **Dismissed by the host** on a dismissed one until they clear it.

## Stop sharing

Open **Share with collaborator** on the thread, then **Stop sharing** beside their name.
For a saved colleague, **pick their checked name** under **Share with** again.
Their waiting messages are dropped, and their copy **freezes**, marked **Disconnected from host**.
Sharing again brings it back to live.

To **cut all access**, revoke their session in **Settings → Connections**; a saved colleague is forgotten too.

## What they can reach

- **Only threads** you shared
- **Diffs and search** in those threads
- **No terminals**, files, or settings

## Reachability

Your collaborator must **reach your server** from their network.
The link uses your Cloudflare Tunnel hostname or public T3 Code address when you have one; otherwise a local address that **works only on your network**, and the dialog warns you.
