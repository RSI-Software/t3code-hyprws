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
A name you type is always **a new person**, even when it matches someone's.

A plain share link **shares that one thread only**: it saves no colleague.

## Save each other as colleagues

The sharer **invites you on purpose**, in one of two ways:

- Tick **Also save as colleague** when sharing a thread
- **Invite colleague** in Settings: **no thread**

Open the link in **your own T3 Code app**: from the desktop app, or pasted into **Settings → Environments → Add environment**.
You each save the other as a **colleague**, and both apps say so: **Saved Jordan as a colleague**.
The sharer's app names you by **the name they typed**; yours names them by **their git `user.name`**, else by their machine.

- Threads they share with you later **appear live**, with no new link
- A colleague sees **nothing of yours** until you share a thread
- In a browser with no T3 Code of its own, you stay a **one-time guest**

To share with a saved colleague, right-click the thread, then **Share with → their name**: **one click**, no link.
The share dialog and command palette offer the same.

**Settings → Sharing & access → Colleagues** lists each colleague with the threads you share with them.
**Remove** ends their access to every shared thread on both sides; if their machine is unreachable, it still lists you until it is removed there too.

## Ask your agent what colleagues are doing

Your agents read **what a saved colleague lets you read**: their team project threads and the threads they share with you.
Ask, for example: "What is Alex working on?" or "Has Alex already fixed the login timeout?"
These reads **never send, run, or change** anything on their machine.

## Approve their messages

By default each collaborator **Needs approval**: their messages **wait for you** at the end of the thread, with **Send**, **Reply** and **Dismiss**.
**Reply** answers them from your composer: the agent reads it as said to them, so it usually stays quiet.
Until you answer, the thread's card reads **Requested by** their name and **comes back** from Settled or a snooze.
Switch them to **Can send** to let messages **reach the agent** at once.
Change it beside their name in the share dialog, or under **Collaborators** in the thread details.

While approval is on, they **send text only** and can **Withdraw** a waiting message.
A message sent with **Ask the agent** waits marked **Asks the agent**; once you send it, the agent **answers it**.
They see which you did: **Sent by the host** under a sent message, **Replied to** their name above your reply, or **Dismissed by the host** on a dismissed one until they clear it.

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
- **Only their own** queued messages to edit or remove

## Reachability

Your collaborator must **reach your server** from their network.
While yours is offline, their app **still opens your shared threads** from its own copy, saying **when it last synced**; the copy catches up once you are back.
They can **Fork to my machine** from the thread menu: it copies the thread into **their own project**, even while yours is offline, and links back to yours.
While yours answers, it copies **images and files** too; offline, the new thread **names the ones it lacks**.
The link uses your Cloudflare Tunnel hostname or public T3 Code address when you have one; otherwise a local address that **works only on your network**, and the dialog warns you.
