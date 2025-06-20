export const FRAGMENT_SHADER = `
varying vec2 vUvs;
uniform sampler2D earthMap;
uniform vec4 landFill;
uniform vec4 landStroke;
uniform float opacity;

void main() {
  vec4 src = texture2D(earthMap, vUvs);
  if (src.a < 0.5) discard;

  float t = 0.15;
  float d = distance(src.rgb, landFill.rgb);
  float w = fwidth(d);
  float edge = smoothstep(t - w, t + w, d);
  vec4 color = mix(landFill, landStroke, edge);
  
  // Apply opacity
  gl_FragColor = vec4(color.rgb, color.a * opacity);
}
`;
