//! wasm exports over Ghostty's sprite face, built by build-libghostty-wasm.sh
//! from the pinned Ghostty src/ tree. Renders one codepoint into an uncropped,
//! padded alpha8 buffer matching Ghostty's golden-test layout:
//! (w + 2*(w/4)) x (h + 2*(h/4)), with the cell at offset (w/4, h/4).
const std = @import("std");
const font = @import("font/main.zig");
const Face = font.sprite.Face;
const options = @import("t3_sprite_options");

// Freestanding has no stderr or threads: drop logs, trap on panic.
pub const std_options: std.Options = .{ .logFn = noLog };
pub const panic = std.debug.no_panic;
fn noLog(comptime _: std.log.Level, comptime _: @TypeOf(.x), comptime _: []const u8, _: anytype) void {}

const alloc = std.heap.wasm_allocator;
var out: []u8 = &.{};

/// The pinned Ghostty revision this module was built from, NUL-terminated.
export fn t3_sprite_revision() [*:0]const u8 {
    return options.ghostty_revision;
}

export fn t3_sprite_has(cp: u32) bool {
    const face: Face = .{ .metrics = undefined };
    return face.hasCodepoint(cp, null);
}

/// Returns a pointer to the padded alpha buffer, valid until the next call,
/// or 0 when `cp` is not a sprite or rendering failed. Codepoint sprites read
/// only cell width, cell height, and box thickness, so no baseline is needed.
export fn t3_sprite_render(cp: u32, cell_w: u32, cell_h: u32, thickness: u32, span: u32) usize {
    return render(cp, cell_w, cell_h, thickness, span) catch 0;
}

fn render(cp: u32, cell_w: u32, cell_h: u32, thickness: u32, span: u32) !usize {
    if (!t3_sprite_has(cp) or cell_w == 0 or cell_h == 0) return 0;
    const metrics: font.Metrics = .calc(.{
        .px_per_em = 16,
        .cell_width = @floatFromInt(cell_w),
        .ascent = @floatFromInt(cell_h),
        .descent = 0,
        .line_gap = 0.0,
        .underline_thickness = @floatFromInt(thickness),
        .strikethrough_thickness = @floatFromInt(thickness),
    });
    const w = metrics.cell_width * @max(span, 1);
    const h = metrics.cell_height;
    const pad_x = w / 4;
    const pad_y = h / 4;
    const out_w = w + 2 * pad_x;
    const out_h = h + 2 * pad_y;

    var atlas = try font.Atlas.init(alloc, @max(out_w, out_h) + 4, .grayscale);
    defer atlas.deinit(alloc);
    const face: Face = .{ .metrics = metrics };
    const glyph = try face.renderGlyph(alloc, &atlas, cp, .{
        .grid_metrics = metrics,
        .cell_width = @intCast(@max(span, 1)),
    });

    const len = out_w * out_h;
    if (out.len != len) {
        alloc.free(out);
        out = try alloc.alloc(u8, len);
    }
    @memset(out, 0);
    // Undo renderGlyph's crop: offset_x = clip_left - pad_x and
    // offset_y = height + clip_bottom - pad_y, so clip_top = h + pad_y - offset_y.
    const left: u32 = @intCast(glyph.offset_x + @as(i32, @intCast(pad_x)));
    const top: u32 = @intCast(@as(i32, @intCast(h + pad_y)) - glyph.offset_y);
    for (0..glyph.height) |y| {
        const src = atlas.data[(glyph.atlas_y + y) * atlas.size + glyph.atlas_x ..][0..glyph.width];
        @memcpy(out[(top + y) * out_w + left ..][0..glyph.width], src);
    }
    return @intFromPtr(out.ptr);
}
