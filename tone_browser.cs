using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// A Win32 child of HX Edit. Keeping the WebView in a helper process lets HX Edit
// own the USB connection and its UI thread while Edge runs its own message loop.
sealed class ToneBrowser : Form
{
    const string CardUrl = "https://hx-edit-nam.invalid/tone";
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);

    readonly IntPtr parent;
    readonly string profile;
    readonly TextWriter output;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly WebView2 browser = new WebView2 { Dock = DockStyle.Fill };
    readonly WebView2 details = new WebView2 { Dock = DockStyle.Fill };
    readonly RowStyle detailRow = new RowStyle(SizeType.Absolute, 48);
    readonly Timer timer = new Timer { Interval = 150 };
    Rectangle dock;
    Rectangle applied;
    Uri callback;
    bool panelVisible = true;
    string catalogPage;
    bool canRetry;
    bool hasTone;
    bool library;
    Dictionary<string, object> status = new Dictionary<string, object>();
    string cardHtml;

    ToneBrowser(IntPtr parent, string profile, Rectangle bounds, TextWriter output)
    {
        this.parent = parent;
        this.profile = profile;
        this.output = output;
        dock = bounds;
        TopLevel = false;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        AutoScaleMode = AutoScaleMode.None;
        Text = "TONE3000 · HX Edit NAM";
        BackColor = Color.FromArgb(18, 18, 18);

        browser.DefaultBackgroundColor = BackColor;
        details.DefaultBackgroundColor = BackColor;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(detailRow);
        browser.Margin = details.Margin = Padding.Empty;
        layout.Controls.Add(browser, 0, 0);
        layout.Controls.Add(details, 0, 1);
        Controls.Add(layout);
        timer.Tick += (sender, args) => LayoutPane();
        FormClosed += (sender, args) => timer.Dispose();
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var settings = base.CreateParams;
            settings.Parent = parent;
            settings.Style = (settings.Style & ~unchecked((int)0x80000000)) | 0x40000000;
            return settings;
        }
    }

    [STAThread]
    static void Main(string[] args)
    {
        var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        try
        {
            var parent = new IntPtr(long.Parse(args[0]));
            if (!IsWindow(parent)) throw new InvalidOperationException("The HX Edit window is unavailable.");
            SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(parent));
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var input = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8))
            using (var pane = new ToneBrowser(parent, args[1], new Rectangle(
                int.Parse(args[2]), int.Parse(args[3]), int.Parse(args[4]), int.Parse(args[5])), output))
            {
                pane.Shown += async (sender, evt) => await pane.Start(input);
                Application.Run(pane);
            }
        }
        catch (Exception error)
        {
            output.WriteLine(new JavaScriptSerializer().Serialize(new { type = "error", text = error.Message }));
        }
    }

    async Task Start(TextReader input)
    {
        try
        {
            if (GetParent(Handle) != parent) throw new InvalidOperationException("Could not dock the TONE3000 pane.");
            LayoutPane();
            timer.Start();
            var env = await CoreWebView2Environment.CreateAsync(userDataFolder: profile);
            await browser.EnsureCoreWebView2Async(env);
            var core = browser.CoreWebView2;
            core.Profile.PreferredColorScheme = CoreWebView2PreferredColorScheme.Dark;
            Configure(core, false);
            core.NavigationStarting += (sender, args) => args.Cancel = !CanNavigate(args.Uri);
            core.NewWindowRequested += (sender, args) => {
                args.Handled = true;
                if (CanNavigate(args.Uri)) core.Navigate(args.Uri);
            };
            core.WindowCloseRequested += (sender, args) => {
                if (catalogPage == null) SendAction("cancel");
            };

            await details.EnsureCoreWebView2Async(env);
            var card = details.CoreWebView2;
            Configure(card, true);
            card.NavigationStarting += (sender, args) => args.Cancel = args.Uri != CardUrl;
            card.NewWindowRequested += (sender, args) => args.Handled = true;
            card.AddWebResourceRequestedFilter(CardUrl, CoreWebView2WebResourceContext.Document);
            card.WebResourceRequested += (sender, args) => {
                if (cardHtml == null || args.Request.Uri != CardUrl) return;
                var html = new MemoryStream(Encoding.UTF8.GetBytes(cardHtml));
                args.Response = env.CreateWebResourceResponse(html, 200, "OK",
                    "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store");
            };
            card.DOMContentLoaded += (sender, args) => UpdateCard();
            card.WebMessageReceived += (sender, args) => {
                if (args.Source != CardUrl || card.Source != CardUrl) return;
                var action = args.TryGetWebMessageAsString();
                if (action != "back") SendAction(action);
                else if (catalogPage != null)
                {
                    var page = catalogPage;
                    catalogPage = null;
                    core.Navigate(page);
                    UpdateCard();
                }
            };
            output.WriteLine("{\"type\":\"ready\"}");
            await Task.Run(() => ReadCommands(input));
        }
        catch (Exception error)
        {
            output.WriteLine(json.Serialize(new { type = "error", text = error.Message }));
            Close();
        }
    }

    static void Configure(CoreWebView2 core, bool messages)
    {
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsWebMessageEnabled = messages;
        core.LaunchingExternalUriScheme += (sender, args) => args.Cancel = true;
        core.DownloadStarting += (sender, args) => args.Cancel = true;
    }

    void SendAction(string value)
    {
        output.WriteLine(json.Serialize(new { type = "action", value }));
    }

    void UpdateCard()
    {
        var card = details.CoreWebView2;
        if (card.Source != CardUrl) return;
        status["viewing_source"] = catalogPage != null;
        status["can_retry"] = canRetry;
        card.PostWebMessageAsJson(json.Serialize(status));
    }

    void ReadCommands(TextReader input)
    {
        for (string line; (line = input.ReadLine()) != null;)
        {
            var message = json.Deserialize<Dictionary<string, object>>(line);
            if (IsDisposed) return;
            BeginInvoke(new Action(() => Receive(message)));
        }
        if (!IsDisposed) BeginInvoke(new Action(Close));
    }

    void Receive(Dictionary<string, object> message)
    {
        var core = browser.CoreWebView2;
        switch ((string)message["type"])
        {
            case "navigate":
                canRetry = false;
                catalogPage = null;
                callback = new Uri((string)message["callback"]);
                core.Navigate((string)message["url"]);
                UpdateCard();
                break;
            case "card":
                cardHtml = (string)message["html"];
                hasTone = (bool)message["has_tone"];
                library = message.ContainsKey("library") && (bool)message["library"];
                LayoutPane();
                details.CoreWebView2.Navigate(CardUrl);
                break;
            case "source":
                var source = (string)message["url"];
                if (catalogPage != null || !IsToneUrl(source) || !IsToneUrl(core.Source)) break;
                catalogPage = core.Source;
                core.Navigate(source);
                UpdateCard();
                break;
            case "status":
                status = message;
                UpdateCard();
                break;
            case "browseError":
                status["text"] = message["text"];
                canRetry = true;
                UpdateCard();
                break;
            case "bounds":
                panelVisible = (bool)message["visible"];
                if (panelVisible)
                    dock = new Rectangle((int)message["x"], (int)message["y"], (int)message["w"], (int)message["h"]);
                LayoutPane();
                break;
            case "close":
                Close();
                break;
        }
    }

    void LayoutPane()
    {
        if (!IsWindow(parent)) { Close(); return; }
        bool show = panelVisible && !IsIconic(parent) && dock.Width > 60 && dock.Height > 60;
        if (Visible != show) Visible = show;
        if (!show) return;
        var bounds = dock;
        // The NAM library page covers the TONE3000 catalog while it is open.
        var detailHeight = library ? dock.Height : hasTone ? Math.Min(150, Math.Max(130, dock.Height - 100)) : 48;
        detailHeight = Math.Min(detailHeight, dock.Height);
        if (detailRow.Height != detailHeight) detailRow.Height = detailHeight;
        if (bounds == applied) return;
        SetWindowPos(Handle, IntPtr.Zero, bounds.X, bounds.Y, bounds.Width, bounds.Height, 0x0010);
        applied = bounds;
    }

    bool CanNavigate(string address)
    {
        if (IsToneUrl(address)) return true;
        Uri uri;
        return catalogPage == null && callback != null && Uri.TryCreate(address, UriKind.Absolute, out uri) &&
            uri.GetLeftPart(UriPartial.Path) == callback.GetLeftPart(UriPartial.Path);
    }

    static bool IsToneUrl(string address)
    {
        Uri uri;
        return Uri.TryCreate(address, UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.IsDefaultPort &&
            (uri.Host == "www.tone3000.com" || uri.Host == "tone3000.com");
    }
}
