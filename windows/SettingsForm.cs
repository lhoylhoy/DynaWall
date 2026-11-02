using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DynaWall;

/// <summary>
/// The settings window, mirroring the macOS popover: greeting copy, palette, photo
/// source and slideshow controls, and the per-user startup switch. Changes apply to
/// the wallpaper immediately and are saved to
/// <c>%LOCALAPPDATA%\DynaWall\settings.json</c>.
/// </summary>
internal sealed class SettingsForm : Form
{
    private static readonly Color Background = Color.FromArgb(13, 17, 23);
    private static readonly Color Surface = Color.FromArgb(22, 27, 34);
    private static readonly Color BorderColor = Color.FromArgb(48, 54, 61);
    private static readonly Color Ink = Color.FromArgb(230, 237, 243);
    private static readonly Color Muted = Color.FromArgb(139, 148, 158);

    private static readonly string[] ThemeLabels =
    {
        "Auto (time of day)",
        "Dawn (05–09)",
        "Day (09–17)",
        "Dusk (17–21)",
        "Night (21–05)",
        "Custom color"
    };

    private readonly WallpaperController controller;
    private readonly TextBox firstNameBox = new();
    private readonly TextBox subtitleBox = new();
    private readonly ComboBox themeBox = new();
    private readonly Button colorButton = new();
    private readonly TextBox folderBox = new();
    private readonly CheckBox slideshowBox = new();
    private readonly NumericUpDown intervalBox = new();
    private readonly CheckBox shuffleBox = new();
    private readonly CheckBox kenBurnsBox = new();
    private readonly CheckBox photoSyncBox = new();
    private readonly CheckBox startupBox = new();
    private readonly System.Windows.Forms.Timer debounce = new() { Interval = 250 };
    private bool loading;

    internal SettingsForm(WallpaperController controller)
    {
        this.controller = controller;

        Text = "DynaWall Settings";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(540, 720);
        BackColor = Background;
        ForeColor = Ink;
        Font = new Font("Segoe UI", 9f);

        try
        {
            var path = Environment.ProcessPath;
            if (!string.IsNullOrEmpty(path))
            {
                var icon = Icon.ExtractAssociatedIcon(path);
                if (icon is not null) Icon = icon;
            }
        }
        catch (Exception)
        {
            // The default form icon is fine.
        }

        BuildInterface();
        LoadFromPreferences();

        firstNameBox.TextChanged += OnTextChanged;
        subtitleBox.TextChanged += OnTextChanged;
        themeBox.SelectedIndexChanged += OnThemeChanged;
        slideshowBox.CheckedChanged += OnOptionChanged;
        shuffleBox.CheckedChanged += OnOptionChanged;
        kenBurnsBox.CheckedChanged += OnOptionChanged;
        photoSyncBox.CheckedChanged += OnOptionChanged;
        intervalBox.ValueChanged += OnOptionChanged;
        startupBox.CheckedChanged += OnStartupChanged;
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

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try
        {
            // DWMWA_USE_IMMERSIVE_DARK_MODE: the title bar joins the dark surface.
            var enabled = 1;
            DwmSetWindowAttribute(Handle, 20, ref enabled, sizeof(int));
        }
        catch (Exception)
        {
            // Older Windows builds render the light title bar instead.
        }
    }

    protected override bool ProcessCmdKey(ref Message message, Keys keyData)
    {
        if (keyData == Keys.Escape)
        {
            Close();
            return true;
        }

        return base.ProcessCmdKey(ref message, keyData);
    }

    private void BuildInterface()
    {
        var scroll = new Panel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            BackColor = Background,
            Padding = new Padding(18, 16, 18, 16)
        };

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            BackColor = Background
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        scroll.Controls.Add(root);
        Controls.Add(scroll);

        StyleInput(firstNameBox);
        firstNameBox.PlaceholderText = Preferences.DefaultFirstName;
        StyleInput(subtitleBox);
        subtitleBox.PlaceholderText = Preferences.DefaultSubtitle;
        StyleInput(folderBox);
        folderBox.ReadOnly = true;
        folderBox.PlaceholderText = "Bundled wallpapers";

        themeBox.DropDownStyle = ComboBoxStyle.DropDownList;
        themeBox.FlatStyle = FlatStyle.Flat;
        themeBox.BackColor = Background;
        themeBox.ForeColor = Ink;
        themeBox.Items.AddRange(ThemeLabels);
        themeBox.SelectedIndex = 0;
        themeBox.Margin = new Padding(0, 2, 0, 2);

