---
title: Rich Markdown showcase
status: ready to edit
---

# Rich Markdown showcase

Open this file in Rich mode and edit it; the file stays plain Markdown.

Open [README.md](../../README.md) as a file chip, or visit [Milkdown](https://milkdown.dev/).

## Task-list controls

- [ ] Toggle this checkbox
- [ ] Check it in Source mode
- [ ] Edit this label

## Text and structure

Use **bold**, _emphasis_, ~~strikethrough~~, and `inline code` together.

> The view changes, not the file format.

1. Write naturally
2. Keep the source portable
   - Nest a bullet under a step
   - Follow a [workspace link](../../README.md)

---

## Table

| Feature         | Rich mode           |
| --------------- | ------------------- |
| Headings        | Editable in place   |
| Task lists      | Checkboxes          |
| Workspace links | File chips          |
| Fenced code     | Syntax highlighting |

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
