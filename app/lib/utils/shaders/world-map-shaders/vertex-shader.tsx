export const VERTEX_SHADER = `
varying vec2 vUvs;
void main() {
  vUvs = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
}`;
