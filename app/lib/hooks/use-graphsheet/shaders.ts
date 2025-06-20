export const VERTEX_SHADER = `
    uniform mat3 u_canvasProjectionMatrix;

    attribute vec2 a_position;

    void main() {
        vec3 position = u_canvasProjectionMatrix * vec3(a_position, 1.0);
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }
`;

export const FRAGMENT_SHADER = `
    precision mediump float;

    uniform vec2 u_resolution;
    uniform vec4 u_majorCellLineColor;
    uniform vec4 u_minorCellLineColor;
    uniform float u_majorCellLineWidth;
    uniform float u_minorCellLineWidth;
    uniform float u_majorCellDim;
    uniform float u_minorCellDim;

    vec3 red = vec3(1.0, 0.0, 0.0);
    vec3 green = vec3(0.0, 1.0, 0.0);

    float inverseLerp(float v, float minValue, float maxValue) {
        return (v - minValue) / (maxValue - minValue);
    }

    float remap(float v, float inMin, float inMax, float outMin, float outMax) {
        float t = inverseLerp(v, inMin, inMax);
        return mix(outMin, outMax, t);
    }

    vec4 drawGrid(vec4 colour, vec4 lineColour, float cellSpacing, float lineWidth, vec2 vUvs) {
        vec2 center = vUvs - 0.5;
        vec2 cellPosition = abs(fract(center * u_resolution / vec2(cellSpacing)) - 0.5);
        float distToEdge = (0.5 - max(cellPosition.x, cellPosition.y)) * cellSpacing;
        float lines = smoothstep(0.0, lineWidth, distToEdge);

        return mix(lineColour, colour, lines);
    }



    void main() {
        vec2 vUvs = gl_FragCoord.xy / u_resolution.xy;

        vec2 pixelCoords = (vUvs - 0.5) * u_resolution;
        
        vec4 colour = vec4(0.0);

        colour = drawGrid(colour, u_minorCellLineColor, u_minorCellDim, u_minorCellLineWidth, vUvs);

        colour = drawGrid(colour, u_majorCellLineColor, u_majorCellDim, u_majorCellLineWidth, vUvs);

        gl_FragColor = colour;
    }
`;
