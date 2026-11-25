# Sign-in slide clips

`scenes.html` draws the sign-in clips in one isometric style, each in light
and dark: `net` (slide 1, Distributed Storage), `enc` (slide 2, Encrypted on
Your Device), `rec` (slide 3, Screen Recording) and `share` (Share & Track,
hidden for now). Each loops in 8 seconds and starts and ends on the same
frame. The referral clip (slide 5) came from design and is not drawn here.

Depth comes from three parallax layers that drift on the loop, objects that
bob in z, soft floor shadows and light sweeps. Drift and bobbing snap to whole
pixels, so a frame only changes where something actually moved a pixel; that
is what keeps a clip with constant motion near 1.3 MB.

To change one and re-render it:

1. Open `scenes.html?scene=net|enc|rec|share&theme=light|dark&t=3` in a
   browser to see one moment. `&drift=0` turns the drift off.
2. Render every frame (1620 x 911, 30 fps) with the browser-automation runner:
   `OUT=/tmp/frames FPS=30 node <browser.mjs> "file://$PWD/scenes.html?scene=enc&theme=light" --script render-frames.mjs`
3. Encode: `./encode.sh /tmp/frames ../../../public/assets/signin/2-light.gif`
   (64 colours, no dithering; pass a 4th argument of 48 if a clip is over
   about 1.5 MB).

Keep each GIF near 1.5 MB or under; `app/components/auth/__tests__/swipeContent.test.ts`
fails above 4.5 MB. GIF only: video formats pick up OS player styling.

`clips/` holds the Share & Track clips while that slide is hidden, outside
`public/` so the app does not ship them. See `SHARE_TRACK_SLIDE_ENABLED` in
`app/components/auth/SwipeContent.tsx` for how to bring it back.
