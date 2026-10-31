      ___    __________  ____  ____  __  ______  _   ________
     /   |  / ____/ __ \/ __ \/ __ \/ / / / __ \/ | / / ____/
    / /| | / __/ / /_/ / / / / /_/ / /_/ / / / /  |/ / __/
   / ___ |/ /___/ _, _/ /_/ / ____/ __  / /_/ / /|  / /___
  /_/  |_/_____/_/ |_|\____/_/   /_/ /_/\____/_/ |_/_____/
                                  C  O  M  P  A  N  I  O  N

              Enhanced expression for the Roland AE-20
==============================================================================

Aerophone Companion unlocks the potential of the Roland AE-20 Digital Wind
Instrument with an intuitive, browser-based app. It talks to your instrument
over USB using SysEx, the messages the AE-20 already understands.

It's made for the composing side of things: at the computer, trying sounds
against a track and moving quickly from idea to idea.


WHAT IT DOES
------------

LIVE VIEW
  A scene wheel for fast access to your saved Favorites, stock Presets or
  custom User banks. Reverb, delay, chorus and color knobs are within easy
  reach to shape the sound as you play.

SCENE EDITOR
  Open up any scene and explore the depth of tones and effects the instrument
  keeps under the hood. Follow the signal flow, go tone chasing and make the
  sound your own. Live breath data visualization makes it easier to adjust for
  your performance style.

TONES
  Go further and explore the tones that create a scene. It's the deepest layer
  of the AE-20, made easy to explore: oscillators, filters and amps are
  revealed visually, and every partial shows the name of the wave it plays.
  Browse and search all 1,980 built-in waves, add or remove partials, solo one
  to hear it on its own, or start a New tone from scratch. Save an edited tone
  to one of the 512 user tone slots, or save it to your computer as a ZENOLOGY
  bank file to keep shaping it in Roland's plug-in.

LIBRARY
  Your AE-20's sound vault. Import, export, organise and back up every scene,
  then send whole collections to the instrument in one go. Backup only reads
  from the AE-20, so nothing gets overwritten until you choose.


GETTING STARTED
---------------

You need a Roland AE-20, a USB-C data cable, and Chrome or Edge on Windows or
macOS.

1. If your computer doesn't list the AE-20 as a MIDI device, install the
   Aerophone USB driver (roland.com > Support > Aerophone AE-20 > Updates &
   Drivers).

2. Connect the AE-20 and turn it on. Close Roland's phone app (or turn
   Bluetooth off on the AE-20) so the two don't compete.


RUN IT
------

No install or build step, and no internet connection needed. Windows uses its
built-in PowerShell; macOS and Linux need Python 3.

Download the zip and extract it (the easiest way):
  https://github.com/wrongwaycorrigan/aerophoneCompanion/archive/refs/heads/main.zip

Or with git:
  git clone https://github.com/wrongwaycorrigan/aerophoneCompanion.git
  cd aerophoneCompanion

Then start the app in that folder:

  Windows   Double-click "Start Aerophone Companion (Windows).bat"
            or run: powershell -ExecutionPolicy Bypass -File serve.ps1

  macOS     Double-click "Start Aerophone Companion (Mac).command"
            (right-click > Open the first time)
            or run: sh "Start Aerophone Companion (Mac).command"

  Linux     (untested) run: cd app && python3 -m http.server 8642 --bind 127.0.0.1

The app opens at http://localhost:8642 in Chrome or Edge (on Linux, open it
yourself). Keep the server window open while you play. When the browser asks
to "control and reprogram your MIDI devices", click Allow.


BACK UP FIRST
-------------

In Library, click "Back up" on the AE-20 side. It reads every user scene and
your 12 favorites into a dated library on your computer and changes nothing
on the instrument. User tones aren't included in the backup.


TROUBLESHOOTING
---------------

- Windows warns about a downloaded file: right-click the zip > Properties >
  tick Unblock, then extract again.
- macOS won't open the start script: right-click it > Open, then Open again.
  If it still refuses, open Terminal, type the first line below (with a space
  at the end), drag the script onto the window and press Return. Then do the
  same with the second:
      xattr -d com.apple.quarantine
      chmod +x
- Firefox or Safari: they can't talk to MIDI devices this way. Use Chrome or
  Edge.
- Instrument unplugged or switched off: the status light at the top right
  shows it. Click the light to reconnect.
- Where your Library lives: in the browser at http://localhost:8642. Export
  anything you want to keep as files.
- Reporting a problem: include the version and build code shown next to the
  app's name (for example v0.14.1 · 09c89b9).


WHAT'S INSIDE
-------------

app/          The app itself. app/data.js holds facts about the AE-20
              (parameter addresses, ranges, effect types and settings, tone
              names), built from Roland's public documents for the
              AE-30/AE-20: the MIDI Implementation, the Parameter Guide and
              the Scene List. Scene and user tone names are read from your
              instrument.

tools/        Rebuilds app/data.js from newer editions of those documents.
              Needs Python 3, pdftotext and the pdfplumber package.

docs/images/  Images for the GitHub page.

  python3 tools/build_data.py "MIDI Implementation.pdf" "Parameter Guide.pdf" "Scene List.pdf" app/data.js
  python3 tools/stamp.py app


LICENSE AND NO WARRANTY
-----------------------

Released under the MIT License. Aerophone Companion is free software provided
"as is", without warranty of any kind. The author isn't liable for any
damages, including loss or corruption of scenes, tones, settings or other data
on your instrument or computer, or damage to equipment. See LICENSE.txt for
the full terms.

==============================================================================
Aerophone Companion is an independent, open source project and isn't
affiliated with or endorsed by Roland. Roland and Aerophone are trademarks of
Roland Corporation. Made with the help of Anthropic's Claude Code.
