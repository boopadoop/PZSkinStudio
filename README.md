# PZ Skin Studio

A skin maker's preview and pixel editor for Project Zomboid character models. Pick a model, see any
skin on it in 3D, paint on it, and pass skins around as single files. It runs in your browser from one HTML
file, with nothing to install and nothing uploaded anywhere.

It only makes skins, not mods, and it never changes the game's or a mod's own files. The models are
there to show what a skin will look like. The game's human bodies are included as an example, and
you add any other models yourself from the mods you have, as described below.

Thanks to The Indie Stone for creating Project Zomboid (https://projectzomboid.com/), which made this possible. This is an unofficial fan production for non-commercial purposes made under the Indie Stone Terms (https://projectzomboid.com/blog/support/terms-conditions/).

## Getting started

1. **Download the studio.** Click the green **Code** button on this page, then **Download ZIP**, and
   unzip it somewhere you can find it.
2. **Add the mods you want to make skins for.** The game's human bodies are already there. For
   anything else, copy a mod's whole folder into the `models` folder.
3. **Open `PZSkinStudio.html`** in Firefox, Chrome or Edge. Nothing needs installing.
4. **Click Open folder** and pick the folder that page is in. You only do this once: the studio keeps
   its own copy of what it read in your browser, so next time it opens by itself, with no questions.

## Adding models

Steam keeps the mods you've subscribed to here, under each mod's Workshop number:

    steamapps/workshop/content/108600/<Workshop number>/mods/<mod name>

Copy that whole `<mod name>` folder into `models`, keeping everything inside it as it is. For example:

    steamapps/workshop/content/108600/3778832646/mods/XochisCustomBFT  ->  models/XochisCustomBFT

You can add as many mods as you like. Click **Rescan** after adding or removing any, since the studio
doesn't look at the folder again until you do.

- **Any mod with FBX character models works.** Anthro Survivors species packs are listed under their
  species, and models from other mods are listed under **Not in a species list**. Models in the older
  `.x` format don't show up.
- **A single model works too.** Put a `.fbx` anywhere in `models`, with a `.png` of the same name
  beside it.
- **Please don't share mods you've copied.** They belong to their authors, which is why this project
  doesn't include any. Everyone adds their own from their own Workshop folder.

## Making a skin

1. Pick a character on the left, and Male or Female on the right.
2. Click **Download texture** for a skin to paint over, and **Download UV guide** for an overlay
   showing where each polygon sits. It's the same size as the texture, with white lines on a
   transparent background, so use it as a layer on top in your paint program.
3. Paint, then save a PNG. Skins in the pack are 256 × 256; keep yours square. See
   [Saving a skin so the colours come out right](#saving-a-skin-so-the-colours-come-out-right).
4. Click **Import skin** or drag the PNG onto the page. It goes on the model you have selected.
   In Chrome and Edge the preview then follows the file, so each save in your paint program shows
   up by itself within a second or so.
5. Type a name and your name, then click **Export skin**. Send the `.skin.zip` it makes.

Importing a `.skin.zip` takes you to the model it was made for, and it's there next time you open
the studio. Anything in `skins` is read when the folder opens. A Rescan makes the studio match the
folder exactly, so keep any skin you want to stay in `skins`.

## Painting in the studio

Pick a model and skin, then click **Paint**. The texture opens in the middle, the colours and tools
are on the left, and the model moves to the right, updating as you paint. Drag it to turn it, right-drag to move it and scroll to zoom, and
**Enlarge preview** makes it bigger.

- **Tools:** Paint, Erase, Pick colour, and Move for dragging the texture around. Erasing makes the
  texture transparent.
- **Brushes:** Square for exact pixels, Round, and Soft for smooth edges. Set the size with the slider
  or its − and + buttons.
- **Mirror X and Mirror Y:** repeat strokes across the centre of the texture, shown by a dashed line,
  for painting and erasing alike. Turn on both for four copies. Mirror X goes left to right, which
  mirrors the character's body on nearly every model, so paint one side and get the other free.
  Mirror Y goes top to bottom, which suits patterns, since a model's top and bottom halves don't
  match. It's the texture that's mirrored, so check the model around the edges of each area.
- **Colours:** the colour box, the palette, and your recent colours are on the left.
- **Guides:** Pixel grid and UV lines are only drawn on screen and never end up in the texture. The
  grid appears from 300% zoom.
- **Zoom:** Zoom −, Zoom + and Fit.
- **Undo and redo** work for everything since you opened the texture.
- **Shortcuts:** every button has one too, listed under the buttons. Scrolling also zooms, and holding
  Alt while you click picks a colour with any tool.
- **Save as** saves a PNG and adds the skin to Your skins on this model, where **Export skin** makes
  the `.skin.zip`. The texture you started from isn't changed.

The list on the left comes back when you click **Close paint**. A skin you've only saved here isn't
in your `skins` folder, so a Rescan drops it. Export it and keep the zip there to be safe.

## Saving a skin so the colours come out right

The game shows the raw numbers in your PNG and ignores any colour profile embedded in it. So does the
studio's 3D view, on purpose, so that what you see here is what the game will do. A file that's
tagged with a different colour space looks right in an image viewer, which applies the tag, and wrong
here and in the game.

Save skins as:

- **PNG, 8 bits per channel, RGBA**
- **sRGB**, with no HDR or wide-gamut profile. An embedded sRGB profile is fine.
- **Square**, such as 256 × 256

The usual culprit is HDR. A file saved as HDR (Rec. 2100 PQ) stores white at about half brightness,
so a white character turns into a dull grey one.

**The studio fixes this for you on import.** A skin in the wrong colour format is converted to sRGB,
and a yellow note says so. Exporting or downloading it gives you the fixed copy. It's still best to
export as 8-bit sRGB with HDR turned off, so your own files are right too. Use Convert rather than
Assign if your program offers both: Assign keeps the wrong numbers and only changes the label.

To fix HDR skins already on disk, without opening the studio:

    node tools/fix-skin-colours.mjs <.png, .skin.zip or folder>

The old file is kept in an `originals` folder beside it.

In the game, even a correct skin comes out around 15% darker than the file in full daylight, and
darker still in shade or at night. Turn off **Lighting** in the toolbar to see the plain colours.

## Human skins

The `VanillaHumans` pack in `models` holds the game's own male and female bodies, listed under
**Human Skins**, and shows how a pack is laid out. If a game update changes the bodies, this makes the
pack again from your own game, using Node.js. Click **Rescan** afterwards.

    node tools/import-vanilla-humans.mjs "<path to ProjectZomboid/media>"

Two things are different from other skins:

- **Leave the transparent areas transparent.** The body has a hidden dress-shaped surface between
  the legs, which stays invisible because the skins are clear there. Paint over those areas and the
  character gets a long dress, here and in the game.
- **A skin only fits the body it's painted on.** Male and female have different layouts, so make one
  of each to cover both.

## If a model loads on its side

Models that say which way up they go are stood up automatically. If one still loads the wrong way
round, use **Tilt**, **Turn** and **Roll** in the toolbar: each is a quarter turn, and the model stays
centred so the camera orbits around it. Each model remembers its setting, and **Reset** clears it.
This only changes the preview, not the model, the skin or how it looks in the game.

## Which skins fit which models

A skin fits every model with the same UV layout, whatever the character's name. Selecting a model
lists all the skins that fit, so 12 of the pack's characters share one set of skins and most others
have their own.

**Male and female can differ.** 33 of the pack's 280 characters have different layouts per body.
The panel says so in yellow when that's the case, and a skin then only fits the body it was painted
for. `skin.json` lists the bodies a skin fits under `fitsBodies`. A skin mod can get around this by
giving both genders the same clothing item, so they wear the one model the skin was painted for.

## What's in a .skin.zip

- `skin.png`: the texture, exactly as painted.
- `skin.json`: its name and author, and what it was made for. This is what a skin mod needs:

| Field | What it is |
|---|---|
| `model` | The model this skin was painted on |
| `models` | The model for each body the skin fits |
| `pack` | The mod id to put in `require=` |
| `clothingItem` | The pack's own clothing item for this model |
| `groupName`, `characterName` | Where the model sits in the species list |
| `fitsBodies` | Which bodies this texture fits |
| `uvLayout` | The layout fingerprint that links the skin to its models |

A skin mod only needs the texture: its clothing XML can point at the pack's model, as long as the
mod requires the pack. Each skin also needs a `<item>_Deceased` copy of its clothing item, because
Anthro Survivors swaps to that when the character dies. See `tools/gametest/make_mod.mjs` for a
working example.

## Browsers

| | Chrome, Edge | Firefox |
|---|---|---|
| Preview, import, export | Yes | Yes |
| Remembers everything between visits | Yes | Yes |
| Preview follows your saves | Yes | No, import again |
| Imported zips also saved to `skins` | Yes | No, move them there yourself |
| Rescan | Asks once to read the folder | Pick the folder again |

If Chrome refuses a folder because it "contains system files" (Program Files is one), copy the
folder somewhere else.

## Working on the studio itself

Only needed to change it, not to use it. `src/` holds the code; `npm install` then `npm run build`
writes `PZSkinStudio.html`, and `npm test` runs the page in headless Chrome against `models/`.
The tests expect the Xochi's Customs pack and the human bodies in `models`. `tools/gametest/` compares
the preview with the real game, and needs a local test setup that isn't part of this project.

## Licence

The studio's code is under the MIT licence: see `LICENSE`. It includes three.js and fflate, also MIT,
and their notices are at the top of `PZSkinStudio.html`.

**The MIT licence doesn't cover `models/VanillaHumans`.** Those are The Indie Stone's own models and
textures, included under the Project Zomboid terms. They can't be used commercially, and they keep
the credit at the top of this page.