        StyleButton(colorButton);
        colorButton.Click += (_, _) => PickColor();

        var browseButton = new Button { Text = "Choose…", AutoSize = true };
        StyleButton(browseButton);
        browseButton.Click += (_, _) => ChooseFolder();

        var bundledButton = new Button { Text = "Bundled", AutoSize = true };
        StyleButton(bundledButton);
        bundledButton.Click += (_, _) => UseBundledPhotos();

        var folderRow = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 3,
            BackColor = Surface,
            Margin = new Padding(0)
        };
        folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        folderBox.Margin = new Padding(0, 2, 8, 2);
        browseButton.Margin = new Padding(0, 0, 8, 0);
        folderRow.Controls.Add(folderBox, 0, 0);
        folderRow.Controls.Add(browseButton, 1, 0);
        folderRow.Controls.Add(bundledButton, 2, 0);

        intervalBox.Minimum = Preferences.MinIntervalMinutes;
        intervalBox.Maximum = Preferences.MaxIntervalMinutes;
        intervalBox.Increment = 5;
        intervalBox.Value = Preferences.DefaultIntervalMinutes;
        intervalBox.BackColor = Background;
        intervalBox.ForeColor = Ink;
        intervalBox.BorderStyle = BorderStyle.FixedSingle;
        intervalBox.Width = 80;
        intervalBox.Margin = new Padding(0, 2, 0, 2);

        StyleToggle(slideshowBox, "Photo slideshow");
        StyleToggle(shuffleBox, "Shuffle order");
        StyleToggle(kenBurnsBox, "Slow zoom (Ken Burns)");
        StyleToggle(photoSyncBox, "Match photos to time of day");
        StyleToggle(startupBox, "Start DynaWall when I sign in");

        AddCard(root, "Greeting",
            FieldRow("First name", firstNameBox),
            FieldRow("Subtitle", subtitleBox));
        AddCard(root, "Appearance",
            FieldRow("Theme", themeBox),
            FieldRow("Background", colorButton));
        AddCard(root, "Photos",
            FieldRow("Folder", folderRow),
            slideshowBox,
            FieldRow("Rotate every", intervalBox),
            shuffleBox,
            kenBurnsBox,
            photoSyncBox);
        AddCard(root, "Startup", startupBox);
        AddCard(root, string.Empty, BuildFooter());
    }

    private FlowLayoutPanel BuildFooter()
    {
        var footer = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            BackColor = Surface,
            Margin = new Padding(0)
        };

        var closeButton = new Button { Text = "Close", AutoSize = true };
        StyleButton(closeButton);
        closeButton.Click += (_, _) => Close();

        var resetButton = new Button { Text = "Reset", AutoSize = true };
        StyleButton(resetButton);
        resetButton.Click += (_, _) => ResetSettings();

        footer.Controls.Add(closeButton);
        footer.Controls.Add(resetButton);
        return footer;
    }

    private static void AddCard(TableLayoutPanel root, string title, params Control[] children)
    {
        var card = new Panel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = Surface,
            Padding = new Padding(14, 12, 14, 14),
            Margin = new Padding(0, 0, 0, 12)
        };

        var column = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            BackColor = Surface
        };
        column.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        if (title.Length > 0)
        {
            column.Controls.Add(new Label
            {
                Text = title.ToUpperInvariant(),
                AutoSize = true,
                ForeColor = Muted,
                Font = new Font("Segoe UI", 8f, FontStyle.Bold),
                Margin = new Padding(0, 0, 0, 8)
            });
        }

        foreach (var child in children)
        {
            child.Dock = DockStyle.Top;
            column.Controls.Add(child);
        }

        card.Controls.Add(column);

        var row = root.RowCount;
        root.RowCount = row + 1;
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.Controls.Add(card, 0, row);
    }

    private static TableLayoutPanel FieldRow(string labelText, Control input)
    {
        var row = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 2,
            BackColor = Surface,
            Margin = new Padding(0, 0, 0, 8)
        };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        var label = new Label
        {
            Text = labelText,
            AutoSize = true,
            ForeColor = Muted,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(0, 6, 10, 0)
        };

        input.Dock = DockStyle.Fill;
        input.Margin = new Padding(0, 2, 0, 2);
        row.Controls.Add(label, 0, 0);
        row.Controls.Add(input, 1, 0);
        return row;
    }

    private static void StyleInput(TextBox box)
    {
        box.BackColor = Background;
        box.ForeColor = Ink;
        box.BorderStyle = BorderStyle.FixedSingle;
        box.Margin = new Padding(0, 2, 0, 2);
    }

    private static void StyleButton(Button button)
    {
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderColor = BorderColor;
        button.BackColor = Background;
        button.ForeColor = Ink;
        button.AutoSize = true;
        button.Padding = new Padding(8, 3, 8, 3);
    }

    private static void StyleToggle(CheckBox box, string text)
    {
        box.Text = text;
        box.AutoSize = true;
        box.ForeColor = Ink;
        box.BackColor = Surface;
        box.Margin = new Padding(0, 2, 0, 6);
    }

    private void LoadFromPreferences()
    {
        loading = true;

        firstNameBox.Text = Preferences.FirstName;
        subtitleBox.Text = Preferences.Subtitle;
        themeBox.SelectedIndex = Math.Max(0, Array.IndexOf(Preferences.ThemeModes, Preferences.Theme));
        UpdateColorButton();
        folderBox.Text = Preferences.PhotoFolder;
        slideshowBox.Checked = Preferences.Slideshow;
        intervalBox.Value = Math.Clamp(
            Preferences.SlideshowInterval, (int)intervalBox.Minimum, (int)intervalBox.Maximum);
        shuffleBox.Checked = Preferences.SlideshowShuffle;
        kenBurnsBox.Checked = Preferences.KenBurns;
        photoSyncBox.Checked = Preferences.PhotoSync;
        startupBox.Checked = StartupRegistration.IsEnabled;

        loading = false;
        UpdateEnabledState();
    }

    private void UpdateColorButton()
    {
        var color = ColorTranslator.FromHtml(Preferences.BgColor);
        colorButton.BackColor = color;
        var luminance = (color.R * 0.299) + (color.G * 0.587) + (color.B * 0.114);
        colorButton.ForeColor = luminance > 140 ? Background : Ink;
        colorButton.Text = Preferences.BgColor;
    }

    private void UpdateEnabledState()
    {
        var slideshow = slideshowBox.Checked;
        intervalBox.Enabled = slideshow;
        shuffleBox.Enabled = slideshow;
        kenBurnsBox.Enabled = slideshow;
    }

    private void OnTextChanged(object? sender, EventArgs e)
    {
        if (loading) return;

        Preferences.FirstName = Preferences.NormalizeName(firstNameBox.Text);
        Preferences.Subtitle = subtitleBox.Text;
        debounce.Stop();
        debounce.Start();
    }

    private void OnThemeChanged(object? sender, EventArgs e)
    {
        if (loading) return;

        var index = Math.Max(0, themeBox.SelectedIndex);
        Preferences.Theme = Preferences.ThemeModes[Math.Min(index, Preferences.ThemeModes.Length - 1)];
        Commit();
    }

    private void OnOptionChanged(object? sender, EventArgs e)
    {
        if (loading) return;

        Preferences.Slideshow = slideshowBox.Checked;
        Preferences.SlideshowInterval = (int)intervalBox.Value;
        Preferences.SlideshowShuffle = shuffleBox.Checked;
        Preferences.KenBurns = kenBurnsBox.Checked;
        Preferences.PhotoSync = photoSyncBox.Checked;

        UpdateEnabledState();
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

    private void PickColor()
    {
        using var dialog = new ColorDialog
        {
            FullOpen = true,
            AnyColor = true,
            Color = ColorTranslator.FromHtml(Preferences.BgColor)
        };

        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        Preferences.BgColor = $"#{dialog.Color.R:X2}{dialog.Color.G:X2}{dialog.Color.B:X2}".ToLowerInvariant();
        // A hand-picked colour pins the custom palette, exactly like script.js.
        Preferences.Theme = "custom";

        loading = true;
        themeBox.SelectedIndex = Array.IndexOf(Preferences.ThemeModes, "custom");
        loading = false;

        UpdateColorButton();
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
        folderBox.Text = Preferences.PhotoFolder;
        Commit(reloadPhotos: true);
    }

    private void UseBundledPhotos()
    {
        Preferences.PhotoFolder = string.Empty;
        folderBox.Text = string.Empty;
        Commit(reloadPhotos: true);
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
        if (reloadPhotos) controller.ReloadPhotos();
    }
}


