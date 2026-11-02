# Windows XP field guide for Y2Kbot agents

Practical notes for an agent driving Windows XP from screenshots. Each `## id: Title` section is
one topic the `xp_guide` tool can return. Edit freely: a copy placed in the app's data folder
at `knowledge/xp-guide.md` overrides this one.

## quickstart: The ten things that matter most

1. **Open things with xp_run.** `notepad`, `cmd`, `explorer C:\`, `control`, `mspaint`, `wordpad`, `calc`, `taskmgr`. It beats hunting for icons every time.
2. **The keyboard is more reliable than the mouse.** Enter presses the highlighted (default) button. Esc cancels. Tab moves between fields. Alt+F4 closes the active window.
3. **Underlined letters are shortcuts.** Hold Alt and press the letter: alt+f opens the File menu, alt+y clicks "Yes", alt+n clicks "No". XP hides the underlines until you press Alt.
4. **Check focus before typing.** The active window's title bar is bright blue; inactive ones are pale blue. If unsure, click inside the window first.
5. **XP is slow here.** If nothing changed, xp_wait 3–5 seconds before trying again. Repeating a click often opens two copies or toggles something back off.
6. **Use full paths.** Type `C:\work\notes.txt` straight into "File name:" boxes and the Run box. Put quotes around paths with spaces.
7. **Maximise windows** (double-click the title bar) so buttons are big and in predictable places.
8. **Close pop-ups that aren't yours** (balloon tips, "tour Windows XP", security warnings) with their X or Esc, then carry on.
9. **Verify, don't assume.** After saving or creating something, prove it: `cmd /c dir C:\work & pause`, or open the folder.
10. **Your shared drive is usually D:.** It's how files get in and out. Wait a few seconds after saving there before shutting down.

## layout: What the screen looks like

- **Taskbar:** a blue bar along the bottom. The green **start** button is at the bottom-left corner. Open windows appear as buttons in the middle of the taskbar; click one to bring it to the front. The clock and small notification icons ("system tray") are at the bottom-right.
- **Desktop:** icons in a column down the left side, usually just *Recycle Bin* (bottom-right in some setups) and any shortcuts the operator added. Double-click an icon to open it.
- **Windows:** title bar on top (title text on the left; minimise, maximise and close buttons on the right, close being the red X). Most programs have a menu bar under the title (File, Edit, View, ..., Help).
- **Highlights:** a selected item in a list, or a focused button, shows a blue highlight or a dotted outline. Greyed-out text means a disabled option.
- **Default button:** in a dialog, the button with a thicker blue/dark border is what Enter presses.
- Typical screen size is 1024×768. The taskbar is the bottom ~30 pixels; the start button sits roughly in the leftmost 100 pixels of it.

## start-menu: The Start menu

Click **start** (bottom-left) or press **ctrl+esc**. (The win key also works.)
- **Left column:** pinned programs at the top, recently used programs below, and **All Programs** at the bottom. Hover over or click All Programs to open a cascading list of folders (Accessories, Games, Startup...). *Accessories* holds Notepad, Paint, WordPad, Calculator, Command Prompt, Windows Explorer, and *System Tools*.
- **Right column:** My Documents, My Pictures, My Music, My Computer, Control Panel, Printers and Faxes, Help and Support, Search, and **Run...**
- **Bottom:** Log Off, and Turn Off Computer. You don't need these; use xp_shutdown instead.
- Navigating cascading menus with the mouse is fiddly: menus close if the pointer wanders off. Prefer xp_run, or use the arrow keys once the menu is open (Up/Down to move, Right to open a submenu, Enter to launch).

## keyboard: Keyboard shortcuts that work almost everywhere

| Keys | Does |
|---|---|
| enter / esc | default button / cancel or close a menu or dialog |
| tab / shift+tab | next / previous field or button |
| space | press the focused button, tick or untick a checkbox |
| alt | show the menu bar's underlined letters, then press a letter |
| alt+f4 | close the active window (on the desktop: opens the shut-down dialog, so press esc) |
| alt+tab | switch to another open window |
| alt+space, then x | maximise the active window (n = minimise, r = restore) |
| win+r | Run box · win+e Explorer · win+d show the desktop · ctrl+esc Start menu |
| ctrl+s / ctrl+o / ctrl+n | save / open / new (in most programs) |
| ctrl+a, ctrl+c, ctrl+x, ctrl+v, ctrl+z | select all, copy, cut, paste, undo |
| f2 | rename the selected file · f5 refresh |
| delete | delete the selected file (asks "Are you sure...?" → enter) |
| shift+f10 | right-click menu for the selected thing |
| backspace (in Explorer) | go up one folder |
| ctrl+shift+esc | Task Manager |
| home / end, ctrl+home / ctrl+end | start / end of line, start / end of document |

## files-and-paths: Where things live

- `C:\` is the system drive. `D:\` is usually your shared drive. (Check *My Computer* if there are others, such as a CD drive.)
- User folders are in `C:\Documents and Settings\<user name>\`: `Desktop`, `My Documents`, `Start Menu`. The user name appears at the top of the Start menu. Paths with spaces need quotes on the command line.
- Programs install to `C:\Program Files\`. Windows itself lives in `C:\WINDOWS\`.
- Creating a working folder at a simple path (e.g. `C:\work`) avoids long paths with spaces: `cmd /c md C:\work`.
- File extensions are hidden by default in Explorer (so `notes.txt` shows as `notes`). To show them: Explorer → Tools → Folder Options → View tab → untick "Hide extensions for known file types" → OK. Or just use `dir` in cmd, which always shows them.

## notepad: Make or edit a text file in Notepad

**Fastest way to create a file:**
1. xp_run `notepad C:\work\notes.txt` (the folder must already exist).
2. If the file doesn't exist yet, XP asks "Cannot find the ... file. Do you want to create a new file?" Press **enter** (Yes is the default).
3. xp_type the text. Use `\n` for new lines.
4. **ctrl+s** saves straight to that path, with no dialog because the file already has a name.
5. **alt+f4** closes Notepad.

**Starting from a blank Notepad (no name yet):** ctrl+s opens *Save As*; see the `save-dialog` topic.

**Closing with unsaved changes:** XP asks "Do you want to save the changes?" alt+y saves, alt+n discards, esc cancels.

**Editing an existing file:** xp_run `notepad C:\path\file.txt`, then ctrl+end to jump to the end, or ctrl+a to select all and replace the text by typing.

**One-liners without Notepad:**
- `cmd /c echo Hello world> C:\work\hello.txt` writes (or overwrites) a file.
- `cmd /c echo Another line>> C:\work\hello.txt` appends a line.
- Several lines at once: `cmd /c (echo line one& echo line two& echo line three)> C:\work\list.txt`
- Don't put a space before `>`, or it ends up in the file. `echo.` writes a blank line.

## save-dialog: Using Save As / Open dialogs

These dialogs look the same in most programs:
- **"Save in:" / "Look in:"** is a drop-down at the top showing the current folder.
- The big area in the middle lists files and folders.
- **"File name:"** is a text box near the bottom, and usually has focus when the dialog opens.
- **"Save as type:" / "Files of type:"** is a drop-down below it.
- **Save / Open** and **Cancel** buttons are on the right.

**The reliable method:** ignore the folder browsing, select all in "File name:" (ctrl+a), type the **full path** such as `C:\work\report.txt` or `D:\result.txt`, and press **enter**.

- If it says the file "already exists. Do you want to replace it?", press **alt+y** to replace or **alt+n** to pick another name.
- If it says the path doesn't exist, the folder isn't there: create it first (`cmd /c md C:\work`) and try again.
- To pick a format, open "Save as type" (alt+t, then use the arrow keys) before pressing enter, or simply type the extension you want in the name.

## explorer: Browsing files and folders (Windows Explorer / My Computer)

- **Open a folder directly:** xp_run `explorer C:\work` (or just `C:\work`, or `D:\`).
- **Address bar:** at the top of the window. Click it, select all (ctrl+a), type a path and press enter.
- **Views:** View menu → *Details* shows names, sizes, types and dates in columns, which is easier to read from screenshots.
- **New folder:** File → New → Folder, type the name and press enter. Or `cmd /c md C:\path\name`.
- **Rename:** select the item, press f2, type the new name, press enter.
- **Copy/move:** select the item, ctrl+c (copy) or ctrl+x (cut), go to the destination folder, ctrl+v. Or use cmd `copy` / `move`.
- **Delete:** select the item, press delete, then enter to confirm. Deleted files go to the Recycle Bin.
- **Open a file:** double-click it, or select it and press enter.
- **Zip files:** XP can open .zip files like folders. To extract one, right-click → *Extract All...* → a wizard opens; press enter through it (Next, Next, Finish).

## cmd: Command Prompt

Open it with xp_run `cmd`. To run one command and see the output before the window closes, use `cmd /k <command>` (stays open) or `cmd /c <command> & pause`.

Useful commands:
- `dir` lists the folder. `dir /b` gives bare names; `dir C:\work\*.txt` filters.
- `cd C:\work` changes folder; `cd ..` goes up. Switch drives by typing just `D:`.
- `md name` makes a folder · `rd name` removes an empty folder.
- `copy a.txt b.txt` · `move a.txt C:\other\` · `ren old.txt new.txt` · `del file.txt`
- `type file.txt` prints a text file (great for checking what you saved) · `more < big.txt` shows it a page at a time.
- `echo text> file` writes and `echo text>> file` appends (see `notepad` for multi-line).
- `start notepad C:\x.txt` launches a program without waiting for it.
- `ver` shows the Windows version · `systeminfo` gives a system summary (XP Professional) · `ipconfig` shows network settings.
- `tasklist` / `taskkill /im notepad.exe /f` list and kill programs (XP Professional only).
- `exit` closes the window.

Notes:
- There's no PowerShell on XP; this is plain cmd.exe.
- Quote paths with spaces: `cd "C:\Documents and Settings"`.
- Type `cls` to clear a messy screen before taking a screenshot to read output.
- Long output scrolls away, so redirect it to a file and read that: `dir C:\ /s > C:\work\list.txt`, then `type` it or open it in Notepad.

## control-panel: Settings (Control Panel)

xp_run `control` opens the Control Panel. XP may show *Category View*; click "Switch to Classic View" on the left for a plain list of icons.

Go straight to a settings page with xp_run:

| Run this | Opens |
|---|---|
| `desk.cpl` | Display: screen resolution, screensaver, theme |
| `appwiz.cpl` | Add or Remove Programs |
| `sysdm.cpl` | System Properties: computer name, hardware, Device Manager button |
| `timedate.cpl` | Date and time |
| `intl.cpl` | Regional and language settings |
| `main.cpl` | Mouse |
| `mmsys.cpl` | Sounds and audio devices |
| `powercfg.cpl` | Power options (turn off sleep / monitor off) |
| `nusrmgr.cpl` | User accounts |
| `ncpa.cpl` | Network connections |
| `firewall.cpl` | Windows Firewall |
| `devmgmt.msc` | Device Manager |
| `services.msc` | Services |
| `msconfig` | Startup items and boot settings |
| `regedit` | Registry editor (be careful) |
| `winver` | Which Windows version and service pack |
| `dxdiag` | DirectX / hardware diagnostics |

Settings dialogs use tabs along the top: click a tab name, or use ctrl+tab to cycle through them. Changes take effect after **Apply** or **OK**.

## install: Installing a program

1. Put the installer in the shared folder before booting (the user can drop it on your IM window), or check `D:\` with xp_run `D:\`.
2. Run it: xp_run `D:\setup.exe` (use the real file name; `.msi` files work the same way).
3. Most installers are wizards: press **enter** (Next) to move on. The licence page usually needs "I accept" ticked first: alt+a, or click the radio button, then Next. Leave the install folder as the default unless told otherwise.
4. Wait for the progress bar with xp_wait, since installs are slow here. Finish with **Finish** (enter).
5. Find the new program in Start → All Programs, or run it from `C:\Program Files\<name>\`.
6. If asked to restart, it's usually fine to say No for a quick test. Only restart if the program won't run otherwise.

## popups: Pop-ups and interruptions you'll meet

- **Balloon tips** (yellow speech bubbles from the bottom-right, e.g. "Your computer might be at risk", "Take a tour of Windows XP"): click their small X, or ignore them. They fade on their own.
- **"Found New Hardware" wizard:** press esc or click Cancel unless the task is about drivers.
- **Windows activation reminders / key icon in the tray:** ignore.
- **"Windows cannot open this file" / "Open With" dialog:** the file type has no program. Pick one from the list (e.g. Notepad for text) or press esc.
- **"Are you sure you want to delete / replace...?":** read it. alt+y means yes, alt+n means no.
- **A dialog won't go away:** check whether there's a second dialog behind it (look at the taskbar), press esc, or alt+f4 it.
- **Error dialogs:** read the message in the screenshot and report it to the user. It's often the answer to "what went wrong".

## apps: The built-in programs

- **Notepad** (`notepad`): plain text. See the `notepad` topic.
- **WordPad** (`wordpad`): formatted text. It saves as .rtf by default; for plain text, choose "Text Document" in "Save as type". It also opens .doc files from old Word.
- **Paint** (`mspaint`): images. File → Save As lets you choose BMP, JPEG, GIF, TIFF or PNG in "Save as type". Ctrl+e sets the canvas size. Ctrl+v pastes a screenshot taken with the printscreen key.
- **Calculator** (`calc`): View → Scientific for the advanced one. Type numbers on the keyboard, press enter for =, and ctrl+c copies the result.
- **Internet Explorer** (`iexplore`): there's no internet unless the operator enabled it. It can still open local .htm files: `iexplore C:\page.htm`.
- **Command Prompt** (`cmd`) and **Task Manager** (`taskmgr`, or ctrl+shift+esc): to end a stuck program, use the Applications tab, select it, then End Task.
- **Character Map** (`charmap`), **Sound Recorder** (`sndrec32`), **Windows Media Player** (`wmplayer`), **Disk Cleanup** (`cleanmgr`), **System Information** (`msinfo32`).

## troubleshooting: When things go wrong

- **Nothing happened after an action:** xp_wait 3–5s. Check the taskbar for a new button, since the window may have opened behind another one. Use alt+tab to look.
- **Typed text went to the wrong place:** focus was elsewhere. Undo with ctrl+z, click inside the right field or window, then retype.
- **A click missed:** look at the red crosshair in the screenshot to see where the pointer actually went, then adjust. Maximise the window to make targets bigger.
- **A menu or drop-down is open and in the way:** press esc (once or twice).
- **A program is frozen ("Not Responding" in the title):** wait 10s. If it's still frozen, ctrl+shift+esc → Applications → End Task.
- **Lost track of what's open:** win+d shows the desktop, and the taskbar lists every window.
- **The screen is black or the screensaver is on:** move the mouse a little (click an empty area) or press shift.
- **Something keeps failing the same way:** stop repeating it and try a different route (keyboard instead of mouse, cmd instead of the GUI). After two or three failures, tell the user what you see.
- **The machine is in a bad state:** xp_shutdown then xp_boot gives a completely fresh XP (nothing is saved except the shared drive).

## shared-drive: Getting files in and out

- The buddy's shared folder appears in XP as an extra drive, usually `D:`. Check *My Computer* (xp_run `explorer`) if not.
- **Files in:** anything in the folder before boot (including files the user drops on the IM window) appears on that drive. Files added while XP is running won't show until the next boot.
- **Files out:** save or copy files to `D:\` inside XP. They land in the folder on the user's computer. Wait a few seconds after saving before xp_shutdown so Windows finishes writing.
- From outside XP, use `shared_files`, `shared_read` and `shared_write` (writing only works while XP is off).
- Quick copy-out from cmd: `copy C:\work\result.txt D:\`.
