#ifndef AppVersion
  #error AppVersion is required
#endif
[Setup]
AppId={{604083A8-E0EA-4B02-A4E4-32761F257051}
AppName=Kady
AppVersion={#AppVersion}
AppPublisher=K-Dense
AppPublisherURL=https://github.com/K-Dense-AI/k-dense-byok
DefaultDirName={localappdata}\Programs\Kady
DefaultGroupName=Kady
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=Kady-{#AppVersion}-windows-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\kadyw.exe
CloseApplications=no
RestartApplications=no

[InstallDelete]
; Replace the previous version's application files rather than layering the
; new ones over them: stale node_modules or sources would shadow the update.
; User data lives in %LOCALAPPDATA%\Kady, outside {app}.
Type: filesandordirs; Name: "{app}\resources"

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; kadyw.exe is the windowless build; kady.exe is the console CLI.
Name: "{group}\Kady"; Filename: "{app}\kadyw.exe"
Name: "{group}\Stop Kady"; Filename: "{app}\kadyw.exe"; Parameters: "stop"
Name: "{group}\Uninstall Kady"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\kadyw.exe"; Description: "Open Kady in your browser"; Flags: nowait postinstall skipifsilent

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var ExitCode: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\kady.exe')) then begin
    if Exec(ExpandConstant('{app}\kady.exe'), 'status', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0) then
      Result := 'Kady is running. Stop it from Settings > Services or the Stop Kady shortcut, then retry. Active research tasks will be interrupted when you stop.';
  end;
end;

function InitializeUninstall(): Boolean;
var ExitCode: Integer;
begin
  Result := True;
  if Exec(ExpandConstant('{app}\kady.exe'), 'status', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0) then begin
    MsgBox('Stop Kady before uninstalling. Your projects and credentials will be kept.', mbInformation, MB_OK);
    Result := False;
  end;
end;
