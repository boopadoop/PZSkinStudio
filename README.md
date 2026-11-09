# PZ Skin Studio

A skin maker's preview and pixel editor for Project Zomboid character models. Pick a model, see any
skin on it in 3D, paint on it, and pass skins around as single files. It runs in your browser from one HTML
file, with nothing to install and nothing uploaded anywhere.

It only makes skins, not mods, and it never changes the game's or a mod's own files. The models are
there to show what a skin will look like. The game's human bodies are included as an example, and
you add any other models yourself from the mods you have, as described below.

It isn't only for the game: any FBX model with a UV map can be painted, including ones made of
several objects. See [Any 3D model](#any-3d-model).

Thanks to The Indie Stone for creating Project Zomboid (https://projectzomboid.com/), which made this possible. This is an unofficial fan production for non-commercial purposes made under the Indie Stone Terms (https://projectzomboid.com/blog/support/terms-conditions/).

## Getting started

1. **Download the studio.** Click the green **Code** button on this page, then **Download ZIP**, and
   unzip it somewhere you can find it.
2. **Add the mods you want to make skins for.** The game's human bodies are already there. For
   anything else, copy a mod's whole folder into the `models` folder.
3. **Start the studio:**
   - **On Linux, double-click `PZ Skin Studio`.** It opens the studio in a window of its own and
     reads its folder by itself. To have it in your applications menu too, run
     `"./PZ Skin Studio" --install` once from the studio folder (`--uninstall` takes it out).
   - **Anywhere else, open `PZSkinStudio.html`** in Chrome or Edge, click **Open folder** and pick
     the folder that page is in. You only do this once: the studio keeps its own copy of what it
     read in your browser, so next time it opens by itself, with no questions.

**How the program works.** `PZ Skin Studio` runs `start-studio.py`, a small helper that serves the
studio to your own computer only, and opens it in Chrome, Edge or Chromium as an app: a plain window
with no tabs or address bar, and a browser profile of its own, so it doesn't mix with your
browsing. Closing the window stops the helper. With none of those browsers it uses Firefox. It needs
Python 3, which Linux nearly always has. The first start reads the models in once.

**Firefox and the plain page.** Firefox can't save into a folder from a page, so with
`PZSkinStudio.html` opened in Firefox your paintings go to Downloads. Use the program instead, or on
Windows and Mac run `start-studio.py` ([Python 3](https://www.python.org/downloads/); double-click
it, or `py start-studio.py`; add `--app` for the app window). Started either way, paintings go in the
studio's `paint history` folder and imported skins in `skins`.

## Adding models

Steam keeps the mods you've subscribed to here, under each mod's Workshop number:

    steamapps/workshop/content/108600/<Workshop number>/mods/<mod name>

Copy that whole `<mod name>` folder into `models`, keeping everything inside it as it is. For example:

    steamapps/workshop/content/108600/3778832646/mods/XochisCustomBFT  ->  models/XochisCustomBFT

You can add as many mods as you like. Click **Rescan** after adding or removing any, since the studio
doesn't look at the folder again until you do.

- **Any mod with FBX character models works.** Anthro Survivors species packs are listed under their
  species, and models from other mods are listed under **Not in a species list**. A clothing item
  no species uses, on a model a species does use, is listed with that species: Anthro Survivors'
  unused Racoon item appears under Racoon, next to Common and Spiffy, which wear the same model. Models in the older
  `.x` format don't show up.
- **A single model works too.** Put a `.fbx` anywhere in `models`, with a `.png` of the same name
  beside it if it has a texture. For a model you made yourself, see
  [Your own models](#your-own-models).
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

Importing a `.skin.zip` (with **Import skin**, or by dragging it onto the page) takes you to the
model it was made for, and the object it was painted on if the model has several, and it's there
next time you open the studio. That's also how to bring back a skin you exported earlier.

Opening the folder and **Rescan** read every zip in `skins`, and every `.skin.zip` anywhere else in
the folder too, such as one left beside the models, so skins in the folder are listed with no
importing. A Rescan makes the studio match the folder exactly, so keep any skin you want to stay
somewhere in it, ideally `skins`.

## Painting in the studio

Pick a model and skin, then click **Paint**. The texture opens in the middle, the colours and tools
are on the left, and the model moves to the right, updating as you paint. Drag it to turn it, right-drag to move it and scroll to zoom, and
**Enlarge preview** makes it bigger.

- **Tools:** Paint, Erase, Fill, Smudge, Pick colour, and Move for dragging the texture around.
  Erasing makes the texture transparent.
- **Fill:** click to fill the connected area of similar colour. While Fill is selected, the slider
  sets its Tolerance: raise it to take in soft edges, lower it to stay inside a colour. Fill follows
  colours, not UV islands, so if the same colour runs between two areas it fills both.
- **Smudge:** drag to smear colours, using the brush and size you've picked.
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
- **Texture size**, beside the preview, sets the texture from 16 × 16 to 2048 × 2048, for anything
  from tiny pixel art to a detailed model. Growing keeps each painted pixel sharp, shrinking blends
  them, and Undo takes it back. A model with no texture yet starts at the size you last chose for it.
- **Show the brush on the model**, under the preview, outlines the brush on the model as well as on
  the texture, mirrored copies included, so you can see where a stroke will land.
- **Paint on the model**, under the preview, lets you paint straight onto the 3D model: press on the
  model to paint, and the strokes land on the texture; press beside the model to turn it as usual.
  Every tool works there except Move. Where a stroke crosses a seam to another part of the texture,
  the brush lifts instead of drawing a line across the texture. On a model of several objects it
  works on one object at a time, so a messy UV map can't spread a stroke over them all: pick the
  object before opening Paint.
- **Hide the other objects**, on a model of several, hides everything but the object you're
  painting from the preview.
- **Shortcuts:** every button has one too, listed under the buttons. Scrolling also zooms, and holding
  Alt while you click picks a colour with any tool.
- **Save as** saves a PNG in the studio's `paint history` folder and adds the skin to Your skins on
  this model, where **Export skin** makes the `.skin.zip`. Every save is kept: saving a changed
  picture under the same name adds `Name (2).png`, `Name (3).png` and so on, and saving the same
  picture twice adds nothing. The texture you started from isn't changed. Chrome and Edge ask once
  for permission to change the folder. In Firefox this needs the `PZ Skin Studio` program or
  `start-studio.py` (see [Getting started](#getting-started)); otherwise it saves to Downloads.

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

## Your own models

The studio reads a model the way the game does, so a model made at home shows what the game would
really draw, and the panel under the model's name says in yellow what needs fixing and how. The
pack's own models pass every check, so these are the things that trip up a model fresh out of Blender:

- **Several objects in one file.** The game draws only one: the first with bones, or the first of
  all. Pick **As the game draws it** under **Show and paint** to see just that one, with the rest in
  see-through grey. Join them into one object (select all, Ctrl+J) before exporting.
- **Several materials.** The game splits a model by material and draws only the first part, which
  **As the game draws it** shows. A skin is one picture, so give the model one material.
- **A skeleton of its own.** The game matches a model's bones to the character's by name, and its
  bones are all called Bip01_something, so a model rigged to its own armature won't follow the
  character.
- **A UV map that isn't ready.** Faces squashed flat (never unwrapped), parts lying on top of each
  other, parts outside the texture square, or a layout so small the skin would look blocky. Unwrap
  it (Edit Mode, select all, U, Smart UV Project, or mark seams and Unwrap), then UV, Pack Islands.
- **The unwrap in a second UV map.** The game only reads the first one. The panel names the one that
  looks right; delete the others so it comes first.
- **No bones.** Painting works, but the game puts a model on a character through its bones, so it
  has to be rigged to the game's skeleton before it can be worn.
- **Text (ASCII) FBX.** The studio reads binary FBX, which is what Blender always writes.

Two things help with any model:

- **Test pattern**, under **Check the UV map**, is a grid of labelled squares that fits every model.
  Squares that come out stretched show a stretched UV map, letters that read backwards show a
  mirrored part, and the same label in two places shows parts lying on top of each other. It stays
  on as you move between models.
- **Outlines only**, under the texture, draws just the edges where the UV map is cut. On a detailed
  model every polygon edge turns the texture solid white, and the outline is the readable picture. It
  applies to the UV guide and to Paint's UV lines too.

A model that isn't a typical character size is framed by itself, so the whole of it is in view.

Export from Blender as **FBX**, with the mesh and its armature, one object and one material. After
changing a model, click **Rescan**.

## Any 3D model

Put any FBX file straight in `models` (not inside a mod's `media` folder) and the studio treats it as
a general 3D model: the game's checks are off, there's no Male or Female, and it opens whole. The UV
checks, the test pattern, Paint and Export all work the same.

**Models made of several objects** get a **Show and paint** list under the model's name: the whole
model, or any one object, with the others in see-through grey. You can also click an object in the
3D view to pick it, and click it again to go back to the whole model. Paint works on whatever is
picked. Every object reads its own UV map from the same texture, so a skin painted on one object is
offered on the whole model and on the others too: paint the body, then pick the jacket and carry on.

That only works if the objects share the texture square. Unwrapped one at a time in Blender, each
object fills the whole square, so on one texture they lie on top of each other; the studio says so
when that's the case. Either paint one object at a time, or in Blender select all the objects, then
Edit Mode, select all, U, Smart UV Project: unwrapped together, they share the square.

**Colour by object**, under the texture, gives each object's UV lines a colour of its own when
several are shown, with a list of which colour is which; click a name to pick that object. The UV
guide and Paint's UV lines use the same colours.

**A texture per object.** A general model of several objects can also give each object a texture of
its own, the way Blender gives each object its own material: click **One per object** under **Show
and paint**. Then pick an object (from the list or by clicking it), and choose a skin for it or
paint it; each object keeps its own, and the whole model shows them all at once. Each object's
texture can be a different size. **One texture** goes back to a single texture for everything. The
studio remembers which skin each object wears.

Exporting a skin made on one object records which object it was (`view` and `viewName` in
`skin.json`), and importing it opens that object again.

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
| `view`, `viewName` | For a model of several objects, which one it was painted on (or the whole model) |

A skin mod only needs the texture: its clothing XML can point at the pack's model, as long as the
mod requires the pack. Each skin also needs a `<item>_Deceased` copy of its clothing item, because
Anthro Survivors swaps to that when the character dies. See `tools/gametest/make_mod.mjs` for a
working example.

## Browsers

| | Chrome, Edge | Firefox | The program, or `start-studio.py` |
|---|---|---|---|
| Preview, import, export | Yes | Yes | Yes |
| Remembers everything between visits | Yes | Yes | Yes |
| Paintings saved in `paint history` | Yes | No, in Downloads | Yes |
| Imported zips also saved to `skins` | Yes | No, move them there yourself | Yes |
| Preview follows your saves | Yes | No, import again | No, import again |
| Rescan | Asks once to read the folder | Pick the folder again | By itself |

`start-studio.py` serves the studio folder to this computer only, at `http://127.0.0.1:47819`, and
only writes into `skins` and `paint history`. Other web pages can't use it. The app window keeps its
library in its own browser profile (in `~/.local/share/PZSkinStudio` on Linux), so the first start
reads the models in once.

If Chrome refuses a folder because it "contains system files" (Program Files is one), copy the
folder somewhere else.

## Working on the studio itself

Only needed to change it, not to use it. `src/` holds the code; `npm install` then `npm run build`
writes `PZSkinStudio.html`, and `npm test` runs the page in headless Chrome and Firefox against
`models/`. `sh tools/build-launcher.sh` builds the `PZ Skin Studio` program from
`launcher/launcher.c` (with gcc) and its icon from `launcher/icon.svg`. `tools/make-test-models.mjs` writes models with each of the problems in
[Your own models](#your-own-models), the way Blender lays them out, for `tools/test-models.mjs`.
The tests expect the Xochi's Customs pack and the human bodies in `models`. `tools/gametest/` compares
the preview with the real game, and needs a local test setup that isn't part of this project.

## Licence

The studio's code is under the MIT licence: see `LICENSE`. It includes three.js and fflate, also MIT,
and their notices are at the top of `PZSkinStudio.html`.

**The MIT licence doesn't cover `models/VanillaHumans`.** Those are The Indie Stone's own models and
textures, included under the Project Zomboid terms. They can't be used commercially, and they keep
the credit at the top of this page.
