using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Windows.Forms;

namespace DynaWall;

/// <summary>
/// The settings window's palette, typography and drawing helpers.
///
/// One place for the colours the macOS popover paints (<c>#0d1117</c> background,
/// <c>#161b22</c> surface, <c>#30363d</c> border, <c>#e6edf3</c> ink, <c>#8b949e</c>
/// muted) and for the rounded, anti-aliased primitives every custom control shares,
/// so the two hosts cannot drift apart and no painting code has to invent a colour.
/// </summary>
internal static class UiTheme
{
    /// <summary>The window behind the cards (<c>#0d1117</c>).</summary>
    internal static readonly Color Background = Color.FromArgb(13, 17, 23);

    /// <summary>The card surface (<c>#161b22</c>).</summary>
    internal static readonly Color Surface = Color.FromArgb(22, 27, 34);

    /// <summary>Hover wash for buttons and menu rows.</summary>
    internal static readonly Color SurfaceHover = Color.FromArgb(31, 38, 47);

    /// <summary>Input and inset fills (<c>#0d1117</c>).</summary>
    internal static readonly Color Field = Color.FromArgb(13, 17, 23);

    /// <summary>The 1px hairline every card and field draws (<c>#30363d</c>).</summary>
    internal static readonly Color Border = Color.FromArgb(48, 54, 61);

    /// <summary>Primary ink (<c>#e6edf3</c>).</summary>
    internal static readonly Color Ink = Color.FromArgb(230, 237, 243);

    /// <summary>Secondary ink for labels and captions (<c>#8b949e</c>).</summary>
    internal static readonly Color Muted = Color.FromArgb(139, 148, 158);

    /// <summary>The daylight accent the wallpaper glows with (<c>#388bfd</c>).</summary>
    internal static readonly Color Accent = Color.FromArgb(56, 139, 253);

    /// <summary>Switch track when a toggle is off.</summary>
    internal static readonly Color Track = Color.FromArgb(68, 76, 88);

    internal const string Family = "Segoe UI";

    /// <summary>Windows' symbol font; every glyph below comes from it.</summary>
    internal const string IconFamily = "Segoe MDL2 Assets";

    internal const string FolderGlyph = "\uE8B7";
    internal const string ClearGlyph = "\uE711";
    internal const string ChevronGlyph = "\uE70D";

    /// <summary>Text drawn exactly as measured, centred in its box: no wrap, no padding.</summary>
    internal static readonly StringFormat Centered = new(StringFormat.GenericTypographic)
    {
        Alignment = StringAlignment.Center,
        LineAlignment = StringAlignment.Center,
        Trimming = StringTrimming.None,
        FormatFlags = StringFormatFlags.NoWrap | StringFormatFlags.NoClip
    };

    /// <summary>Left-aligned and vertically centred: pills and badges.</summary>
    internal static readonly StringFormat NearCentered = new(StringFormat.GenericTypographic)
    {
        Alignment = StringAlignment.Near,
        LineAlignment = StringAlignment.Center,
        Trimming = StringTrimming.None,
        FormatFlags = StringFormatFlags.NoWrap | StringFormatFlags.NoClip
    };

    /// <summary>
    /// A rounded rectangle path. The caller owns and disposes it: every painting
    /// routine wraps this in <c>using</c>, which is what keeps GDI handles flat while
    /// the window repaints.
    /// </summary>
    internal static GraphicsPath Rounded(RectangleF bounds, float radius)
    {
        var path = new GraphicsPath();
        var diameter = Math.Min(radius * 2f, Math.Min(bounds.Width, bounds.Height));
        if (diameter <= 1f)
        {
            path.AddRectangle(bounds);
            return path;
        }

        path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180f, 90f);
        path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270f, 90f);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0f, 90f);
        path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90f, 90f);
        path.CloseFigure();
        return path;
    }

    /// <summary>A font one step away from <paramref name="baseFont"/> (the caller disposes it).</summary>
    internal static Font Variant(Font baseFont, float scale, FontStyle style = FontStyle.Regular)
    {
        var size = Math.Max(6f, baseFont.Size * scale);
        return new Font(baseFont.FontFamily, size, style, GraphicsUnit.Point);
    }

    /// <summary>
    /// A font in <paramref name="family"/> when this machine can render it, the UI
    /// face otherwise. The bundled faces are registered from
    /// <c>web/assets/fonts</c>, so the preview is set in the same typeface the desktop
    /// is (the caller disposes the result).
    /// </summary>
    internal static Font FamilyFont(string? family, float size, FontStyle style)
    {
        var resolvedFamily = PreviewFonts.Resolve(family);
        var points = Math.Max(6f, size);
        if (resolvedFamily is not null)
        {
            try
            {
                return new Font(resolvedFamily, points, style, GraphicsUnit.Point);
            }
            catch (ArgumentException)
            {
                // The family exists but not in this style; GDI+ cannot synthesise it.
            }
        }

        return new Font(Family, points, style, GraphicsUnit.Point);
    }

    /// <summary>Blend <paramref name="from"/> toward <paramref name="to"/> by an amount in 0…1.</summary>
    internal static Color Mix(Color from, Color to, float amount)
    {
        var t = Math.Clamp(amount, 0f, 1f);
        var alpha = from.A + (int)Math.Round((to.A - from.A) * (double)t);
        var red = from.R + (int)Math.Round((to.R - from.R) * (double)t);
        var green = from.G + (int)Math.Round((to.G - from.G) * (double)t);
        var blue = from.B + (int)Math.Round((to.B - from.B) * (double)t);
        return Color.FromArgb(alpha, red, green, blue);
    }

    /// <summary>A <c>#rrggbb</c> string as a colour, or <paramref name="fallback"/> when unparseable.</summary>
    internal static Color Parse(string? hex, Color fallback)
    {
        var value = (hex ?? string.Empty).Trim();
        if (value.Length == 0) return fallback;

        try
        {
            return ColorTranslator.FromHtml(value.StartsWith('#') ? value : "#" + value);
        }
        catch (Exception)
        {
            return fallback;
        }
    }
}

