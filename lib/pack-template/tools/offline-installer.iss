; offline-installer.iss — 鲸师离线阅读器的 Inno Setup 安装脚本
; ------------------------------------------------------------------
; 编译：node tools/build-offline-installer.js
;   （手工也行：& "<Inno 安装目录>\ISCC.exe" tools\offline-installer.iss）
;
; 设计要点：
;   · 装到**用户目录**（{localappdata}\Programs\鲸师课件）⇒ **不需要管理员权限**
;   · 桌面 ＋ 开始菜单快捷方式指向 `start.cmd`，图标取 `app\assets\starmap.ico`
;   · **课程库不在安装目录里**（在 %LOCALAPPDATA%\鲸师课件\packs）⇒ 卸载只删安装目录，
;     学生的课件、答疑、笔记一条都不会动（下面故意**没有 [UninstallDelete]**）
;   · 卸载器由 Inno 自带（unins000.exe）
;
; 源：`dist-offline\whale-reader\`（由 tools/build-offline-payload.js 产出）

#define PayloadDir "..\dist-offline\whale-reader"
#define AppVer "1.0.0"

[Setup]
AppName=鲸师课件
AppVersion={#AppVer}
AppVerName=鲸师课件 {#AppVer}
AppPublisher=鲸师
DefaultDirName={localappdata}\Programs\鲸师课件
DefaultGroupName=鲸师课件
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist-offline
OutputBaseFilename=鲸师离线阅读器-{#AppVer}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\app\assets\starmap.ico
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "cn"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
; ⚠️ 用 `{autoprograms}` 而不是 `{group}`：后者会在开始菜单里建一个「鲸师课件」**文件夹**、
;    里面再放一个同名快捷方式（双层同名，啰嗦）。这样开始菜单就一条，与桌面一致。
Name: "{autoprograms}\鲸师课件"; Filename: "{app}\start.cmd"; IconFilename: "{app}\app\assets\starmap.ico"; WorkingDir: "{app}"; Comment: "打开鲸师课件（离线阅读器）"
Name: "{autodesktop}\鲸师课件"; Filename: "{app}\start.cmd"; IconFilename: "{app}\app\assets\starmap.ico"; WorkingDir: "{app}"; Comment: "打开鲸师课件（离线阅读器）"

[Run]
Filename: "{app}\start.cmd"; Description: "现在打开鲸师课件"; Flags: postinstall shellexec skipifsilent

; ⚠️ 故意不写 [UninstallDelete]：
;    课程库在 {localappdata}\鲸师课件\packs —— 卸载只该删安装目录（Inno 默认行为），
;    不许碰学生的课件与答疑笔记。
