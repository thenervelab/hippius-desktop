# Sign-in slide clips

`scenes.html` draws slides 2 to 4 (Encrypted on Your Device, Screen Recording,
Share & Track) in the same isometric style as slide 1, in light and dark. Each
loops in 8 seconds and starts and ends on the same frame.

To change one and re-render it:

1. Open `scenes.html?scene=enc|rec|share&theme=light|dark&t=3` in a browser to
   see one moment.
2. Render every frame (1620 x 911, 30 fps) with the browser-automation runner:
   `OUT=/tmp/frames FPS=30 node <browser.mjs> "file://$PWD/scenes.html?scene=enc&theme=light" --script render-frames.mjs`
3. Encode: `./encode.sh /tmp/frames ../../../public/assets/signin/2-light.gif`
   (slide 2 is `enc`, 3 is `rec`, 4 is `share`).

Keep each GIF under the existing clips' size; `app/components/auth/__tests__/swipeContent.test.ts`
fails above 4.5 MB. GIF only: video formats pick up OS player styling.
