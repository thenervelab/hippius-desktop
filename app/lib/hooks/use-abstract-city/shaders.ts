// Vertex Shader
export const VERTEX_SHADER = `
    uniform mat3 u_canvasProjectionMatrix;
    attribute vec2 a_position;

    void main() {
        vec3 position = u_canvasProjectionMatrix * vec3(a_position, 1.0);
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }
`;

// Fragment Shader
export const FRAGMENT_SHADER = `
    precision mediump float;

    uniform vec2 u_resolution;
    uniform float u_time;
    uniform sampler2D u_noise;

    // Precompute constants
    const float SCALE_FACTOR = 0.32; // 0.005 * 64.0
    const float HEIGHT_SCALE = 8.0;
    const float EPSILON = 0.01;
    const float MAX_DISTANCE = 70.0;
    const int MAX_STEPS = 80;

    // Colors precomputed
    const vec4 BLUE = vec4(0.192, 0.404, 0.867, 1.0);
    const vec4 DARK_BLUE = vec4(0.185, 0.203, 0.467, 1.0);

    // No need for full 3D rotation when we only rotate around X
    vec3 rotateX(vec3 v, float angle) {
        float s = sin(angle);
        float c = cos(angle);
        return vec3(v.x, c * v.y + s * v.z, -s * v.y + c * v.z);
    }

 float map(vec3 p) {
        // Wrap coordinates to create infinite repetition
        vec2 gridCoord = floor(p.xz * SCALE_FACTOR);
        gridCoord = mod(gridCoord, 14.0); // Wrap every 64 units
        vec2 uv = gridCoord / 64.0;
        
        // Add ping-pong effect for smoother transitions
        uv = abs(fract(uv * 2.0) * 2.0 - 1.0);
        
        // Sample with mirrored repeat to prevent seams
        float h = texture2D(u_noise, uv).r;
        
        float height = p.y - HEIGHT_SCALE * h * h;
        return max(min(height, 0.2), p.y - HEIGHT_SCALE);
    }
                
    vec4 color(vec3 p) {
        float m = pow(p.y, -1.5); // Light Base
        return mix(DARK_BLUE, BLUE, m);
    }
                
    vec4 raymarch(vec3 ro, vec3 rd) {
    float t = 0.0;

    for (int i = 0; i < MAX_STEPS; i++) {
        vec3 p = ro + t * rd;
        float d = map(p); // Get distance to terrain surface
        
        if (d < EPSILON) return color(p); // If close enough, return color
        if (t > MAX_DISTANCE) break;      // If too far, stop searching

        t += d; // **Take the exact distance step (sphere tracing)**
    }

    return color(ro + t * rd);
}

    void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution.xy;
        vec2 vUvs = (gl_FragCoord.xy / u_resolution.xy) * 2.0 - 1.0;
        vUvs.x *= u_resolution.x / u_resolution.y;

        // Precompute camera position
        vec3 ro = vec3(10.0, 30.0, u_time * 10.0);
        
        // Precompute rotation once
        const float CAMERA_ANGLE = 5.95;
        vec3 rd = normalize(rotateX(vec3(vUvs, 1.4), CAMERA_ANGLE));
        
        gl_FragColor = raymarch(ro, rd);
        // gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
        // gl_FragColor = texture2D(u_noise, uv);
    }
`;

export const COMPUTE_VERTEX_SHADER = `
    uniform mat3 u_canvasProjectionMatrix;

    attribute vec2 a_position;
    
    void main() {
        vec3 position = u_canvasProjectionMatrix * vec3(a_position, 1.0);
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }
`;

export const COMPUTE_FRAGMENT_SHADER = `
    precision mediump float;

    uniform vec2 u_resolution;

    const vec2 HASH_CONSTANTS = vec2(12.9898, 4.1414);
    const float HASH_MULTIPLIER = 43758.5453;

    // Simple hash function for terrain height generation
    float hash(vec2 n) { 
        return fract(sin(dot(n, HASH_CONSTANTS)) * HASH_MULTIPLIER);
    }

    void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution;
        
        // Scale UVs to match terrain grid
        vec2 gridUV = floor(uv * 64.0) / 64.0; 
        
        // Generate height using hash function
        float height = hash(gridUV);
        
        // Store height in grayscale (0 = low, 1 = high)
        gl_FragColor = vec4(vec3(height), 1.0);
    }
`;
