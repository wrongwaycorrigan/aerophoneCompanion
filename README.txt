      ___    __________  ____  ____  __  ______  _   ________
     /   |  / ____/ __ \/ __ \/ __ \/ / / / __ \/ | / / ____/
    / /| | / __/ / /_/ / / / / /_/ / /_/ / / / /  |/ / __/
   / ___ |/ /___/ _, _/ /_/ / ____/ __  / /_/ / /|  / /___
  /_/  |_/_____/_/ |_|\____/_/   /_/ /_/\____/_/ |_/_____/
                                  C  O  M  P  A  N  I  O  N

          A companion app for the Roland Aerophone AE-20
==============================================================================

Aerophone Companion unlocks the potential of the Roland AE-20 Digital Wind
Instrument with an intuitive, browser-based app.

It talks to your instrument over USB using SysEx, the messages the AE-20
already understands.


FIRST TIME
----------

1. If your computer doesn't list the AE-20 as a MIDI device, install the
   Aerophone USB driver (roland.com > Support > Aerophone AE-20 > Updates &
   Drivers).

2. Connect the AE-20 with a USB-C data cable and turn it on. Close Roland's
   phone app (or turn Bluetooth off on the AE-20) so the two don't compete.

3. Start Aerophone Companion:

   Windows  Double-click "Start Aerophone Companion (Windows).bat".
            If Windows warns about a downloaded file: right-click the .zip,
            choose Properties > Unblock, then extract again.

   Mac      Right-click "Start Aerophone Companion (Mac).command" > Open.
            Needs python3.

   A small server window opens, then Aerophone Companion in its own browser
   window. Keep the server window open while you play; close it when you're
   done.

4. When the browser asks to "control and reprogram your MIDI devices",
   click Allow.


BACK UP FIRST
-------------

In Library, click "Back up" on the AE-20 side. It reads every user scene and
your 12 favorites into a dated library on this computer, and changes nothing
on the instrument. Export it to keep a file. User tones are not included in
the backup.


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
  Browse and search all 1,980 built-in waves, or start a New tone from
  scratch. Save an edited tone to one of the 512 user tone slots and the
  scene's part plays it.

LIBRARY
  Your AE-20's sound vault. Import, export, organise and back up every scene,
  then send whole collections to the instrument in one go. Backup only reads
  from the AE-20, so nothing gets overwritten until you choose.


NOTES
-----

- The small text next to the name is the version and build code (for example
  v0.11.0 · a59c512). Mention it when reporting a problem.
- Your Library is stored in this browser at http://localhost:8642. Export what
  you want to keep as files.
- The status light top right shows when the AE-20 is unplugged or off; click
  it to reconnect.
- Firefox and Safari can't talk to MIDI devices this way; use Chrome or Edge.


WHAT'S INSIDE
-------------

app/    The app itself. app/data.js holds facts about the AE-20 (parameter
        addresses, ranges, effect types and settings, tone names), built from
        Roland's public documents for the AE-30/AE-20: the MIDI Implementation,
        the Parameter Guide and the Scene List (roland.com > Support >
        Aerophone AE-20 > Owner's Manuals). Scene and user tone names are read
        from your instrument.

tools/  Rebuilds app/data.js from newer editions of those documents:

          python3 tools/build_data.py <MIDI Implementation.pdf> \
                  <Parameter Guide.pdf> <Scene List.pdf> app/data.js
          python3 tools/stamp.py app

        Needs Python 3, pdftotext and the pdfplumber package.


LICENSE AND NO WARRANTY
-----------------------

Released under the MIT License; see LICENSE.txt.

Aerophone Companion is free software provided "as is", without warranty of any
kind, express or implied, including but not limited to the warranties of
merchantability, fitness for a particular purpose and non-infringement. In no
event shall the author be liable for any claim, damages or other liability,
whether in an action of contract, tort or otherwise, arising from, out of or
in connection with the software or the use or other dealings in the software.
This includes, without limitation, loss or corruption of scenes, tones,
settings or other data on your instrument or computer, and any damage to
equipment.

==============================================================================
Aerophone Companion is an independent, open source project and isn't
affiliated with or endorsed by Roland. Roland and Aerophone are trademarks of
Roland Corporation. Made with the help of Anthropic's Claude Code.
