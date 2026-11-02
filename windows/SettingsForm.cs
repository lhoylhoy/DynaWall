using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DynaWall;

/// <summary>
/// The settings window: the Windows twin of the macOS popover.
///
/// A live miniature of the desktop sits at the top, then cards for the greeting, the
/// typeface, the palette, the photo source and the per-user startup entry. Every
/// surface is painted with GDI+ on double-buffered controls, so the window keeps the
/// panel's dark, rounded language instead of the system's light control chrome, and
/// the photo options only appear while the slideshow is running. Changes reach the
/// wallpaper immediately and are saved to
/// <c>%LOCALAPPDATA%\DynaWall\settings.json</c>, debounced so typing never hammers
/// the disk or the page.
/// </summary>
internal sealed class SettingsForm : Form
{
    /// <summary>The six palette modes, in the order <c>script.js</c> accepts them.</summary>
    private static readonly string[] ThemeLabels =
    {
        "Auto (time of day)",
        "Dawn (05–09)",
        "Day (09–17)",
        "Dusk (17–21)",
        "Night (21–05)",
        "Custom color"
    };

    /// <summary>
    /// The shipped faces lead the picker: exactly the four families in
    /// <c>web/assets/fonts</c>, so a choice never points at a font the user has to
    /// install first. Every other family comes from the installed list or an import.
    /// </summary>
    private static readonly string[] FontPresets = Preferences.BundledFontFamilies;

    /// <summary>The intervals the macOS popover offers as segmented pills, in minutes.</summary>
    private static readonly int[] IntervalPresets = { 1, 5, 15, 30, 60 };

    // DWM attributes: the Windows 11 title bar and frame colours.
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaUseImmersiveDarkModeLegacy = 19;
    private const int DwmwaWindowCornerPreference = 33;
    private const int DwmwaBorderColor = 34;
    private const int DwmwaCaptionColor = 35;
    private const int DwmwaTextColor = 36;
    private const int DwmcpRound = 2;

    private readonly WallpaperController controller;
    private readonly PreviewCardControl preview = new();
    private readonly TextBox firstNameBox = new();
    private readonly TextBox subtitleBox = new();
    private readonly InputField firstNameField;
    private readonly InputField subtitleField;
    private readonly SelectField themeField = new();
    private readonly SelectField fontField = new();
    private readonly ColorSwatchButton colorButton = new();
    private readonly FlatButton addFontButton = new();
    private readonly FlatButton revealButton = new();
    private readonly FlatButton browseButton = new();
    private readonly FlatButton bundledButton = new();
    private readonly FlatButton nextButton = new();
    private readonly FlatButton resetButton = new();
    private readonly FlatButton closeButton = new();
    private readonly Label folderNameLabel = new();
    private readonly Label folderCaptionLabel = new();
    private readonly ToggleSwitch slideshowBox = new();
    private readonly ToggleSwitch shuffleBox = new();
    private readonly ToggleSwitch kenBurnsBox = new();
    private readonly ToggleSwitch photoSyncBox = new();
    private readonly ToggleSwitch startupBox = new();
    private readonly SegmentedControl intervalChips = new();
    private readonly BufferedLayout slideshowOptions = new();
    private readonly List<Font> ownedFonts = new();
    private readonly ToolTip tips = new();
    private readonly System.Windows.Forms.Timer debounce = new() { Interval = 250 };
    private bool loading;

    internal SettingsForm(WallpaperController controller)
    {
        this.controller = controller;
        firstNameField = new InputField(firstNameBox);
        subtitleField = new InputField(subtitleBox, clearable: true);

        Text = "DynaWall Settings";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96F, 96F);
        ClientSize = new Size(560, 768);
        BackColor = UiTheme.Background;
        ForeColor = UiTheme.Ink;
        Font = OwnedFont(9F, FontStyle.Regular);
        DoubleBuffered = true;

        TryApplyIcon();
        BuildInterface();
        LoadFromPreferences();

        firstNameBox.TextChanged += OnTextChanged;
        subtitleBox.TextChanged += OnTextChanged;
        subtitleField.ClearRequested += OnSubtitleCleared;
        themeField.SelectionChanged += OnThemeChanged;
        fontField.SelectionChanged += OnFontChanged;
        slideshowBox.CheckedChanged += OnOptionChanged;
        shuffleBox.CheckedChanged += OnOptionChanged;
        kenBurnsBox.CheckedChanged += OnOptionChanged;
        photoSyncBox.CheckedChanged += OnOptionChanged;
        intervalChips.SelectedValueChanged += OnOptionChanged;
        startupBox.CheckedChanged += OnStartupChanged;
        preview.PauseRequested += OnPauseRequested;

        debounce.Tick += (_, _) =>
        {
            debounce.Stop();
            Commit();
        };

