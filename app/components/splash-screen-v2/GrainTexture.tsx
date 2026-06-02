/**
 * Subtle film-grain overlay used behind the splash loader. Two stacked layers
 * of the same noise texture at different opacities/blend modes give the matte,
 * printed look from the loader mockup without shipping a second heavy asset.
 *
 * Sits at z-[9999] inside the splash container — above the loader content but
 * below the PixelateTransition (z-[10000]) so the dissolve still reads cleanly.
 */
function GrainTexture() {
  return (
    <div className="absolute inset-0 w-full h-full z-[9999] pointer-events-none select-none">
      <div
        style={{
          backgroundImage: "url(/images/grain/grain-l1.webp)",
          backgroundSize: "400px 270px",
          backgroundPosition: "top",
          backgroundRepeat: "repeat",
          opacity: 0.14,
          mixBlendMode: "soft-light",
        }}
        className="absolute inset-0 w-full h-full"
      />
      <div
        style={{
          backgroundImage: "url(/images/grain/grain-l1.webp)",
          backgroundSize: "400px 270px",
          backgroundPosition: "top",
          backgroundRepeat: "repeat",
          opacity: 0.05,
        }}
        className="absolute inset-0 w-full h-full"
      />
    </div>
  );
}

export default GrainTexture;
