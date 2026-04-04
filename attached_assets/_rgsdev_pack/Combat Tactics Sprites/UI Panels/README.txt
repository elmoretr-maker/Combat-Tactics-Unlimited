README — 9-Slice Panel Instructions
Thank you for downloading this UI pack. This panel uses a 9-slice layout so it can be resized without stretching the pixel art.
How It Works: The sprite is divided into 9 parts. Corners do not stretch, edges stretch in one direction, and the center fills the remaining space.
Slice Settings (important):
Left: 8 px
Right: 8 px
Top: 8 px
Bottom: 8 px

Unity Setup:
1. Select the sprite
2. Open Sprite Editor → Borders
3. Enter the slice values above
4. Set Sprite Mode to “Sliced”
5. Resize the sprite

Godot Setup:
1. Add a NinePatchRect node
2. Assign the sprite
3. Set all patch margins to 8 px
4. Resize the UI node

GameMaker Setup:
1. Open the sprite
2. Go to Nine Slice
3. Enter the border values
4. Use Sliced drawing mode

Testing: Resize the panel to a larger size (for example 300×150). If corners stay clean and un-distorted, the 9-slice is working correctly.

If you need help or custom UI, feel free to contact me on my Itch page.

