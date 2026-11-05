; DynaWall — per-user Windows installer (Inno Setup 6)
;
;   ISCC.exe /DAppVersion=1.0.0 windows\installer.iss
;
; Installs into %LOCALAPPDATA%\Programs\DynaWall, so Windows never shows an
; administrator prompt and the installer itself cannot be blocked by an
; elevation/UAC policy. DynaWall then runs from that folder behind the desktop
; icons on the pre-installed Microsoft Edge WebView2 runtime.

#define AppName "DynaWall"
#define AppPublisher "DynaWall"
#define AppExeName "DynaWall.exe"

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
; A stable AppId keeps upgrades and the uninstall entry tied to one installation.
AppId={{7E2B7F1C-3D64-4A83-9C1E-5F1B0E2A6D77}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\DynaWall
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=DynaWall-Setup
SetupIconFile=app.ico
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; WebView2 ships with Windows 10 1809+ and every Windows 11; the host is x64.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
CloseApplications=yes
CloseApplicationsFilter={#AppExeName}
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "startup"; Description: "Start DynaWall when I sign in"; GroupDescription: "Startup:"

[Files]
; DynaWall.exe (single file, self-contained) plus the web/ wallpaper folder.
Source: "publish\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExeName}"" --autostart"; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2ClientKey = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Installed: Boolean;
var
  Version: String;
begin
  Version := '';
  Result :=
    RegQueryStringValue(HKLM32, WebView2ClientKey, 'pv', Version) or
    RegQueryStringValue(HKLM64, WebView2ClientKey, 'pv', Version) or
    RegQueryStringValue(HKCU, WebView2ClientKey, 'pv', Version);
  Result := Result and (Version <> '') and (Version <> '0.0.0.0');
end;

procedure InitializeWizard;
begin
  if not WebView2Installed then
    MsgBox(
      'DynaWall uses the Microsoft Edge WebView2 runtime, which is pre-installed on' + #13#10 +
      'Windows 11 and Windows 10 1809+.' + #13#10#13#10 +
      'It was not found on this PC. Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703' + #13#10 +
      'or let Windows Update install it, then launch DynaWall.',
      mbInformation, MB_OK);
end;
