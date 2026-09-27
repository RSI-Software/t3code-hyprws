//! Replaces Ghostty's src/font/main.zig in the sprite build. The real root
//! force-references the web_canvas font backend on wasm, which lib-vt never
//! builds; the sprite face needs only these declarations.
pub const Atlas = @import("Atlas.zig");
pub const Glyph = @import("Glyph.zig");
pub const Metrics = @import("Metrics.zig");
pub const sprite = @import("sprite.zig");
pub const Presentation = enum(u1) { text = 0, emoji = 1 };