/// <summary>
/// The typefaces GDI+ can actually paint inside the settings window.
///
/// Windows only knows the families the user installed, while DynaWall ships four
/// faces with the wallpaper. They are registered from <c>web/assets/fonts</c> here so
/// the preview card is set in the family the desktop really uses — the same problem
/// <c>WallpaperFont</c> solves for the macOS popover. The collection and the resolved
/// families live for the lifetime of the process: a font keeps a reference to its
/// family, so neither can be freed while a preview is on screen.
/// </summary>
internal static class PreviewFonts
{
    private static readonly PrivateFontCollection Bundled = new();

    private static readonly Dictionary<string, FontFamily> Families =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Imported files already added to <see cref="Bundled"/>, by full path.</summary>
    private static readonly HashSet<string> registered = new(StringComparer.OrdinalIgnoreCase);

    private static bool scanned;

    /// <summary>The family behind <paramref name="family"/>, or <c>null</c> when unrenderable.</summary>
    internal static FontFamily? Resolve(string? family)
    {
        var name = (family ?? string.Empty).Trim();
        if (name.Length == 0) return null;

        lock (Families)
        {
            if (Families.TryGetValue(name, out var cached)) return cached;

            if (!scanned) Scan();
            if (Families.TryGetValue(name, out cached)) return cached;

            try
            {
                var installed = new FontFamily(name);
                Families[name] = installed;
                return installed;
            }
            catch (ArgumentException)
            {
                // A family this machine does not have: the caller falls back.
                return null;
            }
        }
    }

    /// <summary>
    /// Register a face the user imported ("Add font…") so the miniature is set in the
    /// same family the desktop is using. Imported files live in
    /// <c>%LOCALAPPDATA%\DynaWall\Fonts</c> and stay loaded for the life of the
    /// process, exactly like the bundled ones.
    /// </summary>
    internal static void Register(string? path)
    {
        var file = (path ?? string.Empty).Trim();
        if (file.Length == 0 || !File.Exists(file)) return;

        lock (Families)
        {
            if (!scanned) Scan();
            if (!registered.Add(file)) return;

            try
            {
                Bundled.AddFontFile(file);
                foreach (var family in Bundled.Families)
                {
                    if (string.IsNullOrWhiteSpace(family.Name)) continue;
                    Families.TryAdd(family.Name, family);
                }
            }
            catch (Exception ex)
            {
                Log.Write($"{Path.GetFileName(file)} could not be previewed: {ex.Message}");
            }
        }
    }

    private static void Scan()
    {
        scanned = true;

        var folder = Path.Combine(AppPaths.WebRoot, "assets", "fonts");
        if (!Directory.Exists(folder)) return;

        try
        {
            // GDI+ reads TrueType/OpenType only; the .woff2 copies in the same folder
            // exist for the page, and the static .ttf twins are what these previews use.
            foreach (var file in Directory.EnumerateFiles(folder, "*.ttf"))
            {
                try
                {
                    Bundled.AddFontFile(file);
                }
                catch (Exception ex)
                {
                    Log.Write($"preview font {Path.GetFileName(file)} could not be loaded: {ex.Message}");
                }
            }

            foreach (var family in Bundled.Families)
            {
                if (string.IsNullOrWhiteSpace(family.Name)) continue;
                Families.TryAdd(family.Name, family);
            }
        }
        catch (Exception ex)
        {
            Log.Write($"bundled preview fonts unavailable: {ex.Message}");
        }
    }
}

/// <summary>A flicker-free host for the scrolling settings content.</summary>
internal sealed class BufferedPanel : Panel
{
    internal BufferedPanel()
    {
        SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint, true);
        DoubleBuffered = true;
    }
}

/// <summary>The stacked column every card is built on, painted in one pass.</summary>
internal sealed class BufferedLayout : TableLayoutPanel
{
    internal BufferedLayout()
    {
        SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint, true);
        DoubleBuffered = true;
    }
}

/// <summary>
/// A rounded card: surface fill, one hairline border, and a double-buffered paint so
/// the rounded edges never flicker while the column grows or the window scrolls.
///
/// Children are laid out inside <see cref="Control.Padding"/>, which keeps them clear
/// of the corner arcs — a card is never a rectangle with square corners poking out.
/// </summary>
internal class CardPanel : Panel
{
    private Color fill;
    private Color stroke;

    internal CardPanel() : this(UiTheme.Surface, UiTheme.Border, 12)
    {
    }

    internal CardPanel(Color fill, Color stroke, int radius)
    {
        this.fill = fill;
        this.stroke = stroke;
        Radius = radius;

        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw,
            true);
        DoubleBuffered = true;
        BackColor = UiTheme.Background;
    }

    /// <summary>Surface colour of the card.</summary>
    internal Color Fill
    {
        get => fill;
        set
        {
            fill = value;
            Invalidate();
        }
    }

    /// <summary>Hairline colour around the card.</summary>
    internal Color Stroke
    {
        get => stroke;
        set
        {
            stroke = value;
            Invalidate();
        }
    }

    /// <summary>Corner radius, in pixels at the current scaling.</summary>
    internal int Radius { get; set; }

    protected override void OnPaint(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.Clear(Parent?.BackColor ?? UiTheme.Background);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;

        var bounds = new RectangleF(0.5f, 0.5f, Math.Max(1f, Width - 1f), Math.Max(1f, Height - 1f));
        using var path = UiTheme.Rounded(bounds, Radius);
        using (var brush = new SolidBrush(fill)) graphics.FillPath(brush, path);
        using (var pen = new Pen(stroke)) graphics.DrawPath(pen, path);
    }
}

