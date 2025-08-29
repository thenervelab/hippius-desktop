export function getNiceTicksAlways(min: number, max: number, tickCount = 5) {
  min = 0;
  if (max === 0 || Math.abs(max - min) < 1e-6) {
    max = min + 0.0001;
  }

  max = max * 1.2;

  const rawStep = (max - min) / (tickCount - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  let niceStep = magnitude;

  if (rawStep / niceStep > 5) niceStep *= 5;
  else if (rawStep / niceStep > 2) niceStep *= 2;

  const lastTick = Math.ceil(max / niceStep) * niceStep;
  const nTicks = Math.round((lastTick - min) / niceStep) + 1;

  return Array.from(
    { length: nTicks },
    (_, i) => +(min + i * niceStep).toFixed(6)
  );
}
