# Sign-in slide clips

`scenes.html` draws the sign-in clips in one isometric style, each in light
and dark: `net` (slide 1, Distributed Storage), `enc` (slide 2, Encrypted on
Your Device), `rec` (slide 3, Screen Recording) and `share` (Share & Track,
hidden for now). Each loops in 8 seconds and starts and ends on the same
frame. The referral clip (slide 5) came from design and is not drawn here.

The scene itself never moves: depth comes from the isometric drawing, soft
floor shadows and light sweeps, and only the elements' own animation moves
(shards, arcs, cards, glows). A camera drift and floating bobs of a few
pixels used to sit on top; snapped to whole pixels they read as the picture
swaying and objects shaking, so do not add them back. Keep any new motion
large enough to read as movement, or leave it out.

To change one and re-render it:

1. Open `scenes.html?scene=net|enc|rec|share&theme=light|dark&t=3` in a
   browser to see one moment.
2. Render every frame (30 fps, drawn at twice 1620 x 911; `SS=1` for a quick
   draft) with the browser-automation runner:
   `OUT=/tmp/frames FPS=30 node <browser.mjs> "file://$PWD/scenes.html?scene=enc&theme=light" --script render-frames.mjs`
3. Encode: `./encode.sh /tmp/frames ../../../public/assets/signin/2-light.gif`
   (averages the frames down to 1620 x 911, one 128-colour palette for the
   whole clip, no dithering; pass a 4th argument of 96 if a clip is over
   about 1.5 MB).

Keep each GIF near 1.5 MB or under; `app/components/auth/__tests__/swipeContent.test.ts`
fails above 4.5 MB. GIF only: video formats pick up OS player styling.

`clips/` holds the Share & Track clips while that slide is hidden, outside
`public/` so the app does not ship them. See `SHARE_TRACK_SLIDE_ENABLED` in
`app/components/auth/SwipeContent.tsx` for how to bring it back.