/// <summary>
/// The muted, letter-spaced uppercase label that opens a card — <c>GREETING</c>,
/// <c>TYPOGRAPHY</c>, <c>PHOTOS</c>.
///
/// Tracking is applied by drawing one character at a time; GDI+ has no letter-spacing
/// switch, and setting the label in uppercase with air between the glyphs is exactly
/// what makes the card read as a section rather than a caption.
/// </summary>
internal sealed class SectionHeader : Control
{
    private string caption;

    internal SectionHeader(string caption)
    {
        this.caption = caption;

        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw |
            ControlStyles.SupportsTransparentBackColor,
            true);
        DoubleBuffered = true;
        BackColor = Color.Transparent;
        TabStop = false;
        ApplyFontMetrics();
    }

    internal string Caption
    {
        get => caption;
        set
        {
            caption = value ?? string.Empty;
            Invalidate();
        }
    }

    protected override void OnFontChanged(EventArgs e)
    {
        base.OnFontChanged(e);
        ApplyFontMetrics();
    }

    protected override void OnParentChanged(EventArgs e)
    {
        base.OnParentChanged(e);
        ApplyFontMetrics();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        using var font = UiTheme.Variant(Font, 0.86f, FontStyle.Bold);
        using var brush = new SolidBrush(UiTheme.Muted);

        var tracking = Math.Max(0.6f, font.Height * 0.1f);
        var x = 0f;
        foreach (var character in caption.ToUpperInvariant())
        {
            var glyph = character.ToString();
            graphics.DrawString(glyph, font, brush, x, 0f, StringFormat.GenericTypographic);
            x += graphics.MeasureString(glyph, font, PointF.Empty, StringFormat.GenericTypographic).Width + tracking;
        }
    }

    private void ApplyFontMetrics()
    {
        var height = Font.Height + 5;
        if (Height != height) Height = height;
    }
}

/// <summary>A one-pixel rule used to separate progressive content inside a card.</summary>
internal sealed class Divider : Control
{
    internal Divider()
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw |
            ControlStyles.SupportsTransparentBackColor,
            true);
        DoubleBuffered = true;
        BackColor = Color.Transparent;
        Height = 1;
        TabStop = false;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        using var brush = new SolidBrush(UiTheme.Border);
        e.Graphics.FillRectangle(brush, 0, 0, Math.Max(1, Width), Math.Max(1, Height));
    }
}

/// <summary>How a <see cref="FlatButton"/> is painted.</summary>
internal enum ButtonKind
{
    /// <summary>Field fill with a hairline: the default secondary action.</summary>
    Normal,

    /// <summary>Accent fill, white ink: the one affirmative action in the window.</summary>
    Accent,

    /// <summary>No fill until hovered: actions that should not compete for attention.</summary>
    Ghost
}

/// <summary>
/// A rounded, flat button. <see cref="Button"/> is subclassed rather than replaced so
/// every dialog, keyboard and accessibility behaviour of the real control is kept;
/// only the painting is ours, and every brush it creates is disposed.
/// </summary>
internal sealed class FlatButton : Button
{
    private bool hovered;
    private bool pressed;

