---
title: Rich Markdown showcase
status: ready to edit
---

# Rich Markdown showcase

Open this file in T3 Code and switch it to Rich mode.
Edit the document you see while keeping ordinary Markdown on disk.

Open [README.md](../../README.md) as a workspace file chip, or visit [Milkdown](https://milkdown.dev/).

## Task-list controls

- [ ] Toggle this checkbox in Rich mode.
- [ ] Confirm the change remains after switching to Source mode.
- [ ] Edit this task label directly.

## Text and structure

Use **bold**, _emphasis_, ~~strikethrough~~, and `inline code` in the same paragraph.

> The rich editor changes the view, not the file format.

Nested content works too:

1. Write naturally.
2. Keep the source portable.
   - Add unordered items beneath an ordered step.
   - Follow a [workspace link](../../README.md) without leaving T3 Code.

---

## Table

| Markdown feature      | Rich-mode behavior                   |
| --------------------- | ------------------------------------ |
| Headings and emphasis | Editable in place                    |
| Task lists            | Interactive checkboxes               |
| Workspace links       | File chips that open in T3 Code      |
| Fenced code           | Shared theme and syntax highlighting |

## Highlighted TypeScript

```ts
type EditorMode = "source" | "rich";

const editor = {
  engine: "Milkdown",
  mode: "rich" as EditorMode,
  autosave: true,
};

console.log(`${editor.engine}: ${editor.mode}`);
```

## Highlighted JSON

```json
{
  "markdown": true,
  "portable": true,
  "format": "CommonMark + GFM"
}
```

That is the MVP: a useful editing surface without a second document format.