        FormClosing += (_, _) =>
        {
            debounce.Stop();
            Commit();
        };
    }

    private Preferences Preferences => controller.Preferences;

    [DllImport("dwmapi.dll", PreserveSig = true)]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    private void TryApplyIcon()
    {
        try
        {
            var path = Environment.ProcessPath;
            if (string.IsNullOrEmpty(path)) return;

            var icon = Icon.ExtractAssociatedIcon(path);
            if (icon is not null) Icon = icon;
        }
        catch (Exception)
        {
            // The default form icon is fine.
        }
    }

    /// <summary>
    /// Windows 11 chrome: a dark title bar, rounded corners and a caption that matches
    /// the card surface. Every attribute is best-effort — an older build ignores the
    /// call and simply keeps its own frame.
    /// </summary>
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);

        try
        {
            var dark = 1;
            if (DwmSetWindowAttribute(Handle, DwmwaUseImmersiveDarkMode, ref dark, sizeof(int)) != 0)
            {
                DwmSetWindowAttribute(Handle, DwmwaUseImmersiveDarkModeLegacy, ref dark, sizeof(int));
            }

            var rounded = DwmcpRound;
            DwmSetWindowAttribute(Handle, DwmwaWindowCornerPreference, ref rounded, sizeof(int));

            var caption = ColorRef(UiTheme.Surface);
            DwmSetWindowAttribute(Handle, DwmwaCaptionColor, ref caption, sizeof(int));
            var ink = ColorRef(UiTheme.Ink);
            DwmSetWindowAttribute(Handle, DwmwaTextColor, ref ink, sizeof(int));
            var border = ColorRef(UiTheme.Border);
            DwmSetWindowAttribute(Handle, DwmwaBorderColor, ref border, sizeof(int));
        }
        catch (Exception ex)
        {
            Log.Write($"window chrome unavailable: {ex.Message}");
        }
    }

    /// <summary>Win32 <c>COLORREF</c> (0x00BBGGRR) for the DWM colour attributes.</summary>
    private static int ColorRef(Color color) => color.R | (color.G << 8) | (color.B << 16);

    protected override bool ProcessCmdKey(ref Message message, Keys keyData)
    {
        if (keyData == Keys.Escape)
        {
            Close();
            return true;
        }

        return base.ProcessCmdKey(ref message, keyData);
    }

    /// <summary>
    /// The band, the clock, the pause state and the startup entry can all change while
    /// the window sits in the background — the tray menu owns two of them — so the
    /// panel re-reads them whenever it comes forward.
    /// </summary>
    protected override void OnActivated(EventArgs e)
    {
        base.OnActivated(e);

        loading = true;
        startupBox.Checked = StartupRegistration.IsEnabled;
        loading = false;

        UpdateFolderRow();
        RefreshPreview();
    }

    protected override void Dispose(bool disposing)
    {
        // The children go first: a layout pass during their removal may still measure
        // text, and the fonts they inherited are released right after.
        base.Dispose(disposing);
        if (!disposing) return;

        foreach (var font in ownedFonts) font.Dispose();
        ownedFonts.Clear();
        tips.Dispose();
        debounce.Dispose();
    }

    /// <summary>
    /// One scrolling column: the miniature, one rounded card per topic, then the
    /// footer. The column is a table, so a card can grow (the photo options appear and
    /// disappear with the slideshow) without any hand-written layout pass.
    /// </summary>
    private void BuildInterface()
    {
        var scroll = new BufferedPanel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            BackColor = UiTheme.Background,
            Padding = new Padding(16, 14, 16, 16)
        };

        var root = new BufferedLayout
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            BackColor = UiTheme.Background
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        scroll.Controls.Add(root);
        Controls.Add(scroll);

        preview.Dock = DockStyle.Top;
        preview.Height = 132;
        preview.Margin = new Padding(0, 0, 0, 12);
        tips.SetToolTip(preview, "Click Pause to detach the wallpaper from the desktop");
        AddRow(root, preview);

        firstNameField.Placeholder = Preferences.DefaultFirstName;
        subtitleField.Placeholder = Preferences.DefaultSubtitle;
        tips.SetToolTip(subtitleField, "Empty hides the subtitle");

        themeField.SetItems(ThemeLabels);
        themeField.AccessibleName = "Palette";
        tips.SetToolTip(themeField, "The palette the wallpaper paints");

        colorButton.AccessibleName = "Background colour";
        colorButton.Click += (_, _) => PickColor();
        tips.SetToolTip(colorButton, "Pick a colour; the palette switches to Custom");

        addFontButton.Text = "Add font…";
        addFontButton.FitToText();
        addFontButton.Click += (_, _) => AddFontFile();
        tips.SetToolTip(addFontButton, "Use a .ttf, .otf, .ttc, .woff or .woff2 file from this PC");

        revealButton.Text = "Reveal";
        revealButton.Kind = ButtonKind.Ghost;
        revealButton.BackColor = UiTheme.Field;
        revealButton.FitToText(20);
        revealButton.Click += (_, _) => RevealPhotoFolder();
        tips.SetToolTip(revealButton, "Open the folder the wallpaper is rotating through");

        browseButton.Text = "Change…";
        browseButton.Kind = ButtonKind.Normal;
        browseButton.BackColor = UiTheme.Field;
        browseButton.FitToText();
        browseButton.Click += (_, _) => ChooseFolder();

        bundledButton.Text = "Bundled";
        bundledButton.Kind = ButtonKind.Ghost;
        bundledButton.BackColor = UiTheme.Field;
        bundledButton.FitToText(20);
        bundledButton.Click += (_, _) => UseBundledPhotos();
        tips.SetToolTip(bundledButton, "Go back to the wallpapers that ship with DynaWall");

        nextButton.Text = "Next";
        nextButton.Kind = ButtonKind.Ghost;
        nextButton.Height = 26;
        nextButton.FitToText(18);
        nextButton.Click += (_, _) => controller.NextPhoto();
        tips.SetToolTip(nextButton, "Show the next photo now");

        resetButton.Text = "Reset";
        resetButton.Kind = ButtonKind.Ghost;
        resetButton.BackColor = UiTheme.Background;
        resetButton.Height = 32;
        resetButton.FitToText(20);
        resetButton.Click += (_, _) => ResetSettings();
        tips.SetToolTip(resetButton, "Restore the default name, palette and slideshow");

        closeButton.Text = "Close";
        closeButton.Kind = ButtonKind.Accent;
        closeButton.Height = 32;
        closeButton.FitToText(30);

        StyleToggle(slideshowBox, "Photo slideshow");
        StyleToggle(photoSyncBox, "Match photos to time of day");
        StyleToggle(shuffleBox, "Shuffle the order");
        StyleToggle(kenBurnsBox, "Slow zoom (Ken Burns)");
        StyleToggle(startupBox, "Start DynaWall when I sign in");

        BuildSlideshowOptions();

        AddCard(root, "Greeting",
            FieldRow("First name", firstNameField),
            FieldRow("Subtitle", subtitleField));

        AddCard(root, "Typography", FieldRow("Font", BuildFontRow()));

        AddCard(root, "Appearance",
            FieldRow("Palette", themeField),
            FieldRow("Background", colorButton));

        AddCard(root, "Photos",
            BuildFolderRow(),
            BuildSlideshowSwitchRow(),
            slideshowOptions);

        AddCard(root, "Startup", startupBox);

        AddRow(root, BuildFooter());
    }

    /// <summary>
    /// The options that only matter while the slideshow runs, kept out of the card
    /// until it does — the same progressive disclosure the macOS popover uses.
    /// </summary>
    private void BuildSlideshowOptions()
    {
        slideshowOptions.Dock = DockStyle.Top;
        slideshowOptions.AutoSize = true;
        slideshowOptions.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        slideshowOptions.ColumnCount = 1;
        slideshowOptions.RowCount = 5;
        slideshowOptions.BackColor = UiTheme.Surface;
        slideshowOptions.Margin = new Padding(0);
        slideshowOptions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        for (var row = 0; row < slideshowOptions.RowCount; row += 1)
        {
            slideshowOptions.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }

        slideshowOptions.Controls.Add(new Divider
        {
            Dock = DockStyle.Top,
            BackColor = UiTheme.Surface,
            Margin = new Padding(0, 2, 0, 10)
        }, 0, 0);
        slideshowOptions.Controls.Add(photoSyncBox, 0, 1);
        slideshowOptions.Controls.Add(FieldRow("Rotate every", intervalChips), 0, 2);
        slideshowOptions.Controls.Add(shuffleBox, 0, 3);
        slideshowOptions.Controls.Add(kenBurnsBox, 0, 4);

        intervalChips.Formatter = IntervalLabel;
        intervalChips.Height = 30;
        intervalChips.AccessibleName = "Slideshow interval";
    }

    /// <summary>Add a rounded card with a letter-spaced section header and its rows.</summary>
    private static void AddCard(BufferedLayout root, string title, params Control[] children)
    {
        var card = new CardPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = UiTheme.Background,
            Padding = new Padding(14, 12, 14, 14),
            Margin = new Padding(0, 0, 0, 10)
        };

        var column = new BufferedLayout
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = children.Length + (title.Length > 0 ? 1 : 0),
            BackColor = UiTheme.Surface
        };
        column.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        for (var row = 0; row < column.RowCount; row += 1)
        {
            column.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }

        var index = 0;
        if (title.Length > 0)
        {
            column.Controls.Add(new SectionHeader(title)
            {
                Dock = DockStyle.Top,
                BackColor = UiTheme.Surface,
                Margin = new Padding(0, 0, 0, 10)
            }, 0, index);
            index += 1;
        }

        foreach (var child in children)
        {
            child.Dock = DockStyle.Top;
            column.Controls.Add(child, 0, index);
            index += 1;
        }

        card.Controls.Add(column);
        AddRow(root, card);
    }

    /// <summary>Append a control as one auto-sized row of the scrolling column.</summary>
    private static void AddRow(BufferedLayout root, Control child)
    {
        root.RowCount += 1;
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.Controls.Add(child, 0, root.RowCount - 1);
    }

    /// <summary>A "Label — control" row, the shape of every field in the panel.</summary>
    private static BufferedLayout FieldRow(string labelText, Control input)
    {
        var row = new BufferedLayout
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 2,
            RowCount = 1,
            BackColor = UiTheme.Surface,
            Margin = new Padding(0, 0, 0, 8)
        };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var label = new Label
        {
            Text = labelText,
            AutoSize = true,
            ForeColor = UiTheme.Muted,
            BackColor = UiTheme.Surface,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(0, 9, 10, 0)
        };

        input.Dock = DockStyle.Fill;
        input.Margin = new Padding(0, 2, 0, 2);
        row.Controls.Add(label, 0, 0);
        row.Controls.Add(input, 1, 0);
        return row;
    }

    /// <summary>The font picker with its import button beside it.</summary>
    private BufferedLayout BuildFontRow()
    {
        var row = new BufferedLayout
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 2,
            RowCount = 1,
            BackColor = UiTheme.Surface,
            Margin = new Padding(0, 0, 0, 8)
        };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        row.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        fontField.Dock = DockStyle.Fill;
        fontField.Margin = new Padding(0, 2, 8, 2);
        fontField.AccessibleName = "Font family";
        addFontButton.Dock = DockStyle.Fill;
        addFontButton.Margin = new Padding(0, 2, 0, 2);

        row.Controls.Add(fontField, 0, 0);
        row.Controls.Add(addFontButton, 1, 0);
        return row;
    }

    /// <summary>
    /// The folder the wallpaper rotates through: its name, how many pictures it holds,
    /// and the three actions — reveal it, change it, or go back to the bundled set.
    /// </summary>
    private Control BuildFolderRow()
    {
        var card = new CardPanel(UiTheme.Field, UiTheme.Border, 10)
        {
            Dock = DockStyle.Top,
            Height = 62,
            Padding = new Padding(12, 8, 10, 8),
            Margin = new Padding(0, 0, 0, 10)
        };

        var layout = new BufferedLayout
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 1,
            BackColor = UiTheme.Field
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));

        var labels = new BufferedLayout
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 2,
            BackColor = UiTheme.Field,
            Margin = new Padding(0)
        };
        labels.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        labels.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        labels.RowStyles.Add(new RowStyle(SizeType.Percent, 50));

        ConfigureFolderLabel(folderNameLabel, 9.5f, FontStyle.Bold, UiTheme.Ink, ContentAlignment.BottomLeft);
        ConfigureFolderLabel(folderCaptionLabel, 8.25f, FontStyle.Regular, UiTheme.Muted, ContentAlignment.TopLeft);
        labels.Controls.Add(folderNameLabel, 0, 0);
        labels.Controls.Add(folderCaptionLabel, 0, 1);

        var actions = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            BackColor = UiTheme.Field,
            Padding = new Padding(0, 6, 0, 0),
            Margin = new Padding(0)
        };
        revealButton.Margin = new Padding(4, 0, 4, 0);
        browseButton.Margin = new Padding(0, 0, 4, 0);
        bundledButton.Margin = new Padding(0);
        actions.Controls.Add(revealButton);
        actions.Controls.Add(browseButton);
        actions.Controls.Add(bundledButton);

        layout.Controls.Add(labels, 0, 0);
        layout.Controls.Add(actions, 1, 0);
        card.Controls.Add(layout);
        return card;
    }

    /// <summary>The master switch, with "Next" beside it while the slideshow runs.</summary>
    private Control BuildSlideshowSwitchRow()
    {
        var row = new BufferedLayout
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 2,
            RowCount = 1,
            BackColor = UiTheme.Surface,
            Margin = new Padding(0, 0, 0, 8)
        };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        row.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        slideshowBox.Dock = DockStyle.Fill;
        slideshowBox.Margin = new Padding(0, 3, 8, 3);
        nextButton.Dock = DockStyle.Fill;
        nextButton.Margin = new Padding(0, 3, 0, 3);

        row.Controls.Add(slideshowBox, 0, 0);
        row.Controls.Add(nextButton, 1, 0);
        return row;
    }

    /// <summary>Reset on the left, the one accent action on the right.</summary>
    private Control BuildFooter()
    {
        var footer = new BufferedLayout
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 3,
            RowCount = 1,
            BackColor = UiTheme.Background,
            Margin = new Padding(2, 2, 2, 0)
        };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        footer.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        resetButton.Margin = new Padding(0);
        closeButton.Margin = new Padding(0);
        footer.Controls.Add(resetButton, 0, 0);
        footer.Controls.Add(closeButton, 2, 0);
        return footer;
    }

    private static void StyleToggle(ToggleSwitch box, string text)
    {
        box.Text = text;
        box.Dock = DockStyle.Top;
        box.AutoSize = false;
        box.Height = 26;
        box.BackColor = UiTheme.Surface;
        box.ForeColor = UiTheme.Ink;
        box.Margin = new Padding(0, 0, 0, 8);
    }

    private void ConfigureFolderLabel(Label label, float size, FontStyle style, Color ink, ContentAlignment align)
    {
        label.AutoSize = false;
        label.AutoEllipsis = true;
        label.BackColor = UiTheme.Field;
        label.ForeColor = ink;
        label.TextAlign = align;
        label.Margin = new Padding(0);
        label.Dock = DockStyle.Fill;
        label.Font = OwnedFont(size, style);
    }

    /// <summary>
    /// A font the window created itself. It is tracked so closing the panel releases
    /// it: a <see cref="Label"/> never disposes the font it is given.
    /// </summary>
    private Font OwnedFont(float size, FontStyle style)
    {
        var font = new Font(UiTheme.Family, size, style);
        ownedFonts.Add(font);
        return font;
    }

    private void LoadFromPreferences()
    {
        loading = true;

        firstNameBox.Text = Preferences.FirstName;
        subtitleBox.Text = Preferences.Subtitle;
        themeField.SelectedIndex = Math.Max(0, Array.IndexOf(Preferences.ThemeModes, Preferences.Theme));
        UpdateColorButton();
        LoadFontChoices();
        slideshowBox.Checked = Preferences.Slideshow;
        shuffleBox.Checked = Preferences.SlideshowShuffle;
        kenBurnsBox.Checked = Preferences.KenBurns;
        photoSyncBox.Checked = Preferences.PhotoSync;
        intervalChips.SetValues(IntervalChoices(), Preferences.SlideshowInterval);
        startupBox.Checked = StartupRegistration.IsEnabled;

        loading = false;
        UpdateFolderRow();
        UpdateDisclosure();
        RefreshPreview();
    }

    /// <summary>
    /// The folder row: the name of the source and how many pictures it holds. The
    /// count comes from the controller's library, so it is the number the page is
    /// actually rotating through rather than what the folder looked like at launch.
    /// </summary>
    private void UpdateFolderRow()
    {
        var photos = controller.Photos;

        folderNameLabel.Text = photos.HasFolder
            ? Path.GetFileName(photos.FolderPath.TrimEnd(Path.DirectorySeparatorChar))
            : "DynaWall wallpapers";

        folderCaptionLabel.Text = !photos.HasFolder
            ? "Bundled set · no folder needed"
            : photos.FolderExists ? PhotoCountCaption(photos.Count) : "Folder not found";

        bundledButton.Enabled = photos.HasFolder;
        tips.SetToolTip(revealButton, $@"Reveal {folderNameLabel.Text} in Explorer");
    }

    private static string PhotoCountCaption(int count) => count switch
    {
        0 => "No supported images",
        1 => "1 photo · rotating",
        _ => $"{count} photos · rotating"
    };

    private void UpdateColorButton()
    {
        var color = UiTheme.Parse(Preferences.BgColor, UiTheme.Background);
        colorButton.Value = color;
        colorButton.ValueText = Preferences.BgColor;
    }

    /// <summary>
    /// Progressive disclosure: the photo options are only in the card while the
    /// slideshow is on, and "Next" is only worth showing then either.
    /// </summary>
    private void UpdateDisclosure()
    {
        var slideshow = slideshowBox.Checked;
        if (slideshowOptions.Visible != slideshow) slideshowOptions.Visible = slideshow;
        if (nextButton.Visible != slideshow) nextButton.Visible = slideshow;

        var canRotate = slideshow && (!controller.Photos.HasFolder || controller.Photos.Count > 0);
        intervalChips.Enabled = canRotate;
        shuffleBox.Enabled = canRotate;
        kenBurnsBox.Enabled = canRotate;
        photoSyncBox.Enabled = canRotate;
        nextButton.Enabled = canRotate;

        slideshowOptions.Parent?.PerformLayout();
    }

    /// <summary>
    /// Rebuild the miniature from the preferences the wallpaper is using: the band's
    /// palette, the greeting the page renders, the photo caption and the pause state.
    /// </summary>
    private void RefreshPreview()
    {
        var band = PaletteFor(Preferences.Theme, UiTheme.Parse(Preferences.BgColor, UiTheme.Background));
        var paused = controller.IsPaused;

        preview.Apply(
            GreetingText(),
            Preferences.Subtitle.Trim(),
            paused ? "Paused" : band.Label,
            PreviewCaption(paused),
            Preferences.FontFamily,
            band.Background,
            band.Accent,
            band.PrimaryInk,
            band.SecondaryInk,
            paused);
    }

    /// <summary>The caption pinned to the bottom of the miniature.</summary>
    private string PreviewCaption(bool paused)
    {
        if (paused) return "Wallpaper paused — click Resume to reattach";
        if (!Preferences.Slideshow) return "Photos off · palette only";

        var photos = controller.Photos;
        var source = photos.HasFolder ? PhotoCountCaption(photos.Count) : "Bundled wallpapers";
        return $"{source} · {IntervalLabel(Preferences.SlideshowInterval)}";
    }

    /// <summary>
    /// The greeting exactly as the page renders it — <c>Good morning, Froilan.</c> —
    /// with the periods <c>getGreetingPeriod()</c> resolves and the name normalised
    /// the way <c>normalizeName()</c> cleans it.
    /// </summary>
    private string GreetingText()
    {
        var hours = DateTime.Now.Hour;
        var period = hours is >= 5 and < 12
            ? "morning"
            : hours is >= 12 and < 18 ? "afternoon" : "evening";

        return $"Good {period}, {Preferences.NormalizeName(Preferences.FirstName)}.";
    }

    /// <summary>`1m · 5m · 15m · 30m · 1h` for the compact interval picker.</summary>
    private static string IntervalLabel(int minutes) => minutes switch
    {
        60 => "1h",
        _ => minutes < 60
            ? $"{minutes}m"
            : minutes % 60 == 0 ? $"{minutes / 60}h" : $"{minutes / 60}h {minutes % 60}m"
    };

    /// <summary>Whole minutes, plus whatever is stored, in case a build wrote its own.</summary>
    private int[] IntervalChoices()
    {
        var values = new List<int>(IntervalPresets);
        var current = Math.Clamp(
            Preferences.SlideshowInterval, Preferences.MinIntervalMinutes, Preferences.MaxIntervalMinutes);
        if (!values.Contains(current)) values.Add(current);

        values.Sort();
        return values.ToArray();
    }

    /// <summary>
    /// The palette a band paints with, mirroring the <c>[data-theme]</c> blocks in
    /// <c>style.css</c>: the background, the radial glow, and the two ink tones.
    /// </summary>
    private readonly record struct BandPalette(
        string Label, Color Background, Color Accent, Color PrimaryInk, Color SecondaryInk);

    /// <summary>The band in force now — resolved from the clock for the auto palette.</summary>
    private static BandPalette PaletteFor(string theme, Color custom)
    {
        var mode = (theme ?? string.Empty).Trim().ToLowerInvariant();
        if (mode == "auto") mode = BandAt(DateTime.Now.Hour);

        switch (mode)
        {
            case "dawn":
                return new BandPalette(
                    "Dawn",
                    UiTheme.Parse("#121020", UiTheme.Background),
                    UiTheme.Parse("#ff94aa", UiTheme.Accent),
                    UiTheme.Parse("#f8f3fb", UiTheme.Ink),
                    UiTheme.Parse("#a89fb9", UiTheme.Muted));
            case "dusk":
                return new BandPalette(
                    "Dusk",
                    UiTheme.Parse("#180f0e", UiTheme.Background),
                    UiTheme.Parse("#ff9250", UiTheme.Accent),
                    UiTheme.Parse("#fdf1e8", UiTheme.Ink),
                    UiTheme.Parse("#b19b8f", UiTheme.Muted));
            case "night":
                return new BandPalette(
                    "Night",
                    UiTheme.Parse("#070a11", UiTheme.Background),
                    UiTheme.Parse("#486eff", UiTheme.Accent),
                    UiTheme.Parse("#e7eefb", UiTheme.Ink),
                    UiTheme.Parse("#7f8a9c", UiTheme.Muted));
            case "custom":
                // A pinned colour glows with a lightened version of itself, which is
                // what the wallpaper's radial accent does behind the greeting.
                return new BandPalette(
                    "Custom",
                    custom,
                    UiTheme.Mix(custom, Color.White, 0.32f),
                    UiTheme.Parse("#f0f6fc", UiTheme.Ink),
                    UiTheme.Parse("#8b949e", UiTheme.Muted));
            default:
                return new BandPalette(
                    "Day",
                    UiTheme.Parse("#0d1117", UiTheme.Background),
                    UiTheme.Parse("#388bfd", UiTheme.Accent),
                    UiTheme.Parse("#f0f6fc", UiTheme.Ink),
                    UiTheme.Parse("#8b949e", UiTheme.Muted));
        }
    }

    /// <summary>05:00–08:59 dawn · 09:00–16:59 day · 17:00–20:59 dusk · 21:00–04:59 night.</summary>
    private static string BandAt(int hours) => hours switch
    {
        >= 5 and < 9 => "dawn",
        >= 9 and < 17 => "day",
        >= 17 and < 21 => "dusk",
        _ => "night"
    };

    private void OnTextChanged(object? sender, EventArgs e)
    {
        if (loading) return;

        Preferences.FirstName = Preferences.NormalizeName(firstNameBox.Text);
        Preferences.Subtitle = subtitleBox.Text;

        RefreshPreview();
        debounce.Stop();
        debounce.Start();
    }

    /// <summary>The inline clear button: an empty subtitle hides the second line.</summary>
    private void OnSubtitleCleared(object? sender, EventArgs e)
    {
        subtitleBox.Text = string.Empty;
        subtitleBox.Focus();
    }

    private void OnThemeChanged(object? sender, EventArgs e)
    {
        if (loading) return;

        var index = Math.Clamp(themeField.SelectedIndex, 0, Preferences.ThemeModes.Length - 1);
        Preferences.Theme = Preferences.ThemeModes[index];

        UpdateColorButton();
        RefreshPreview();
        Commit();
    }

    private void OnFontChanged(object? sender, EventArgs e)
    {
        if (loading) return;

        var family = Preferences.NormalizeFontFamily(fontField.SelectedItem);
        Preferences.FontFamily = family;

        // An imported file only backs the family it resolved to: keeping it while
        // another family is picked would load those bytes over the new face.
        if (Preferences.CustomFontPath.Length > 0)
        {
            var imported = FontLibrary.FamilyName(
                Preferences.CustomFontPath, Path.GetFileName(Preferences.CustomFontPath));
            if (!string.Equals(imported, family, StringComparison.OrdinalIgnoreCase))
            {
                Preferences.CustomFontPath = string.Empty;
            }
        }

        RefreshPreview();
        Commit();
    }

    private void OnOptionChanged(object? sender, EventArgs e)
    {
        if (loading) return;

        Preferences.Slideshow = slideshowBox.Checked;
        Preferences.SlideshowShuffle = shuffleBox.Checked;
        Preferences.KenBurns = kenBurnsBox.Checked;
        Preferences.PhotoSync = photoSyncBox.Checked;

        var minutes = intervalChips.SelectedValue;
        if (minutes > 0)
        {
            Preferences.SlideshowInterval = Math.Clamp(
                minutes, Preferences.MinIntervalMinutes, Preferences.MaxIntervalMinutes);
        }

        UpdateDisclosure();
        RefreshPreview();
        Commit();
    }

    private void OnStartupChanged(object? sender, EventArgs e)
    {
        if (loading) return;

        if (StartupRegistration.SetEnabled(startupBox.Checked)) return;

        MessageBox.Show(
            this,
            "DynaWall could not update the per-user startup entry.",
            "DynaWall",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning);

        loading = true;
        startupBox.Checked = StartupRegistration.IsEnabled;
        loading = false;
    }

    /// <summary>The pause pill in the miniature: detach or reattach the wallpaper.</summary>
    private void OnPauseRequested(object? sender, EventArgs e)
    {
        controller.SetPaused(!controller.IsPaused);
        RefreshPreview();
    }

    /// <summary>
    /// Fill the font list: the quick picks, every installed family, and whatever the
    /// current family is — an imported face, or a family set by hand, must still be
    /// selectable. Callers hold <see cref="loading"/> so the stored family landing in
    /// the field does not look like a user change.
    /// </summary>
    private void LoadFontChoices()
    {
        var families = new List<string>(FontPresets);
        families.AddRange(FontLibrary.InstalledFamilies());

        var imported = string.Empty;
        if (Preferences.CustomFontPath.Length > 0)
        {
            // The miniature is set in the imported face too, so the panel and the
            // desktop cannot disagree about what the typeface looks like.
            PreviewFonts.Register(Preferences.CustomFontPath);
            imported = FontLibrary.FamilyName(
                Preferences.CustomFontPath, Path.GetFileName(Preferences.CustomFontPath));
        }

        foreach (var name in new[] { imported, Preferences.FontFamily })
        {
            if (name.Length == 0) continue;
            if (families.Any(family => string.Equals(family, name, StringComparison.OrdinalIgnoreCase))) continue;
            families.Add(name);
        }

        fontField.SetItems(families);
        fontField.SelectItem(Preferences.FontFamily);
    }

    /// <summary>
    /// Pick a downloaded font file, copy it into DynaWall's own folder and apply it.
    /// The copy is what keeps the wallpaper's typeface alive after the download is
    /// cleaned out of the Downloads folder.
    /// </summary>
    private void AddFontFile()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Add a font to DynaWall",
            Filter = "Font files (*.ttf;*.otf;*.ttc;*.woff;*.woff2)|*.ttf;*.otf;*.ttc;*.woff;*.woff2" +
                     "|All files (*.*)|*.*",
            CheckFileExists = true,
            Multiselect = false
        };

        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        var imported = FontLibrary.Import(dialog.FileName);
        if (imported is null)
        {
            MessageBox.Show(
                this,
                $"{Path.GetFileName(dialog.FileName)} cannot be used as a wallpaper font.\n\n" +
                "Pick a .ttf, .otf, .ttc, .woff or .woff2 file no larger than 4 MB.",
                "DynaWall",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        Preferences.CustomFontPath = imported;
        Preferences.FontFamily = FontLibrary.FamilyName(imported, Path.GetFileName(imported));

        loading = true;
        LoadFontChoices();
        loading = false;

        RefreshPreview();
        Commit();
        Log.Write($"font {Path.GetFileName(imported)} imported as \"{Preferences.FontFamily}\"");
    }

    private void PickColor()
    {
        using var dialog = new ColorDialog
        {
            FullOpen = true,
            AnyColor = true,
            Color = UiTheme.Parse(Preferences.BgColor, UiTheme.Background)
        };

        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        Preferences.BgColor = $"#{dialog.Color.R:X2}{dialog.Color.G:X2}{dialog.Color.B:X2}".ToLowerInvariant();
        // A hand-picked colour pins the custom palette, exactly like script.js.
        Preferences.Theme = "custom";

        loading = true;
        themeField.SelectedIndex = Math.Max(0, Array.IndexOf(Preferences.ThemeModes, "custom"));
        loading = false;

        UpdateColorButton();
        RefreshPreview();
        Commit();
    }

    private void ChooseFolder()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose a folder of photos for DynaWall",
            UseDescriptionForTitle = true,
            SelectedPath = Preferences.PhotoFolder
        };

        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        Preferences.PhotoFolder = dialog.SelectedPath;
        Commit(reloadPhotos: true);
    }

    private void UseBundledPhotos()
    {
        if (Preferences.PhotoFolder.Length == 0) return;

        Preferences.PhotoFolder = string.Empty;
        Commit(reloadPhotos: true);
    }

    /// <summary>
    /// Hand the folder to Explorer. The folder row is the only place in the panel that
    /// knows where the pictures live, so "Reveal" belongs right beside the name.
    /// </summary>
    private void RevealPhotoFolder()
    {
        var photos = controller.Photos;
        var target = photos.FolderExists
            ? photos.FolderPath
            : Path.Combine(AppPaths.WebRoot, "images");

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"\"{target}\"",
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            Log.Write($"the photo folder could not be revealed: {ex.Message}");
        }
    }

    private void ResetSettings()
    {
        Preferences.ResetToDefaults();
        LoadFromPreferences();
        Commit();
        controller.ReloadPhotos();
    }

    private void Commit(bool reloadPhotos = false)
    {
        if (loading) return;

        Preferences.Normalize();
        Preferences.Save();
        controller.ApplyPreferences();

        if (!reloadPhotos) return;

        controller.ReloadPhotos();
        UpdateFolderRow();
        UpdateDisclosure();
        RefreshPreview();
    }

    /// <summary>
    /// The live miniature of the desktop: the band's background, its radial glow and
    /// the vignette, the greeting and subtitle in the chosen face, a band badge, the
    /// pause pill and a caption naming what the wallpaper is showing.
    ///
    /// Every measurement comes from the current font, so the card reads the same at
    /// 100% and at 200% scaling, and the pill is the only hit target in the card.
    /// </summary>
    private sealed class PreviewCardControl : Control
    {
        private const float Radius = 14f;
        private const float Inset = 12f;

        private string greeting = string.Empty;
        private string subtitle = string.Empty;
        private string badge = string.Empty;
        private string caption = string.Empty;
        private string family = Preferences.DefaultFontFamily;
        private Color fill = UiTheme.Background;
        private Color glow = UiTheme.Accent;
        private Color primaryInk = UiTheme.Ink;
        private Color secondaryInk = UiTheme.Muted;
        private bool paused;
        private bool pillHovered;
        private RectangleF pillBounds;

        internal PreviewCardControl()
        {
            SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.UserPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw,
                true);
            DoubleBuffered = true;
            BackColor = UiTheme.Background;
            Height = 132;
            TabStop = false;
            Cursor = Cursors.Default;
            AccessibleName = "Desktop preview";
            AccessibleRole = AccessibleRole.Graphic;
        }

        /// <summary>Raised when the pause pill is clicked.</summary>
        internal event EventHandler? PauseRequested;

        /// <summary>Point the miniature at the state the wallpaper is painting.</summary>
        internal void Apply(
            string greeting,
            string subtitle,
            string badge,
            string caption,
            string family,
            Color fill,
            Color glow,
            Color primaryInk,
            Color secondaryInk,
            bool paused)
        {
            this.greeting = greeting ?? string.Empty;
            this.subtitle = subtitle ?? string.Empty;
            this.badge = badge ?? string.Empty;
            this.caption = caption ?? string.Empty;
            this.family = family ?? Preferences.DefaultFontFamily;
            this.fill = fill;
            this.glow = glow;
            this.primaryInk = primaryInk;
            this.secondaryInk = secondaryInk;
            this.paused = paused;

            AccessibleDescription = this.caption;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var graphics = e.Graphics;
            graphics.Clear(Parent?.BackColor ?? UiTheme.Background);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            var bounds = new RectangleF(0.5f, 0.5f, Math.Max(1f, Width - 1f), Math.Max(1f, Height - 1f));
            using var card = UiTheme.Rounded(bounds, Radius);

            var state = graphics.Save();
            graphics.SetClip(card);
            using (var brush = new SolidBrush(fill)) graphics.FillPath(brush, card);
            PaintGlow(graphics);
            PaintVignette(graphics);
            graphics.Restore(state);

            // The same faint hairline the macOS card draws around its miniature.
            using (var pen = new Pen(Color.FromArgb(22, 255, 255, 255))) graphics.DrawPath(pen, card);

            PaintBadge(graphics);
            PaintPausePill(graphics);
            PaintGreeting(graphics);
            PaintCaption(graphics);
        }

        /// <summary>The wallpaper's own ambient light: one soft, centred radial accent.</summary>
        private void PaintGlow(Graphics graphics)
        {
            var ellipseBounds = new RectangleF(
                (Width * 0.5f) - (Width * 0.45f),
                (Height * 0.34f) - (Height * 0.8f),
                Width * 0.9f,
                Height * 1.6f);

            using var ellipse = new GraphicsPath();
            ellipse.AddEllipse(ellipseBounds);
            using var brush = new PathGradientBrush(ellipse)
            {
                CenterColor = Color.FromArgb(76, glow),
                SurroundColors = new[] { Color.FromArgb(0, glow) }
            };
            graphics.FillPath(brush, ellipse);
        }

        /// <summary>The edge vignette <c>.wallpaper-container::before</c> paints.</summary>
        private void PaintVignette(Graphics graphics)
        {
            var shade = new RectangleF(0f, Height * 0.42f, Width, Math.Max(1f, Height * 0.58f));
            using var brush = new LinearGradientBrush(
                shade,
                Color.FromArgb(0, 0, 0, 0),
                Color.FromArgb(96, 0, 0, 0),
                LinearGradientMode.Vertical);
            graphics.FillRectangle(brush, shade);
        }

        /// <summary><c>Dawn</c>, <c>Day</c>, <c>Dusk</c>, <c>Night</c>, <c>Custom</c> or <c>Paused</c>.</summary>
        private void PaintBadge(Graphics graphics)
        {
            if (badge.Length == 0) return;

            using var font = UiTheme.Variant(Font, 0.82f, FontStyle.Bold);
            var measured = TextRenderer.MeasureText(
                badge, font, new Size(2000, 200), TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
            var rect = new RectangleF(
                Inset, Inset, measured.Width + 22f, Math.Max(18f, measured.Height + 7f));

            using (var path = UiTheme.Rounded(rect, rect.Height / 2f))
            using (var brush = new SolidBrush(Color.FromArgb(46, 255, 255, 255)))
            {
                graphics.FillPath(brush, path);
            }

            using (var brush = new SolidBrush(UiTheme.Mix(glow, Color.White, 0.35f)))
            {
                graphics.FillEllipse(brush, rect.X + 8f, rect.Y + (rect.Height / 2f) - 2.5f, 5f, 5f);
            }

            TextRenderer.DrawText(
                graphics,
                badge,
                font,
                Rectangle.Round(new RectangleF(rect.X + 17f, rect.Y, rect.Width - 20f, rect.Height)),
                Color.FromArgb(235, 255, 255, 255),
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }

        /// <summary>The one hit target in the card: detach or reattach the wallpaper.</summary>
        private void PaintPausePill(Graphics graphics)
        {
            using var font = UiTheme.Variant(Font, 0.82f, FontStyle.Bold);
            var label = paused ? "Resume" : "Pause";
            var measured = TextRenderer.MeasureText(
                label, font, new Size(2000, 200), TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);

            var width = measured.Width + 34f;
            var height = Math.Max(18f, measured.Height + 7f);
            pillBounds = new RectangleF(Width - Inset - width, Inset, width, height);

            using (var path = UiTheme.Rounded(pillBounds, height / 2f))
            using (var brush = new SolidBrush(Color.FromArgb(pillHovered ? 84 : 54, 255, 255, 255)))
            {
                graphics.FillPath(brush, path);
            }

            PaintPauseGlyph(
                graphics, new RectangleF(pillBounds.X + 9f, pillBounds.Y + ((height - 8f) / 2f), 7f, 8f));

            TextRenderer.DrawText(
                graphics,
                label,
                font,
                Rectangle.Round(new RectangleF(
                    pillBounds.X + 20f, pillBounds.Y, pillBounds.Width - 24f, pillBounds.Height)),
                Color.FromArgb(240, 255, 255, 255),
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }

        /// <summary>A pause bar for "Pause", a play triangle for "Resume".</summary>
        private void PaintPauseGlyph(Graphics graphics, RectangleF box)
        {
            using var brush = new SolidBrush(Color.FromArgb(240, 255, 255, 255));

            if (paused)
            {
                graphics.FillPolygon(
                    brush,
                    new[]
                    {
                        new PointF(box.X, box.Y),
                        new PointF(box.Right, box.Y + (box.Height / 2f)),
                        new PointF(box.X, box.Bottom)
                    });
                return;
            }

            var bar = Math.Max(1.6f, box.Width * 0.36f);
            graphics.FillRectangle(brush, box.X, box.Y, bar, box.Height);
            graphics.FillRectangle(brush, box.Right - bar, box.Y, bar, box.Height);
        }

        /// <summary>The greeting the page is painting, in the face the desktop uses.</summary>
        private void PaintGreeting(Graphics graphics)
        {
            var available = Math.Max(1f, Width - (Inset * 2f));
            using var greetingFont = UiTheme.FamilyFont(family, 14f, FontStyle.Bold);
            using var subtitleFont = UiTheme.FamilyFont(family, 8.5f, FontStyle.Regular);

            var showSubtitle = subtitle.Length > 0;
            var block = greetingFont.Height + 3f + (showSubtitle ? subtitleFont.Height + 2f : 0f);
            var top = Math.Max(34f, (Height - block) / 2f);

            using (var brush = new SolidBrush(primaryInk))
            {
                var lineHeight = greetingFont.Height + 3f;
                graphics.DrawString(
                    Fit(graphics, greeting, greetingFont, available),
                    greetingFont,
                    brush,
                    new RectangleF(Inset, top, available, lineHeight),
                    UiTheme.Centered);
                top += lineHeight;
            }

            if (!showSubtitle) return;

            using var subtitleBrush = new SolidBrush(secondaryInk);
            graphics.DrawString(
                Fit(graphics, subtitle, subtitleFont, available),
                subtitleFont,
                subtitleBrush,
                new RectangleF(Inset, top, available, subtitleFont.Height + 2f),
                UiTheme.Centered);
        }

        /// <summary>What the wallpaper is showing, pinned to the bottom of the card.</summary>
        private void PaintCaption(Graphics graphics)
        {
            if (caption.Length == 0) return;

            using var font = UiTheme.Variant(Font, 0.8f, FontStyle.Regular);
            using var brush = new SolidBrush(Color.FromArgb(150, 255, 255, 255));
            var available = Math.Max(1f, Width - (Inset * 2f));
            graphics.DrawString(
                Fit(graphics, caption, font, available),
                font,
                brush,
                new RectangleF(Inset, Height - Inset - font.Height, available, font.Height),
                UiTheme.NearCentered);
        }

        /// <summary>Shorten <paramref name="text"/> until it fits, ending in an ellipsis.</summary>
        private static string Fit(Graphics graphics, string text, Font font, float width)
        {
            if (string.IsNullOrEmpty(text)) return string.Empty;
            if (graphics.MeasureString(text, font, PointF.Empty, UiTheme.Centered).Width <= width) return text;

            var length = text.Length;
            while (length > 1)
            {
                length -= 1;
                var candidate = string.Concat(text.AsSpan(0, length), "…");
                if (graphics.MeasureString(candidate, font, PointF.Empty, UiTheme.Centered).Width <= width)
                {
                    return candidate;
                }
            }

            return "…";
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);

            var hover = pillBounds.Contains(e.Location);
            if (hover == pillHovered) return;

            pillHovered = hover;
            Cursor = hover ? Cursors.Hand : Cursors.Default;
            Invalidate();
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (!pillHovered) return;

            pillHovered = false;
            Cursor = Cursors.Default;
            Invalidate();
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left || !pillBounds.Contains(e.Location)) return;

            PauseRequested?.Invoke(this, EventArgs.Empty);
        }
    }
}