    internal FlatButton()
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw,
            true);
        DoubleBuffered = true;
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        UseVisualStyleBackColor = false;
        BackColor = UiTheme.Surface;
        ForeColor = UiTheme.Ink;
        AutoSize = false;
        Height = 30;
        Cursor = Cursors.Hand;
        TabStop = true;
    }

    /// <summary>Which of the three paints to use.</summary>
    internal ButtonKind Kind { get; set; }

    /// <summary>Corner radius, in pixels at the current scaling.</summary>
    internal int Radius { get; set; } = 8;

    /// <summary>A Segoe MDL2 Assets glyph drawn instead of <see cref="Control.Text"/>.</summary>
    internal string Glyph { get; set; } = string.Empty;

    /// <summary>Size the button to its caption (call after setting <see cref="Control.Text"/>).</summary>
    internal void FitToText(int horizontalPadding = 26)
    {
        var measured = TextRenderer.MeasureText(
            Text,
            Font,
            new Size(2000, 200),
            TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
        Width = Math.Max(24, measured.Width + horizontalPadding);
        Height = Math.Max(Height, measured.Height + 12);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.Clear(BackColor);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        var bounds = new RectangleF(0.5f, 0.5f, Math.Max(1f, Width - 1f), Math.Max(1f, Height - 1f));
        using var path = UiTheme.Rounded(bounds, Radius);

        var fill = Kind switch
        {
            ButtonKind.Accent => hovered && Enabled ? UiTheme.Mix(UiTheme.Accent, Color.White, 0.12f) : UiTheme.Accent,
            ButtonKind.Ghost => hovered || pressed ? UiTheme.SurfaceHover : BackColor,
            _ => hovered || pressed ? UiTheme.SurfaceHover : UiTheme.Field
        };

        using (var brush = new SolidBrush(fill)) graphics.FillPath(brush, path);

        if (Kind == ButtonKind.Normal)
        {
            using var pen = new Pen(
                hovered && Enabled ? UiTheme.Mix(UiTheme.Border, UiTheme.Ink, 0.2f) : UiTheme.Border);
            graphics.DrawPath(pen, path);
        }

        var ink = !Enabled
            ? UiTheme.Muted
            : Kind == ButtonKind.Accent ? Color.White : UiTheme.Ink;

        if (Glyph.Length > 0)
        {
            using var icon = new Font(
                UiTheme.IconFamily, Math.Max(6f, Font.Size * 0.9f), FontStyle.Regular, GraphicsUnit.Point);
            TextRenderer.DrawText(
                graphics,
                Glyph,
                icon,
                ClientRectangle,
                ink,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }
        else
        {
            TextRenderer.DrawText(
                graphics,
                Text,
                Font,
                ClientRectangle,
                ink,
                TextFormatFlags.HorizontalCenter |
                TextFormatFlags.VerticalCenter |
                TextFormatFlags.NoPrefix |
                TextFormatFlags.EndEllipsis);
        }

        if (Focused && ShowFocusCues)
        {
            ControlPaint.DrawFocusRectangle(
                graphics,
                new Rectangle(3, 3, Math.Max(1, Width - 7), Math.Max(1, Height - 7)),
                UiTheme.Ink,
                fill);
        }
    }

    protected override void OnMouseEnter(EventArgs e)
    {
        base.OnMouseEnter(e);
        hovered = true;
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        hovered = false;
        pressed = false;
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        pressed = true;
        Invalidate();
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (!pressed) return;
        pressed = false;
        Invalidate();
    }

    protected override void OnEnabledChanged(EventArgs e)
    {
        base.OnEnabledChanged(e);
        Cursor = Enabled ? Cursors.Hand : Cursors.Default;
        Invalidate();
    }

    protected override void OnGotFocus(EventArgs e)
    {
        base.OnGotFocus(e);
        Invalidate();
    }

    protected override void OnLostFocus(EventArgs e)
    {
        base.OnLostFocus(e);
        Invalidate();
    }
}

/// <summary>
/// A switch, not a checkbox: a rounded track with a sliding knob, the control the
/// macOS popover uses for the same switches. <see cref="CheckBox"/> is subclassed so
/// <c>Checked</c>, <c>CheckedChanged</c> and the Space key keep working untouched.
/// </summary>
internal sealed class ToggleSwitch : CheckBox
{
    private bool hovered;

    internal ToggleSwitch()
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw |
            ControlStyles.SupportsTransparentBackColor,
            true);
        DoubleBuffered = true;
        BackColor = Color.Transparent;
        ForeColor = UiTheme.Ink;
        AutoSize = false;
        Height = 24;
        Cursor = Cursors.Hand;
        TextAlign = ContentAlignment.MiddleLeft;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        // Every metric comes from the font, so the switch keeps its proportions when
        // Windows scales the window for a high-DPI display.
        var trackHeight = Math.Max(14, Font.Height);
        var trackWidth = trackHeight * 2;
        var top = (Height - trackHeight) / 2f;
        var track = new RectangleF(0.5f, top + 0.5f, trackWidth, trackHeight);

        var on = Checked && Enabled;
        var trackColor = on
            ? UiTheme.Accent
            : hovered && Enabled ? UiTheme.Mix(UiTheme.Track, UiTheme.Ink, 0.16f) : UiTheme.Track;

        using (var path = UiTheme.Rounded(track, trackHeight / 2f))
        using (var brush = new SolidBrush(trackColor))
        {
            graphics.FillPath(brush, path);
        }

        var knobSize = trackHeight - 4;
        var knobX = Checked ? track.Right - knobSize - 2 : track.Left + 2;
        using (var knob = new SolidBrush(Checked ? Color.White : Color.FromArgb(205, 214, 224)))
        {
            graphics.FillEllipse(knob, knobX, track.Top + 2, knobSize, knobSize);
        }

        var textLeft = (int)Math.Round(trackWidth + trackHeight * 0.55f);
        var textBounds = new Rectangle(textLeft, 0, Math.Max(0, Width - textLeft), Height);
        TextRenderer.DrawText(
            graphics,
            Text,
            Font,
            textBounds,
            Enabled ? UiTheme.Ink : UiTheme.Muted,
            TextFormatFlags.Left |
            TextFormatFlags.VerticalCenter |
            TextFormatFlags.NoPrefix |
            TextFormatFlags.EndEllipsis);

        if (Focused && ShowFocusCues)
        {
            ControlPaint.DrawFocusRectangle(
                graphics,
                new Rectangle(Math.Max(0, textLeft - 2), 2, Math.Max(1, Width - textLeft), Math.Max(1, Height - 5)),
                UiTheme.Ink,
                UiTheme.Surface);
        }
    }

    protected override void OnCheckedChanged(EventArgs e)
    {
        base.OnCheckedChanged(e);
        Invalidate();
    }

    protected override void OnEnabledChanged(EventArgs e)
    {
        base.OnEnabledChanged(e);
        Cursor = Enabled ? Cursors.Hand : Cursors.Default;
        Invalidate();
    }

    protected override void OnMouseEnter(EventArgs e)
    {
        base.OnMouseEnter(e);
        hovered = true;
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        hovered = false;
        Invalidate();
    }

    protected override void OnGotFocus(EventArgs e)
    {
        base.OnGotFocus(e);
        Invalidate();
    }

    protected override void OnLostFocus(EventArgs e)
    {
        base.OnLostFocus(e);
        Invalidate();
    }
}

/// <summary>
/// A rounded text field with an optional inline clear button.
///
/// The <see cref="TextBox"/> is a real one — same input, selection, IME and
/// accessibility behaviour — but it draws without its own border inside a panel that
/// paints the rounded surface. That is what removes the hard Windows box edge and lets
/// the field glow with the accent while it holds focus.
/// </summary>
internal sealed class InputField : Panel
{
    private readonly FlatButton? clearButton;
    private readonly Font boxFont;
    private bool focused;

