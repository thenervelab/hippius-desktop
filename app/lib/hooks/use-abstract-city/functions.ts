import {
  createProgram,
  createShader,
  getCanvasToClipSpaceProjectionMatrix,
  resizeCanvasToDisplaySize,
  setQuadVertices,
} from "@/app/lib/utils";
import {
  VERTEX_SHADER,
  FRAGMENT_SHADER,
  COMPUTE_VERTEX_SHADER,
  COMPUTE_FRAGMENT_SHADER,
} from "./shaders";

// Function to create and set up a framebuffer with texture
const createFramebufferWithTexture = (
  gl: WebGLRenderingContext,
  width: number,
  height: number
) => {
  // Create and bind the framebuffer
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

  // Create a texture to render to
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);

  // Define texture parameters
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );

  // Attach the texture to the framebuffer
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0
  );

  // Check if framebuffer is complete
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Framebuffer not complete: ${status}`);
  }

  // Unbind the framebuffer to avoid accidentally rendering to it
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { framebuffer, texture };
};

export const initialise = async (canvas: HTMLCanvasElement) => {
  const gl = canvas.getContext("webgl2");

  if (!gl) throw new Error("Failed to initialize WebGL");

  // Create main program
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!fragmentShader) throw new Error("Failed to create fragment shader");

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  if (!vertexShader) throw new Error("Failed to create vertex shader");

  const program = createProgram(gl, vertexShader, fragmentShader);
  if (!program) throw new Error("Failed to create program");

  // Create noise program
  const noiseFragmentShader = createShader(
    gl,
    gl.FRAGMENT_SHADER,
    COMPUTE_FRAGMENT_SHADER
  );
  if (!noiseFragmentShader)
    throw new Error("Failed to create noise fragment shader");

  const noiseVertexShader = createShader(
    gl,
    gl.VERTEX_SHADER,
    COMPUTE_VERTEX_SHADER
  );
  if (!noiseVertexShader)
    throw new Error("Failed to create noise vertex shader");

  const noiseProgram = createProgram(
    gl,
    noiseVertexShader,
    noiseFragmentShader
  );
  if (!noiseProgram) throw new Error("Failed to create noise program");

  // Get uniform and attribute locations for main program
  const canvasProjectionMatrixUniformLocation = gl.getUniformLocation(
    program,
    "u_canvasProjectionMatrix"
  );

  const canvasResolutionUniformLocation = gl.getUniformLocation(
    program,
    "u_resolution"
  );

  const timeUniformLocation = gl.getUniformLocation(program, "u_time");
  const positionAttributeLocation = gl.getAttribLocation(program, "a_position");

  // Get texture sampler uniform location (assuming your main shader needs the noise texture)
  const noiseTextureUniformLocation = gl.getUniformLocation(program, "u_noise");

  // Get uniform and attribute locations for noise program
  const noiseCanvasProjectionMatrixUniformLocation = gl.getUniformLocation(
    noiseProgram,
    "u_canvasProjectionMatrix"
  );

  const noiseResolutionUniformLocation = gl.getUniformLocation(
    noiseProgram,
    "u_resolution"
  );

  const noisePositionAttributeLocation = gl.getAttribLocation(
    noiseProgram,
    "a_position"
  );

  // Create buffer for quad vertices
  const positionBuffer = gl.createBuffer();

  // Create framebuffer with texture
  let noiseFramebuffer: WebGLFramebuffer | null = null;
  let noiseTexture: WebGLTexture | null = null;

  return (time: number) => {
    // Resize canvas if needed
    resizeCanvasToDisplaySize(canvas);

    const width = canvas.width;
    const height = canvas.height;

    // Recreate framebuffer and texture if canvas size changes or on first run
    if (!noiseFramebuffer || !noiseTexture) {
      const fbSetup = createFramebufferWithTexture(gl, width, height);
      noiseFramebuffer = fbSetup.framebuffer;
      noiseTexture = fbSetup.texture;
    }

    // Setup projection matrix
    const canvasProjectionMatrix = getCanvasToClipSpaceProjectionMatrix(
      width,
      height
    );

    // STEP 1: Render noise to texture
    gl.bindFramebuffer(gl.FRAMEBUFFER, noiseFramebuffer);
    gl.viewport(0, 0, width, height);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(noiseProgram);

    gl.uniformMatrix3fv(
      noiseCanvasProjectionMatrixUniformLocation,
      false,
      canvasProjectionMatrix
    );

    gl.uniform2fv(noiseResolutionUniformLocation, [width, height]);

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    setQuadVertices(gl);

    gl.enableVertexAttribArray(noisePositionAttributeLocation);
    gl.vertexAttribPointer(
      noisePositionAttributeLocation,
      2,
      gl.FLOAT,
      false,
      0,
      0
    );

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // STEP 2: Render to canvas with the noise texture
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);

    gl.uniformMatrix3fv(
      canvasProjectionMatrixUniformLocation,
      false,
      canvasProjectionMatrix
    );

    gl.uniform2fv(canvasResolutionUniformLocation, [width, height]);
    gl.uniform1f(timeUniformLocation, time);

    // Bind the noise texture to texture unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
    // Set the sampler uniform to use texture unit 0
    if (noiseTextureUniformLocation) {
      gl.uniform1i(noiseTextureUniformLocation, 0);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    setQuadVertices(gl);

    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };
};
