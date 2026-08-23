# Edit Markdown visually

Markdown files can open as a rich document in the web and desktop file preview.
Use the pen button in the file header to switch from source to Rich mode.

Rich mode supports CommonMark and GitHub Flavored Markdown.
This includes headings, emphasis, links, lists, task lists, tables, blockquotes, and code blocks.
YAML frontmatter remains editable as a code-style block.

Workspace file links use the same file chips and file-preview navigation as rendered Markdown.
Task-list checkboxes remain interactive while editing.
Fenced code uses the app theme, syntax highlighter, code font, and word-wrap setting.

Edits save automatically through the same file-save flow as source editing.
Use the code button to return to the Markdown source.

## Try the showcase

Open the [Rich Markdown showcase](./markdown-showcase.md) to exercise the supported syntax in one document.
In T3 Code, search for `docs/user/markdown-showcase.md` and switch it to Rich mode.

## Limits

- MDX files keep their rendered preview because rich editing cannot safely preserve JSX nodes.
- Truncated file previews cannot enter Rich mode.
- Rich mode can normalize equivalent Markdown syntax after an edit, such as unordered-list markers.

Use Source mode when exact byte formatting matters.
