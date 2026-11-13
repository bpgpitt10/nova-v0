; One-file installer for the Looper Companion (built by Inno Setup in CI).
; Per-user: no administrator prompt. Installs to the same folder the old
; ZIP/PowerShell installer used, so it upgrades those installs in place.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F1E2B7C-3A54-4D0E-9C1B-7E5A2D94C310}
AppName=Looper Companion
AppVersion={#AppVersion}
AppPublisher=The Looper
AppPublisherURL=https://thelooper.golf
DefaultDirName={localappdata}\Looper\Companion
PrivilegesRequired=lowest
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableWelcomePage=yes
OutputDir=.
OutputBaseFilename=LooperCompanionSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
UninstallDisplayName=Looper Companion
UninstallDisplayIcon={app}\LooperCompanion.exe

[Messages]
FinishedHeadingLabel=Looper Companion is running
FinishedLabelNoIcons=The companion is installed, running in the background, and will start with Windows.%n%nGo back to thelooper.golf: the page connects on its own.
FinishedLabel=The companion is installed, running in the background, and will start with Windows.%n%nGo back to thelooper.golf: the page connects on its own.

[InstallDelete]
Type: filesandordirs; Name: "{app}\ocr"

[Files]
Source: "package\LooperCompanion.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "package\ocr\*"; DestDir: "{app}\ocr"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Looper Companion"; Filename: "{app}\LooperCompanion.exe"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "LooperCompanion"; ValueData: """{app}\LooperCompanion.exe"""; Flags: uninsdeletevalue

[Run]
Filename: "{app}\LooperCompanion.exe"; Flags: nowait

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM LooperCompanion.exe"; Flags: runhidden; RunOnceId: "StopLooperCompanion"

[Code]
// Stop a running copy before its files are replaced (upgrade in place).
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM LooperCompanion.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(400);
  Result := '';
end;