    internal InputField(TextBox box, bool clearable = false)
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw,
            true);
        DoubleBuffered = true;
        BackColor = UiTheme.Surface;
        Height = 34;
        Padding = new Padding(11, 0, 11, 0);

        Box = box;
        Box.BorderStyle = BorderStyle.None;
        Box.BackColor = UiTheme.Field;
        Box.ForeColor = UiTheme.Ink;
        boxFont = new Font(UiTheme.Family, 9.5f);
        Box.Font = boxFont;
        Box.GotFocus += (_, _) =>
        {
            focused = true;
            SyncClearButton();
            Invalidate();
        };
        Box.LostFocus += (_, _) =>
        {
            focused = false;
            SyncClearButton();
            Invalidate();
        };
        Box.TextChanged += (_, _) => SyncClearButton();
        Controls.Add(Box);

        if (!clearable) return;

        clearButton = new FlatButton
        {
            Kind = ButtonKind.Ghost,
            Glyph = UiTheme.ClearGlyph,
            BackColor = UiTheme.Field,
            Radius = 6,
            Width = 22,
            Height = 22,
            TabStop = false,
            Visible = false
        };
        clearButton.Click += (_, _) => ClearRequested?.Invoke(this, EventArgs.Empty);
        Controls.Add(clearButton);
    }

    /// <summary>The real text box, for text and change events.</summary>
    internal TextBox Box { get; }

    /// <summary>Raised when the inline clear button is pressed.</summary>
    internal event EventHandler? ClearRequested;

    /// <summary>Greyed-out hint shown while the field is empty.</summary>
    internal string Placeholder
    {
        get => Box.PlaceholderText;
        set => Box.PlaceholderText = value;
    }

    /// <summary>Show the clear button while there is something to clear.</summary>
    internal void SyncClearButton()
    {
        if (clearButton is null) return;

        var visible = Box.TextLength > 0;
        if (clearButton.Visible == visible) return;

        clearButton.Visible = visible;
        PerformLayout();
        Invalidate();
    }

    protected override void OnLayout(LayoutEventArgs e)
    {
        base.OnLayout(e);

        var left = Padding.Left;
        var right = Padding.Right;
        var clearWidth = clearButton is { Visible: true } ? clearButton.Width + 4 : 0;
        var boxHeight = Box.PreferredHeight;
        Box.SetBounds(
            left,
            Math.Max(1, (Height - boxHeight) / 2),
            Math.Max(20, Width - left - right - clearWidth),
            boxHeight);

        if (clearButton is { Visible: true })
        {
            clearButton.SetBounds(
                Width - right - clearButton.Width,
                (Height - clearButton.Height) / 2,
                clearButton.Width,
                clearButton.Height);
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.Clear(BackColor);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;

        var bounds = new RectangleF(0.5f, 0.5f, Math.Max(1f, Width - 1f), Math.Max(1f, Height - 1f));
        using var path = UiTheme.Rounded(bounds, 8f);
        using (var brush = new SolidBrush(UiTheme.Field)) graphics.FillPath(brush, path);
        using (var pen = new Pen(focused ? UiTheme.Accent : UiTheme.Border)) graphics.DrawPath(pen, path);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            // The box itself is disposed by the control collection; the font it was
            // given is ours, so it is released with the field.
            boxFont.Dispose();
        }

        base.Dispose(disposing);
    }
}

/// <summary>
/// The background picker: a rounded field showing the palette in use as a colour
/// swatch beside its hex code. Hand-picked colours are what the wallpaper paints
/// behind the greeting, so the actual colour is the button's own preview.
/// </summary>
internal sealed class ColorSwatchButton : Button
{
    private Color value = UiTheme.Background;
    private string valueText = string.Empty;
    private bool hovered;

