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

A share link **shares that one thread only**: it saves no colleague and opens no team project.

## Save each other as colleagues

You **invite a colleague on purpose**, in one of two ways:

- Tick **Also save as colleague** when sharing
- **Invite colleague** in Settings: **no thread**

They open the link in **their own T3 Code app**: from the desktop app, or pasted into **Settings → Environments → Add environment**.
You each save the other as a **colleague**, and both apps say so: **Saved Jordan as a colleague**.
The sharer's app names them by **the name they typed**; theirs names the sharer by **their git `user.name`**, else by their machine.
In a browser with no T3 Code of its own, they stay a **one-time guest**.

A saved colleague **reads**:

- Every thread of your **team projects**
- The threads you **share with them**

To share with a saved colleague, right-click the thread, then **Share with → their name**: **one click**, no link.
The share dialog and command palette offer the same; a thread you share **appears live** in their sidebar.

**Settings → Sharing & access → Colleagues** lists each colleague with **your team projects** and the threads you share with them.
**Remove** ends their access on both sides; if their machine is unreachable, it still lists you until it is removed there too.

## Team projects

Turn on **Team** in a project's settings, or run **Mark as team project** from the command palette.
Only **someone with sharing rights** on that machine sees these controls; an agent marks a project only for such a person.

Every saved colleague then **reads all its threads**, past and **archived** ones included, with no share.
Their card reads **Team project**; their messages there **wait for your approval**.
A thread you also share by hand follows **that share's access**.
Turning **Team** off ends their access at once.

## Ask your agent what colleagues are doing

Your agents read **what a saved colleague lets you read**: their team project threads and the threads they share with you.
Ask, for example: "What is Alex working on?" or "Has Alex already fixed the login timeout?"
These reads **never send, run, or change** anything on their machine.

## Browse a colleague's inbox

**Switch inbox** at the top of the sidebar shows **My inbox** or **Alex's inbox**: every thread of theirs you can read.
Their threads open **read-only** there; a thread they shared with you **still sends** as that share allows.

## Approve their messages

By default each collaborator **Needs approval**: their messages **wait for you** at the end of the thread, with **Send**, **Reply** and **Dismiss**.
**Reply** answers them from your composer: the agent reads it as said to them, so it usually stays quiet.
Until you answer, the thread's card reads **Requested by** their name and **comes back** from Settled or a snooze.
Switch them to **Can send** to let messages **reach the agent** at once.
Change it beside their name in the share dialog, or under **Collaborators** in the thread details.

**Can send** is **full access to that thread**: they also approve or deny the agent's permission prompts, answer its questions, switch the model, and stop a turn.

While approval is on, they **send text only** and can **Withdraw** a waiting message.
A message sent with **Ask the agent** waits marked **Asks the agent**; once you send it, the agent **answers it**.
They see which you did: **Sent by the host** under a sent message, **Replied to** their name above your reply, or **Dismissed by the host** on a dismissed one until they clear it.

## Quiet replies

In a shared thread, the agent **stays quiet** when people talk to each other; it answers what is asked of it.
Its slot reads **Agent stayed quiet**; choose **Ask the agent** to get an answer anyway.

## Send while they are offline

A message to a colleague's thread while their machine is offline **waits on yours**, marked **Sends when Alex is back**.
It goes **once they are back**, in order, while **your app is open**.
If they stop sharing first, it reads **Not sent: no longer shared**, with **Copy** and **Remove**.

## Stop sharing

Open **Share with collaborator** on the thread, then **Stop sharing** beside their name.
For a saved colleague, **pick their checked name** under **Share with** again.
Their waiting messages are dropped, and their copy **freezes**, marked **Disconnected from host**.
That copy stays **only where they opened the thread before**; any other device or browser shows **No copy on this device**.
Sharing again brings it back to live.

To **cut all access**, revoke their session in **Settings → Connections**; a saved colleague is forgotten too.

## What they can reach

- **Only threads** you shared
- A colleague: **team project** threads too
- **Diffs and search** in those threads
- **No terminals**, files, or settings
- **Only their own** queued messages to edit or remove

## Reachability

Your collaborator must **reach your server** from their network.
A colleague's machine must **reach yours too**: when it can't, their save says **Saved Jordan, but they can't reach you**, with **Retry**.
While yours is offline, their app **still opens your shared threads** from its own copy, saying **when it last synced**; the copy catches up once you are back.
They can **Fork to my machine** from the thread menu: it copies the thread into **their own project**, even while yours is offline, and links back to yours.
While yours answers, it copies **images and files** too; offline, the new thread **names the ones it lacks**.
The link uses your Cloudflare Tunnel hostname or public T3 Code address when you have one; otherwise a local address that **works only on your network**, and the dialog warns you.