    internal ColorSwatchButton()
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw,
            true);
        DoubleBuffered = true;
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        UseVisualStyleBackColor = false;
        BackColor = UiTheme.Surface;
        ForeColor = UiTheme.Ink;
        AutoSize = false;
        Height = 34;
        Cursor = Cursors.Hand;
    }

    /// <summary>The colour the swatch shows.</summary>
    internal Color Value
    {
        get => value;
        set
        {
            this.value = value;
            Invalidate();
        }
    }

    /// <summary>The canonical <c>#rrggbb</c> spelling shown beside the swatch.</summary>
    internal string ValueText
    {
        get => valueText;
        set
        {
            valueText = value ?? string.Empty;
            Invalidate();
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.Clear(BackColor);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        var bounds = new RectangleF(0.5f, 0.5f, Math.Max(1f, Width - 1f), Math.Max(1f, Height - 1f));
        using var path = UiTheme.Rounded(bounds, 8f);
        using (var brush = new SolidBrush(hovered && Enabled ? UiTheme.SurfaceHover : UiTheme.Field))
        {
            graphics.FillPath(brush, path);
        }

        using (var pen = new Pen(hovered && Enabled ? UiTheme.Mix(UiTheme.Border, UiTheme.Ink, 0.2f) : UiTheme.Border))
        {
            graphics.DrawPath(pen, path);
        }

        var swatchSize = Math.Max(10f, Math.Min(Height - 14f, 18f));
        var swatch = new RectangleF(10f, (Height - swatchSize) / 2f, swatchSize, swatchSize);
        using (var brush = new SolidBrush(value)) graphics.FillEllipse(brush, swatch);
        using (var pen = new Pen(Color.FromArgb(64, 255, 255, 255))) graphics.DrawEllipse(pen, swatch);

        var textLeft = (int)Math.Round(swatch.Right + 9f);
        TextRenderer.DrawText(
            graphics,
            valueText,
            Font,
            new Rectangle(textLeft, 0, Math.Max(0, Width - textLeft - 8), Height),
            Enabled ? UiTheme.Ink : UiTheme.Muted,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);

        const string hint = "Choose…";
        var hintWidth = TextRenderer.MeasureText(hint, Font, new Size(2000, 200), TextFormatFlags.NoPrefix).Width + 4;
        TextRenderer.DrawText(
            graphics,
            hint,
            Font,
            new Rectangle(Math.Max(textLeft, Width - hintWidth - 12), 0, hintWidth, Height),
            UiTheme.Muted,
            TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
    }

    protected override void OnMouseEnter(EventArgs e)
    {
        base.OnMouseEnter(e);
        hovered = true;
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        hovered = false;
        Invalidate();
    }
}

/// <summary>
/// The segmented interval control: one rounded trough split into pills, the Windows
/// answer to the macOS <c>Picker(.segmented)</c>. It replaces the numeric spinner, so
/// the interval is chosen by clicking a pill instead of nudging a number.
/// </summary>
internal sealed class SegmentedControl : Control
{
    private readonly List<int> values = new();
    private int selectedIndex = -1;
    private int hoverIndex = -1;

    internal SegmentedControl()
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw,
            true);
        DoubleBuffered = true;
        BackColor = UiTheme.Surface;
        Height = 30;
        Cursor = Cursors.Hand;
        TabStop = true;
    }

    /// <summary>Raised only when the user picks a different pill.</summary>
    internal event EventHandler? SelectedValueChanged;

    /// <summary>The selected value, or 0 while the control is empty.</summary>
    internal int SelectedValue =>
        selectedIndex >= 0 && selectedIndex < values.Count ? values[selectedIndex] : 0;

    /// <summary>How each value is labelled (<c>15</c> → <c>15m</c>).</summary>
    internal Func<int, string> Formatter { get; set; } = DefaultFormat;

    /// <summary>Fill the trough. A stored value outside the presets is kept as a pill.</summary>
    internal void SetValues(IEnumerable<int> minutes, int selected)
    {
        values.Clear();
        values.AddRange(minutes);

        var index = values.IndexOf(selected);
        selectedIndex = index >= 0 ? index : values.Count > 0 ? 0 : -1;
        hoverIndex = -1;
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.Clear(BackColor);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        var outer = new RectangleF(0.5f, 0.5f, Math.Max(1f, Width - 1f), Math.Max(1f, Height - 1f));
        using (var path = UiTheme.Rounded(outer, 9f))
        {
            using (var brush = new SolidBrush(UiTheme.Field)) graphics.FillPath(brush, path);
            using (var pen = new Pen(UiTheme.Border)) graphics.DrawPath(pen, path);
        }

        if (values.Count == 0) return;

        using var font = UiTheme.Variant(Font, 0.92f, FontStyle.Bold);
        var inner = new RectangleF(
            outer.X + 3f, outer.Y + 3f, Math.Max(1f, outer.Width - 6f), Math.Max(1f, outer.Height - 6f));
        var gap = 3f;
        var segmentWidth = Math.Max(1f, (inner.Width - (gap * (values.Count - 1))) / values.Count);

        for (var index = 0; index < values.Count; index += 1)
        {
            var segment = new RectangleF(
                inner.X + (index * (segmentWidth + gap)),
                inner.Y,
                segmentWidth,
                inner.Height);

            if (index == selectedIndex)
            {
                using var path = UiTheme.Rounded(segment, 7f);
                using var brush = new SolidBrush(
                    Enabled ? UiTheme.Accent : UiTheme.Mix(UiTheme.Accent, UiTheme.Field, 0.55f));
                graphics.FillPath(brush, path);
            }
            else if (index == hoverIndex && Enabled)
            {
                using var path = UiTheme.Rounded(segment, 7f);
                using var brush = new SolidBrush(UiTheme.SurfaceHover);
                graphics.FillPath(brush, path);
            }

            var ink = index == selectedIndex
                ? Color.White
                : Enabled ? UiTheme.Muted : UiTheme.Mix(UiTheme.Muted, UiTheme.Surface, 0.5f);

            TextRenderer.DrawText(
                graphics,
                Formatter(values[index]),
                font,
                Rectangle.Round(segment),
                ink,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var index = IndexAt(e.Location);
        if (index == hoverIndex) return;
        hoverIndex = index;
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (hoverIndex < 0) return;
        hoverIndex = -1;
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        Focus();
        Select(IndexAt(e.Location));
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        switch (e.KeyCode)
        {
            case Keys.Left:
                Select(selectedIndex - 1);
                e.Handled = true;
                break;
            case Keys.Right:
                Select(selectedIndex + 1);
                e.Handled = true;
                break;
            case Keys.Home:
                Select(0);
                e.Handled = true;
                break;
            case Keys.End:
                Select(values.Count - 1);
                e.Handled = true;
                break;
        }

        base.OnKeyDown(e);
    }

    protected override bool IsInputKey(Keys keyData)
    {
        var key = keyData & Keys.KeyCode;
        return key is Keys.Left or Keys.Right or Keys.Home or Keys.End || base.IsInputKey(keyData);
    }

    protected override void OnEnabledChanged(EventArgs e)
    {
        base.OnEnabledChanged(e);
        Cursor = Enabled ? Cursors.Hand : Cursors.Default;
        Invalidate();
    }

    private static string DefaultFormat(int minutes) => minutes switch
    {
        60 => "1h",
        _ => minutes < 60
            ? $"{minutes}m"
            : minutes % 60 == 0 ? $"{minutes / 60}h" : $"{minutes / 60}h {minutes % 60}m"
    };

    private void Select(int index)
    {
        if (!Enabled || index < 0 || index >= values.Count || index == selectedIndex) return;
        selectedIndex = index;
        Invalidate();
        SelectedValueChanged?.Invoke(this, EventArgs.Empty);
    }

    private int IndexAt(Point location)
    {
        if (values.Count == 0) return -1;

        var inner = new RectangleF(3f, 3f, Math.Max(1f, Width - 6f), Math.Max(1f, Height - 6f));
        var gap = 3f;
        var segmentWidth = Math.Max(1f, (inner.Width - (gap * (values.Count - 1))) / values.Count);

        for (var index = 0; index < values.Count; index += 1)
        {
            var start = inner.X + (index * (segmentWidth + gap));
            if (location.X >= start - (gap / 2f) && location.X <= start + segmentWidth + (gap / 2f))
            {
                return index;
            }
        }

        return -1;
    }
}

/// <summary>
/// A dropdown that looks like a field: the current choice, a chevron, and a dark themed
/// menu of every option.
///
/// <see cref="ComboBox"/> is deliberately not used: it paints a system border and a
/// system-coloured list that cannot join a dark, rounded card. The menu itself is a
/// real <see cref="ContextMenuStrip"/>, so keyboard navigation, scrolling and
/// dismissal all behave the way Windows users expect.
/// </summary>
internal sealed class SelectField : Control
{
    private readonly List<string> items = new();
    private readonly ContextMenuStrip menu;
    private int selectedIndex = -1;
    private bool hovered;
    private bool open;

    internal SelectField()
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw,
            true);
        DoubleBuffered = true;
        BackColor = UiTheme.Surface;
        Height = 34;
        Cursor = Cursors.Hand;
        TabStop = true;
        AccessibleRole = AccessibleRole.ComboBox;

        menu = new ContextMenuStrip
        {
            Renderer = DarkMenuRenderer.Instance,
            BackColor = UiTheme.Surface,
            ForeColor = UiTheme.Ink,
            ShowImageMargin = false,
            ShowCheckMargin = true,
            DropShadowEnabled = false,
            Padding = new Padding(2, 4, 2, 4),
            MaximumSize = new Size(520, 440)
        };
        menu.Closed += (_, _) =>
        {
            open = false;
            Invalidate();
        };
    }

    /// <summary>Raised when the user picks a different item.</summary>
    internal event EventHandler? SelectionChanged;

    /// <summary>Every option, in display order.</summary>
    internal IReadOnlyList<string> Items => items;

    /// <summary>The selected index, or -1 while the field is empty.</summary>
    internal int SelectedIndex
    {
        get => selectedIndex;
        set
        {
            var index = value >= 0 && value < items.Count ? value : -1;
            if (index == selectedIndex) return;
            selectedIndex = index;
            Invalidate();
        }
    }

    /// <summary>The selected option, or an empty string.</summary>
    internal string SelectedItem =>
        selectedIndex >= 0 && selectedIndex < items.Count ? items[selectedIndex] : string.Empty;

    /// <summary>Replace the options, keeping the current choice when it still exists.</summary>
    internal void SetItems(IEnumerable<string> values)
    {
        var current = SelectedItem;
        items.Clear();
        items.AddRange(values);
        selectedIndex = items.FindIndex(item => string.Equals(item, current, StringComparison.OrdinalIgnoreCase));
        Invalidate();
    }

    /// <summary>Select <paramref name="value"/> without raising <see cref="SelectionChanged"/>.</summary>
    internal void SelectItem(string value)
    {
        SelectedIndex = items.FindIndex(item => string.Equals(item, value, StringComparison.OrdinalIgnoreCase));
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.Clear(BackColor);
        graphics.SmoothingMode = SmoothingMode.AntiAlias;
        graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        var bounds = new RectangleF(0.5f, 0.5f, Math.Max(1f, Width - 1f), Math.Max(1f, Height - 1f));
        var active = (hovered || open) && Enabled;

        using (var path = UiTheme.Rounded(bounds, 8f))
        {
            using (var brush = new SolidBrush(active ? UiTheme.SurfaceHover : UiTheme.Field))
            {
                graphics.FillPath(brush, path);
            }

            using (var pen = new Pen(active ? UiTheme.Mix(UiTheme.Border, UiTheme.Ink, 0.22f) : UiTheme.Border))
            {
                graphics.DrawPath(pen, path);
            }
        }

        var chevronWidth = Font.Height + 10;
        TextRenderer.DrawText(
            graphics,
            SelectedItem,
            Font,
            new Rectangle(11, 0, Math.Max(0, Width - chevronWidth - 11), Height),
            Enabled ? UiTheme.Ink : UiTheme.Muted,
            TextFormatFlags.Left |
            TextFormatFlags.VerticalCenter |
            TextFormatFlags.NoPrefix |
            TextFormatFlags.EndEllipsis);

        using var icon = new Font(
            UiTheme.IconFamily, Math.Max(6f, Font.Size * 0.75f), FontStyle.Regular, GraphicsUnit.Point);
        TextRenderer.DrawText(
            graphics,
            UiTheme.ChevronGlyph,
            icon,
            new Rectangle(Width - chevronWidth, 0, chevronWidth, Height),
            UiTheme.Muted,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        Focus();
        ShowOptions();
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        switch (e.KeyCode)
        {
            case Keys.Space:
            case Keys.Enter:
                ShowOptions();
                e.Handled = true;
                break;
            case Keys.Down:
                if (menu.Visible) break;
                ShowOptions();
                e.Handled = true;
                break;
            case Keys.Up:
                Step(-1);
                e.Handled = true;
                break;
        }

        base.OnKeyDown(e);
    }

    protected override bool IsInputKey(Keys keyData)
    {
        var key = keyData & Keys.KeyCode;
        return key is Keys.Up or Keys.Down or Keys.Space or Keys.Enter || base.IsInputKey(keyData);
    }

    protected override void OnMouseEnter(EventArgs e)
    {
        base.OnMouseEnter(e);
        hovered = true;
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        hovered = false;
        Invalidate();
    }

    protected override void OnEnabledChanged(EventArgs e)
    {
        base.OnEnabledChanged(e);
        Cursor = Enabled ? Cursors.Hand : Cursors.Default;
        Invalidate();
    }

    protected override void OnGotFocus(EventArgs e)
    {
        base.OnGotFocus(e);
        Invalidate();
    }

    protected override void OnLostFocus(EventArgs e)
    {
        base.OnLostFocus(e);
        Invalidate();
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) menu.Dispose();
        base.Dispose(disposing);
    }

    private void Step(int delta)
    {
        if (items.Count == 0) return;

        var index = Math.Clamp(selectedIndex + delta, 0, items.Count - 1);
        if (index == selectedIndex) return;

        selectedIndex = index;
        Invalidate();
        SelectionChanged?.Invoke(this, EventArgs.Empty);
    }

    private void ShowOptions()
    {
        if (!Enabled || items.Count == 0) return;

        if (menu.Visible)
        {
            menu.Close();
            return;
        }

        // The menu is built per opening: the font list is long and the selection
        // moves, so stale rows are released here rather than kept alive off-screen.
        while (menu.Items.Count > 0)
        {
            var stale = menu.Items[0];
            menu.Items.RemoveAt(0);
            stale.Dispose();
        }

        for (var index = 0; index < items.Count; index += 1)
        {
            var choice = index;
            var item = new ToolStripMenuItem(items[index])
            {
                Checked = index == selectedIndex,
                ForeColor = UiTheme.Ink,
                BackColor = UiTheme.Surface,
                Font = Font
            };
            item.Click += (_, _) =>
            {
                if (choice == selectedIndex) return;
                selectedIndex = choice;
                Invalidate();
                SelectionChanged?.Invoke(this, EventArgs.Empty);
            };
            menu.Items.Add(item);
        }

        open = true;
        Invalidate();
        menu.Show(this, new Point(0, Height + 1));
    }
}

/// <summary>
/// The painter behind <see cref="SelectField"/>'s menu: surface fill, hairline border,
/// muted hover row and an accent check, so a Windows dropdown reads like the rest of
/// the panel instead of like a system control.
/// </summary>
internal sealed class DarkMenuRenderer : ToolStripProfessionalRenderer
{
    internal static readonly DarkMenuRenderer Instance = new();

    private DarkMenuRenderer() : base(new DarkMenuColorTable())
    {
        RoundedEdges = false;
    }

    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
    {
        using var brush = new SolidBrush(UiTheme.Surface);
        e.Graphics.FillRectangle(brush, e.AffectedBounds);
    }

    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
    {
        using var pen = new Pen(UiTheme.Border);
        var bounds = new Rectangle(
            0, 0, Math.Max(1, e.ToolStrip.Width - 1), Math.Max(1, e.ToolStrip.Height - 1));
        e.Graphics.DrawRectangle(pen, bounds);
    }

    protected override void OnRenderImageMargin(ToolStripRenderEventArgs e)
    {
        using var brush = new SolidBrush(UiTheme.Surface);
        e.Graphics.FillRectangle(brush, e.AffectedBounds);
    }

    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        var bounds = new Rectangle(Point.Empty, e.Item.Size);
        using var brush = new SolidBrush(
            e.Item.Selected && e.Item.Enabled ? UiTheme.SurfaceHover : UiTheme.Surface);
        e.Graphics.FillRectangle(brush, bounds);
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        e.TextColor = e.Item.Enabled ? UiTheme.Ink : UiTheme.Muted;
        base.OnRenderItemText(e);
    }

    protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
    {
        var graphics = e.Graphics;
        graphics.SmoothingMode = SmoothingMode.AntiAlias;

        var box = e.ImageRectangle;
        var centreX = box.X + (box.Width / 2f);
        var centreY = box.Y + (box.Height / 2f);
        using var pen = new Pen(UiTheme.Accent, Math.Max(1.6f, box.Height * 0.16f))
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
            LineJoin = LineJoin.Round
        };
        graphics.DrawLines(
            pen,
            new[]
            {
                new PointF(centreX - (box.Width * 0.28f), centreY),
                new PointF(centreX - (box.Width * 0.08f), centreY + (box.Height * 0.22f)),
                new PointF(centreX + (box.Width * 0.30f), centreY - (box.Height * 0.28f))
            });
    }

    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
    {
        using var pen = new Pen(UiTheme.Border);
        var y = e.Item.Height / 2;
        e.Graphics.DrawLine(pen, 6, y, Math.Max(6, e.Item.Width - 6), y);
    }
}

/// <summary>The colours the dark renderer falls back on for the parts it does not paint.</summary>
internal sealed class DarkMenuColorTable : ProfessionalColorTable
{
    public override Color ToolStripDropDownBackground => UiTheme.Surface;

    public override Color ImageMarginGradientBegin => UiTheme.Surface;

    public override Color ImageMarginGradientMiddle => UiTheme.Surface;

    public override Color ImageMarginGradientEnd => UiTheme.Surface;

    public override Color MenuItemSelected => UiTheme.SurfaceHover;

    public override Color MenuItemBorder => UiTheme.SurfaceHover;

    public override Color MenuBorder => UiTheme.Border;

    public override Color CheckBackground => UiTheme.Surface;

    public override Color CheckSelectedBackground => UiTheme.Surface;
}
